import { createReadStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { OpenAiCompatibleClient } from "./ai/openAiCompatibleClient.js";
import { loadConfig } from "./config/env.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { formatUserFacingError } from "./orchestrator/runTracker.js";
import { DocumentService } from "./services/documentService.js";
import { MemoryService } from "./services/memoryService.js";
import { ConversationService } from "./services/conversationService.js";
import { CollectedContentWorkflow } from "./services/collectedContentWorkflow.js";
import { InteractionLogger } from "./services/interactionLogger.js";
import { LanceVectorStore } from "./storage/lanceVectorStore.js";
import { SqliteStore } from "./storage/sqliteStore.js";
import type { ChatStreamEvent, DocumentTagSuggestion, StoredDocumentInput, StoredDocumentUpdateInput } from "./types.js";
import { McpClientManager } from "./mcp/clientManager.js";
import { createMcpServerFromUrl, readMcpRegistry, removeMcpServer, replaceMcpServerTools, setMcpServerEnabled, upsertMcpServer } from "./mcp/registry.js";
import type { McpServerDefinition, McpUrlServerInput } from "./mcp/types.js";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });

const sqlite = new SqliteStore(config.sqlitePath);
const ai = new OpenAiCompatibleClient(config.ai);
const vectors = new LanceVectorStore(config.lanceDbUri, config.lanceDbDocumentTable);
const documents = new DocumentService(sqlite, vectors, ai, config);
const memory = new MemoryService(sqlite, vectors, ai, config);
const conversations = new ConversationService(sqlite);
const collectedWorkflow = new CollectedContentWorkflow(sqlite, documents, memory);
const orchestrator = new Orchestrator(config, sqlite, documents, ai, memory);
const mcp = new McpClientManager();
const interactionLogger = new InteractionLogger(config.log);

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
          requirementMemoryConfigured: ai.canChat(config.ai.requirementMemoryModel),
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
        },
        mcp: {
          serverCount: readMcpRegistry().servers.length,
          enabledServerCount: readMcpRegistry().servers.filter((server) => server.enabled).length
        }
      });
    }


    if (request.method === "GET" && url.pathname === "/api/conversations") {
      const result = conversations.listSessions({
        projectId: url.searchParams.get("projectId") || config.defaultProjectId,
        userId: url.searchParams.get("userId") || undefined,
        limit: Number(url.searchParams.get("limit") || 30),
        offset: Number(url.searchParams.get("offset") || 0),
        includeArchived: url.searchParams.get("includeArchived") === "true"
      });
      return json(response, 200, { conversations: result });
    }

    if (request.method === "POST" && url.pathname === "/api/conversations") {
      const body = await readJsonBody<{ projectId?: string; userId?: string; title?: string }>(request);
      const conversation = conversations.createSession({ projectId: body.projectId || config.defaultProjectId, userId: body.userId, title: body.title || "新对话" });
      return json(response, 200, { conversation });
    }

    const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|archive))?$/);
    if (conversationMatch) {
      const sessionId = decodeURIComponent(conversationMatch[1]);
      const action = conversationMatch[2];
      if (request.method === "GET" && !action) {
        const result = conversations.getSessionWithMessages({ sessionId });
        if (!result.conversation) return json(response, 404, { error: "conversation not found" });
        return json(response, 200, result);
      }
      if (request.method === "GET" && action === "messages") {
        const result = conversations.getSessionWithMessages({ sessionId, limit: Number(url.searchParams.get("limit") || 200) });
        if (!result.conversation) return json(response, 404, { error: "conversation not found" });
        return json(response, 200, result);
      }
      if (request.method === "POST" && action === "archive") {
        const conversation = conversations.archiveSession(sessionId);
        if (!conversation) return json(response, 404, { error: "conversation not found" });
        return json(response, 200, { conversation });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/collected") {
      const items = sqlite.listCollectedItems({
        projectId: url.searchParams.get("projectId") || config.defaultProjectId,
        userId: url.searchParams.get("userId") || undefined,
        limit: Number(url.searchParams.get("limit") || 30),
        offset: Number(url.searchParams.get("offset") || 0)
      });
      return json(response, 200, { items });
    }

    const collectedMatch = url.pathname.match(/^\/api\/collected\/([^/]+)$/);
    if (request.method === "GET" && collectedMatch) {
      const item = sqlite.getCollectedItem(decodeURIComponent(collectedMatch[1]));
      if (!item) return json(response, 404, { error: "collected item not found" });
      return json(response, 200, { item });
    }

    if (request.method === "POST" && url.pathname === "/api/collected") {
      const body = await readJsonBody<{ title?: string; content?: string; source?: string; kind?: string; projectId?: string; userId?: string; sessionId?: string; metadata?: Record<string, unknown> }>(request);
      if (!body.content?.trim()) return json(response, 400, { error: "content is required" });
      const result = await collectedWorkflow.ingest({
        userId: body.userId,
        sessionId: body.sessionId,
        projectId: body.projectId || config.defaultProjectId,
        kind: body.kind === "url" || body.kind === "note" || body.kind === "transcript" || body.kind === "wechat_article" || body.kind === "manual_text" ? body.kind : "manual_text",
        title: body.title?.trim() || "未命名资料",
        source: body.source,
        content: body.content,
        metadata: body.metadata
      });
      return json(response, result.status === "failed" ? 500 : 200, result);
    }

    if (request.method === "GET" && url.pathname === "/api/mcp/servers") {
      return json(response, 200, readMcpRegistry());
    }

    if (request.method === "POST" && url.pathname === "/api/mcp/servers") {
      const body = await readJsonBody<McpServerDefinition>(request);
      if (!body.id?.trim()) return json(response, 400, { error: "id is required" });
      const registry = upsertMcpServer(body);
      return json(response, 200, registry);
    }

    if (request.method === "POST" && url.pathname === "/api/mcp/servers/from-url") {
      const body = await readJsonBody<McpUrlServerInput & { refreshTools?: boolean }>(request);
      if (!body.url?.trim()) return json(response, 400, { error: "url is required" });
      const server = createMcpServerFromUrl(body);
      let registry = upsertMcpServer(server);
      if (body.refreshTools) {
        const tools = await mcp.listTools(server.id);
        registry = replaceMcpServerTools(server.id, tools);
        return json(response, 200, { server: registry.servers.find((entry) => entry.id === server.id), tools, registry });
      }
      return json(response, 200, { server, registry });
    }

    const mcpMatch = url.pathname.match(/^\/api\/mcp\/servers\/([^/]+)(?:\/(enable|disable|remove|tools))?$/);
    if (mcpMatch) {
      const serverId = decodeURIComponent(mcpMatch[1]);
      const action = mcpMatch[2];
      if (request.method === "DELETE" && !action) {
        return json(response, 200, removeMcpServer(serverId));
      }
      if (request.method === "POST" && action === "remove") {
        return json(response, 200, removeMcpServer(serverId));
      }
      if (request.method === "POST" && action === "enable") {
        return json(response, 200, setMcpServerEnabled(serverId, true));
      }
      if (request.method === "POST" && action === "disable") {
        return json(response, 200, setMcpServerEnabled(serverId, false));
      }
      if (request.method === "GET" && action === "tools") {
        const tools = await mcp.listTools(serverId);
        if (url.searchParams.get("refresh") === "true") {
          const registry = replaceMcpServerTools(serverId, tools);
          return json(response, 200, { tools, registry });
        }
        return json(response, 200, { tools });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJsonBody<{ message?: string; sessionId?: string; projectId?: string; userId?: string }>(request);
      const requestLogId = randomUUID();
      interactionLogger.requestStarted({
        requestLogId,
        endpoint: "/api/chat",
        input: { message: body.message, sessionId: body.sessionId, projectId: body.projectId, userId: body.userId }
      });
      if (!body.message?.trim()) {
        interactionLogger.requestFailed({
          requestLogId,
          endpoint: "/api/chat",
          error: "message is required",
          output: { statusCode: 400 }
        });
        return json(response, 400, { error: "message is required" });
      }

      try {
        const result = await orchestrator.chat({
          message: body.message,
          sessionId: body.sessionId,
          projectId: body.projectId,
          userId: body.userId
        });
        interactionLogger.requestCompleted({
          requestLogId,
          endpoint: "/api/chat",
          output: result as unknown as Record<string, unknown>
        });
        return json(response, 200, result);
      } catch (error) {
        interactionLogger.requestFailed({ requestLogId, endpoint: "/api/chat", error });
        throw error;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/chat/stream") {
      const body = await readJsonBody<{ message?: string; sessionId?: string; projectId?: string; userId?: string }>(request);
      const requestLogId = randomUUID();
      interactionLogger.requestStarted({
        requestLogId,
        endpoint: "/api/chat/stream",
        input: { message: body.message, sessionId: body.sessionId, projectId: body.projectId, userId: body.userId }
      });
      if (!body.message?.trim()) {
        interactionLogger.requestFailed({
          requestLogId,
          endpoint: "/api/chat/stream",
          error: "message is required",
          output: { statusCode: 400 }
        });
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
        const result = await orchestrator.chatStream(
          {
            message: body.message,
            sessionId: body.sessionId,
            projectId: body.projectId,
            userId: body.userId
          },
          {
            onEvent: (event) => {
              interactionLogger.streamEvent({ requestLogId, event });
              if (event.type === "error") {
                streamErrorEmitted = true;
              }
              if (!response.destroyed && !response.writableEnded) {
                writeSse(response, event);
              }
            }
          }
        );
        interactionLogger.requestCompleted({
          requestLogId,
          endpoint: "/api/chat/stream",
          output: result as unknown as Record<string, unknown>
        });
      } catch (error) {
        interactionLogger.requestFailed({ requestLogId, endpoint: "/api/chat/stream", error });
        if (!streamErrorEmitted && !response.writableEnded) {
          const friendlyMessage = formatUserFacingError(error);
          const event: ChatStreamEvent = {
            type: "error",
            error: friendlyMessage,
            friendlyMessage,
            debug: { rawError: error instanceof Error ? error.message : String(error) }
          };
          interactionLogger.streamEvent({ requestLogId, event });
          writeSse(response, event);
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
        metadata: body.metadata,
        tags: body.tags
      });
      return json(response, 200, result);
    }

    const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)(?:\/(tags))?$/);
    if (documentMatch) {
      const documentId = decodeURIComponent(documentMatch[1]);
      const action = documentMatch[2];
      if (request.method === "GET" && !action) {
        const document = sqlite.getDocument(documentId);
        if (!document) return json(response, 404, { error: "document not found" });
        return json(response, 200, { document, tags: sqlite.getDocumentTags(documentId) });
      }
      if (request.method === "PATCH" && !action) {
        const body = await readJsonBody<Partial<StoredDocumentUpdateInput>>(request);
        if (body.content !== undefined && !body.content.trim()) {
          return json(response, 400, { error: "content cannot be empty" });
        }
        const result = await documents.updateDocument({
          id: documentId,
          title: body.title,
          content: body.content,
          source: body.source,
          projectId: body.projectId,
          metadata: body.metadata,
          tags: body.tags
        });
        return json(response, 200, result);
      }
      if (request.method === "GET" && action === "tags") {
        const document = sqlite.getDocument(documentId);
        if (!document) return json(response, 404, { error: "document not found" });
        return json(response, 200, { tags: sqlite.getDocumentTags(documentId) });
      }
      if (request.method === "PUT" && action === "tags") {
        const body = await readJsonBody<{ tags?: Array<string | DocumentTagSuggestion>; projectId?: string }>(request);
        const document = sqlite.getDocument(documentId);
        if (!document) return json(response, 404, { error: "document not found" });
        const suggestions = (body.tags ?? []).map((tag) => typeof tag === "string" ? { name: tag, confidence: 1, reason: "手动设置标签" } : tag);
        const tags = sqlite.replaceDocumentTags(documentId, body.projectId || document.projectId, suggestions);
        return json(response, 200, { tags, document: sqlite.getDocument(documentId) });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/tags") {
      const tags = sqlite.listTags({
        projectId: url.searchParams.get("projectId") || config.defaultProjectId,
        query: url.searchParams.get("query") || undefined,
        limit: Number(url.searchParams.get("limit") || 100),
        offset: Number(url.searchParams.get("offset") || 0)
      });
      return json(response, 200, { tags });
    }

    if (request.method === "POST" && url.pathname === "/api/tags") {
      const body = await readJsonBody<{ projectId?: string; name?: string; description?: string }>(request);
      if (!body.name?.trim()) return json(response, 400, { error: "name is required" });
      const tag = sqlite.createTag({
        projectId: body.projectId || config.defaultProjectId,
        name: body.name,
        description: body.description
      });
      return json(response, 200, { tag });
    }

    const tagMatch = url.pathname.match(/^\/api\/tags\/([^/]+)$/);
    if (tagMatch) {
      const tagId = decodeURIComponent(tagMatch[1]);
      if (request.method === "PATCH") {
        const body = await readJsonBody<{ name?: string; description?: string | null }>(request);
        const tag = sqlite.updateTag({ id: tagId, name: body.name, description: body.description });
        if (!tag) return json(response, 404, { error: "tag not found" });
        return json(response, 200, { tag });
      }
      if (request.method === "DELETE") {
        const deleted = sqlite.deleteTag(tagId);
        return json(response, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "tag not found" });
      }
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
