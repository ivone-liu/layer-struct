import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RequestContext, SkillCall, SkillExecutionResult } from "../types.js";
import { findMcpServer, parseMcpCapabilityId } from "./registry.js";
import type { McpServerDefinition, McpToolCallResult, McpToolDefinition } from "./types.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class McpClientManager {
  constructor(private readonly rootDir = process.cwd()) {}

  async listTools(serverId: string): Promise<McpToolDefinition[]> {
    const server = this.requireServer(serverId);
    if (!server.enabled) {
      throw new Error(`MCP server '${serverId}' is disabled.`);
    }
    const result = await this.request(server, "tools/list", {});
    const tools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
    return tools.map(toToolDefinition).filter((tool): tool is McpToolDefinition => Boolean(tool));
  }

  async callTool(call: SkillCall, context: RequestContext): Promise<SkillExecutionResult> {
    const parsed = parseMcpCapabilityId(call.skillId);
    if (!parsed) {
      return { callId: call.id, skillId: call.skillId, status: "skipped", error: `Unsupported MCP skill id: ${call.skillId}` };
    }

    try {
      const server = this.requireServer(parsed.serverId);
      if (!server.enabled) {
        return { callId: call.id, skillId: call.skillId, status: "skipped", error: `MCP server '${parsed.serverId}' is disabled.` };
      }
      if (server.allowedTools?.length && !server.allowedTools.includes(parsed.toolName)) {
        return { callId: call.id, skillId: call.skillId, status: "skipped", error: `MCP tool '${parsed.toolName}' is not allowed for server '${parsed.serverId}'.` };
      }

      const result = await this.callServerTool(server, parsed.toolName, call.params);
      const text = extractText(result.content);
      return {
        callId: call.id,
        skillId: call.skillId,
        status: result.isError ? "failed" : text || result.structuredContent ? "success" : "empty",
        output: {
          serverId: parsed.serverId,
          toolName: parsed.toolName,
          text,
          content: result.content,
          structuredContent: result.structuredContent,
          raw: result.raw,
          requestId: context.requestId
        },
        error: result.isError ? text || "MCP tool returned an error." : undefined
      };
    } catch (error) {
      return {
        callId: call.id,
        skillId: call.skillId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async callServerTool(server: McpServerDefinition, toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.request(server, "tools/call", {
      name: toolName,
      arguments: args
    });
    const record = isRecord(result) ? result : {};
    return {
      serverId: server.id,
      toolName,
      content: Array.isArray(record.content) ? record.content : [],
      structuredContent: record.structuredContent,
      isError: Boolean(record.isError),
      raw: result
    };
  }

  private async request(server: McpServerDefinition, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (server.transport === "streamable_http") {
      return this.requestStreamableHttp(server, method, params);
    }
    return this.requestStdio(server, method, params);
  }

  private async requestStreamableHttp(server: McpServerDefinition, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!server.url) {
      throw new Error(`MCP server '${server.id}' is missing url.`);
    }

    const timeoutMs = server.timeoutMs ?? 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...resolveHeaders(server.headers, this.rootDir)
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`MCP HTTP request failed with ${response.status}.`);
      }
      const payload = await response.json() as JsonRpcResponse;
      if (payload.error) {
        throw new Error(payload.error.message ?? `MCP error ${payload.error.code ?? ""}`.trim());
      }
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestStdio(server: McpServerDefinition, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!server.command) {
      throw new Error(`MCP server '${server.id}' is missing command.`);
    }

    const transport = new StdioJsonRpcTransport(server, this.rootDir);
    try {
      await transport.start();
      await transport.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "layer-struct-ai-orchestrator", version: "0.1.0" }
      });
      transport.notify("notifications/initialized", {});
      return await transport.request(method, params);
    } finally {
      transport.close();
    }
  }

  private requireServer(serverId: string): McpServerDefinition {
    const server = findMcpServer(serverId, this.rootDir);
    if (!server) {
      throw new Error(`MCP server '${serverId}' is not registered.`);
    }
    return server;
  }
}

class StdioJsonRpcTransport {
  private child?: ReturnType<typeof spawn>;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private stderr = "";
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(
    private readonly server: McpServerDefinition,
    private readonly rootDir: string
  ) {}

  async start(): Promise<void> {
    const env = { ...process.env, ...resolveEnv(this.server.env, this.rootDir) };
    this.child = spawn(this.server.command!, this.server.args ?? [], {
      cwd: this.server.cwd ? path.resolve(this.rootDir, this.server.cwd) : this.rootDir,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("error", (error) => {
      const wrapped = new Error(`Failed to start MCP server '${this.server.id}': ${error.message}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(wrapped);
      }
      this.pending.clear();
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(`MCP server '${this.server.id}' exited early (${code ?? signal ?? "unknown"}). ${this.stderr.trim()}`.trim());
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = this.server.timeoutMs ?? 60000;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write(payload);
    return promise;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();
    this.child?.kill();
  }

  private write(payload: JsonRpcRequest): void {
    const json = JSON.stringify(payload);
    const message = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
    this.child?.stdin?.write(message);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lengthMatch = header.match(/content-length:\s*(\d+)/iu);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) {
        return;
      }
      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(body) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `MCP error ${message.error.code ?? ""}`.trim()));
      return;
    }
    pending.resolve(message.result);
  }
}

function toToolDefinition(value: unknown): McpToolDefinition | undefined {
  if (!isRecord(value) || typeof value.name !== "string") {
    return undefined;
  }
  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : undefined,
    inputSchema: isRecord(value.inputSchema) ? value.inputSchema : undefined
  };
}

function extractText(content: unknown[]): string {
  return content
    .map((item) => {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function resolveEnv(env: Record<string, string> | undefined, rootDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    result[key] = value.startsWith("$secret.") ? readSecret(value.slice("$secret.".length), rootDir) : value;
  }
  return result;
}

function resolveHeaders(headers: Record<string, string> | undefined, rootDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    result[key] = resolveSecretReferences(value, rootDir);
  }
  return result;
}

function resolveSecretReferences(value: string, rootDir: string): string {
  return value.replace(/\$secret\.([A-Za-z0-9_.-]+)/gu, (_match, name: string) => readSecret(name, rootDir));
}

function readSecret(name: string, rootDir: string): string {
  const secretFile = path.resolve(rootDir, "data", "secrets", name);
  if (existsSync(secretFile)) {
    return readFileSync(secretFile, "utf8").trim();
  }

  const secretJson = path.resolve(rootDir, "data", "secrets.json");
  if (existsSync(secretJson)) {
    const parsed = JSON.parse(readFileSync(secretJson, "utf8")) as Record<string, unknown>;
    const value = parsed[name];
    if (typeof value === "string") {
      return value;
    }
  }
  throw new Error(`Secret '${name}' was not found in data/secrets/${name} or data/secrets.json.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
