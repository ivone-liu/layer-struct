import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CapabilityDefinition, CostLevel, RiskLevel } from "../types.js";
import type { McpRegistryFile, McpServerDefinition, McpToolDefinition, McpUrlServerInput } from "./types.js";

export function mcpDir(rootDir = process.cwd()): string {
  return path.resolve(rootDir, "mcp");
}

export function mcpRegistryPath(rootDir = process.cwd()): string {
  return path.join(mcpDir(rootDir), "registry.json");
}

export function readMcpRegistry(rootDir = process.cwd()): McpRegistryFile {
  const filePath = mcpRegistryPath(rootDir);
  if (!existsSync(filePath)) {
    return { servers: [] };
  }

  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<McpRegistryFile>;
  return { servers: Array.isArray(parsed.servers) ? parsed.servers.map(normalizeServer).filter(Boolean) as McpServerDefinition[] : [] };
}

export function writeMcpRegistry(registry: McpRegistryFile, rootDir = process.cwd()): void {
  const dir = mcpDir(rootDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(mcpRegistryPath(rootDir), `${JSON.stringify({ servers: registry.servers.map(normalizeServer) }, null, 2)}\n`);
}

export function upsertMcpServer(server: McpServerDefinition, rootDir = process.cwd()): McpRegistryFile {
  const registry = readMcpRegistry(rootDir);
  const normalized = normalizeServer(server);
  registry.servers = registry.servers.filter((entry) => entry.id !== normalized.id);
  registry.servers.push(normalized);
  writeMcpRegistry(registry, rootDir);
  return registry;
}

export function createMcpServerFromUrl(input: McpUrlServerInput): McpServerDefinition {
  const rawUrl = stringValue(input.url);
  if (!rawUrl) {
    throw new Error("url is required");
  }

  const parsed = new URL(rawUrl);
  const token = stringValue(input.token);
  const tokenHeader = stringValue(input.tokenHeader) ?? "Authorization";
  const tokenScheme = stringValue(input.tokenScheme) ?? "Bearer";
  const headers = token
    ? { [tokenHeader]: tokenScheme ? `${tokenScheme} ${token}` : token }
    : undefined;

  return {
    id: normalizeId(input.id ?? parsed.hostname),
    name: stringValue(input.name),
    enabled: input.enabled ?? true,
    transport: "streamable_http",
    url: parsed.toString(),
    headers,
    allowedTools: Array.isArray(input.allowedTools) ? input.allowedTools.filter((item): item is string => typeof item === "string") : undefined,
    tools: [],
    riskLevel: "medium",
    costLevel: "low",
    requiresConfirmation: false,
    timeoutMs: typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) ? input.timeoutMs : undefined
  };
}

export function removeMcpServer(serverId: string, rootDir = process.cwd()): McpRegistryFile {
  const registry = readMcpRegistry(rootDir);
  registry.servers = registry.servers.filter((entry) => entry.id !== serverId);
  writeMcpRegistry(registry, rootDir);
  return registry;
}

export function setMcpServerEnabled(serverId: string, enabled: boolean, rootDir = process.cwd()): McpRegistryFile {
  const registry = readMcpRegistry(rootDir);
  registry.servers = registry.servers.map((entry) => entry.id === serverId ? { ...entry, enabled } : entry);
  writeMcpRegistry(registry, rootDir);
  return registry;
}

export function replaceMcpServerTools(serverId: string, tools: McpToolDefinition[], rootDir = process.cwd()): McpRegistryFile {
  const registry = readMcpRegistry(rootDir);
  registry.servers = registry.servers.map((entry) => entry.id === serverId ? { ...entry, tools: tools.map(normalizeTool).filter(Boolean) as McpToolDefinition[] } : entry);
  writeMcpRegistry(registry, rootDir);
  return registry;
}

export function loadMcpCapabilities(rootDir = process.cwd()): CapabilityDefinition[] {
  return readMcpRegistry(rootDir).servers.flatMap((server) => {
    if (!server.enabled) {
      return [];
    }

    const allowed = new Set(server.allowedTools ?? []);
    return (server.tools ?? [])
      .filter((tool) => allowed.size === 0 || allowed.has(tool.name))
      .map((tool) => toCapability(server, tool));
  });
}

export function findMcpServer(serverId: string, rootDir = process.cwd()): McpServerDefinition | undefined {
  return readMcpRegistry(rootDir).servers.find((server) => server.id === serverId);
}

export function parseMcpCapabilityId(capabilityId: string): { serverId: string; toolName: string } | undefined {
  const match = capabilityId.match(/^mcp\.([^.]+)\.(.+)$/u);
  if (!match) {
    return undefined;
  }
  return { serverId: match[1], toolName: match[2] };
}

function toCapability(server: McpServerDefinition, tool: McpToolDefinition): CapabilityDefinition {
  const description = tool.description?.trim() || `MCP tool ${tool.name} from ${server.name ?? server.id}.`;
  return {
    id: `mcp.${server.id}.${tool.name}`,
    kind: "mcp_tool",
    name: `${server.name ?? server.id}: ${tool.name}`,
    description,
    examples: tool.examples ?? [],
    requiredParams: requiredParamsFromSchema(tool.inputSchema),
    optionalParams: optionalParamsFromSchema(tool.inputSchema),
    riskLevel: tool.riskLevel ?? server.riskLevel ?? "medium",
    costLevel: tool.costLevel ?? server.costLevel ?? "low",
    requiresConfirmation: tool.requiresConfirmation ?? server.requiresConfirmation ?? false
  };
}

function normalizeServer(value: McpServerDefinition): McpServerDefinition {
  const id = normalizeId(value.id);
  const transport = value.transport === "streamable_http" ? "streamable_http" : "stdio";
  return {
    id,
    name: stringValue(value.name),
    enabled: value.enabled !== false,
    transport,
    command: stringValue(value.command),
    args: Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [],
    cwd: stringValue(value.cwd),
    env: recordOfStrings(value.env),
    url: stringValue(value.url),
    headers: recordOfStrings(value.headers),
    allowedTools: Array.isArray(value.allowedTools) ? value.allowedTools.filter((item): item is string => typeof item === "string") : undefined,
    tools: Array.isArray(value.tools) ? value.tools.map(normalizeTool).filter(Boolean) as McpToolDefinition[] : [],
    riskLevel: normalizeRisk(value.riskLevel),
    costLevel: normalizeCost(value.costLevel),
    requiresConfirmation: Boolean(value.requiresConfirmation),
    timeoutMs: typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) ? value.timeoutMs : undefined
  };
}

function normalizeTool(value: McpToolDefinition): McpToolDefinition | undefined {
  const name = stringValue(value.name);
  if (!name) {
    return undefined;
  }
  return {
    name,
    description: stringValue(value.description),
    inputSchema: value.inputSchema && typeof value.inputSchema === "object" ? value.inputSchema : undefined,
    examples: Array.isArray(value.examples) ? value.examples.filter((item): item is string => typeof item === "string") : [],
    riskLevel: normalizeRisk(value.riskLevel),
    costLevel: normalizeCost(value.costLevel),
    requiresConfirmation: Boolean(value.requiresConfirmation)
  };
}

function requiredParamsFromSchema(schema: Record<string, unknown> | undefined): string[] {
  const required = schema?.required;
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
}

function optionalParamsFromSchema(schema: Record<string, unknown> | undefined): string[] {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object") {
    return [];
  }
  const required = new Set(requiredParamsFromSchema(schema));
  return Object.keys(properties).filter((key) => !required.has(key));
}

function normalizeId(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordOfStrings(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeRisk(value: unknown): RiskLevel | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function normalizeCost(value: unknown): CostLevel | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}
