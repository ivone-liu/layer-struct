import { createReadStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { OpenAiCompatibleClient } from "./ai/openAiCompatibleClient.js";
import { loadConfig } from "./config/env.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { formatUserFacingError } from "./orchestrator/runTracker.js";
import { DocumentService } from "./services/documentService.js";
import { MemoryService } from "./services/memoryService.js";
import { LanceVectorStore } from "./storage/lanceVectorStore.js";
import { SqliteStore } from "./storage/sqliteStore.js";
import type { ChatStreamEvent, StoredDocumentInput } from "./types.js";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });

const sqlite = new SqliteStore(config.sqlitePath);
const ai = new OpenAiCompatibleClient(config.ai);
const vectors = new LanceVectorStore(config.lanceDbUri, config.lanceDbDocumentTable);
const documents = new DocumentService(sqlite, vectors, ai, config);
const memory = new MemoryService(sqlite, vectors, ai, config);
const orchestrator = new Orchestrator(config, sqlite, documents, ai, memory);

const publicDir = path.resolve(process.cwd(), "public");

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      return notFound(response);
    }

    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, {
        ok: true,
        ai: {
          chatConfigured: ai.canChat(config.ai.chatModel),
          routerConfigured: ai.canChat(config.ai.routerModel),
          embeddingConfigured: ai.canEmbed()
        },
        storage: {
          sqlitePath: config.sqlitePath,
          lanceDbUri: config.lanceDbUri,
          lanceDbTable: config.lanceDbTable,
          lanceDbDocumentTable: config.lanceDbDocumentTable,
          lanceDbMemoryTable: config.lanceDbMemoryTable,
          lanceDbSessionTable: config.lanceDbSessionTable,
          lanceDbCapabilityTable: config.lanceDbCapabilityTable
        }
      });
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody<{ message?: string; sessionId?: string; projectId?: string; userId?: string }>(request);
      if (!body.message?.trim()) {
        return json(response, 400, { error: "message is required" });
      }

      const result = await orchestrator.chat({
        message: body.message,
        sessionId: body.sessionId,
        projectId: body.projectId,
        userId: body.userId
      });
      return json(response, 200, result);
    }

    if (request.method === "POST" && url.pathname === "/api/chat/stream") {
      const body = await readJsonBody<{ message?: string; sessionId?: string; projectId?: string; userId?: string }>(request);
      if (!body.message?.trim()) {
        return json(response, 400, { error: "message is required" });
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });

      let streamErrorEmitted = false;
      try {
        await orchestrator.chatStream(
          {
            message: body.message,
            sessionId: body.sessionId,
            projectId: body.projectId,
            userId: body.userId
          },
          {
            onEvent: (event) => {
              if (event.type === "error") {
                streamErrorEmitted = true;
              }
              writeSse(response, event);
            }
          }
        );
      } catch (error) {
        if (!streamErrorEmitted && !response.writableEnded) {
          const friendlyMessage = formatUserFacingError(error);
          writeSse(response, {
            type: "error",
            error: friendlyMessage,
            friendlyMessage,
            debug: { rawError: error instanceof Error ? error.message : String(error) }
          });
        }
      } finally {
        response.end();
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/documents") {
      const body = await readJsonBody<Partial<StoredDocumentInput>>(request);
      if (!body.content?.trim()) {
        return json(response, 400, { error: "content is required" });
      }

      const result = await orchestrator.writeDocument({
        title: body.title?.trim() || "未命名资料",
        content: body.content,
        source: body.source,
        projectId: body.projectId || config.defaultProjectId,
        metadata: body.metadata
      });
      return json(response, 200, result);
    }

    if (request.method === "POST" && url.pathname === "/api/search") {
      const body = await readJsonBody<{ query?: string; projectId?: string; limit?: number; skillId?: string }>(request);
      if (!body.query?.trim()) {
        return json(response, 400, { error: "query is required" });
      }

      const result = await documents.search({
        query: body.query,
        projectId: body.projectId || config.defaultProjectId,
        limit: body.limit,
        skillId: body.skillId
      });
      return json(response, 200, result);
    }

    if (request.method === "GET") {
      return serveStatic(url.pathname, response);
    }

    return notFound(response);
  } catch (error) {
    return json(response, 500, {
      error: error instanceof Error ? error.message : "unknown error"
    });
  }
});

server.listen(config.port, () => {
  console.log(`AI Orchestrator listening on http://localhost:${config.port}`);
});

const memoryDecayIntervalMs = Math.max(1, config.memory.decayIntervalHours) * 60 * 60 * 1000;
const memoryDecayTimer = setTimeout(() => {
  const interval = setInterval(() => {
    memory.decay().catch((error) => console.warn("memory decay failed", error));
  }, memoryDecayIntervalMs);
  interval.unref?.();
  memory.decay().catch((error) => console.warn("memory decay failed", error));
}, 60000);
memoryDecayTimer.unref?.();

process.on("SIGINT", () => {
  clearTimeout(memoryDecayTimer);
  sqlite.close();
  server.close();
});

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

function writeSse(response: ServerResponse, event: ChatStreamEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body, null, 2));
}

function serveStatic(urlPath: string, response: ServerResponse): void {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.resolve(publicDir, `.${safePath}`);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    return notFound(response);
  }

  response.writeHead(200, {
    "content-type": contentType(filePath)
  });
  createReadStream(filePath).pipe(response);
}

function notFound(response: ServerResponse): void {
  json(response, 404, { error: "not found" });
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  return "application/octet-stream";
}
