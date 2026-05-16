#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const command = process.argv[2];
const value = process.argv[3];
const root = process.cwd();
const mcpDir = path.join(root, "mcp");
const registryPath = path.join(mcpDir, "registry.json");

if (!command || !["add", "add-url", "remove", "list", "enable", "disable"].includes(command)) {
  console.error("Usage:");
  console.error("  npm run mcp:add -- <server-json-file>");
  console.error("  npm run mcp:add-url -- <url> [token] [server-id]");
  console.error("  npm run mcp:remove -- <server-id>");
  console.error("  npm run mcp:list");
  console.error("  npm run mcp:enable -- <server-id>");
  console.error("  npm run mcp:disable -- <server-id>");
  process.exit(1);
}

mkdirSync(mcpDir, { recursive: true });
const registry = readRegistry();

if (command === "list") {
  if (registry.servers.length === 0) {
    console.log("No MCP servers registered.");
    process.exit(0);
  }
  for (const server of registry.servers) {
    const toolCount = Array.isArray(server.tools) ? server.tools.length : 0;
    console.log(`${server.enabled ? "enabled " : "disabled"} ${server.id} (${server.transport}) tools=${toolCount}`);
  }
  process.exit(0);
}

if (!value) {
  console.error(`Missing value for mcp:${command}.`);
  process.exit(1);
}

if (command === "add") {
  const serverPath = path.resolve(value);
  if (!existsSync(serverPath)) {
    console.error(`MCP server JSON not found: ${serverPath}`);
    process.exit(1);
  }
  const server = normalizeServer(JSON.parse(readFileSync(serverPath, "utf8")));
  registry.servers = registry.servers.filter((entry) => entry.id !== server.id);
  registry.servers.push(server);
  writeRegistry(registry);
  console.log(`Registered MCP server ${server.id}.`);
  process.exit(0);
}

if (command === "add-url") {
  const token = process.argv[4];
  const explicitId = process.argv[5];
  const server = normalizeServer(createServerFromUrl({ url: value, token, id: explicitId }));
  registry.servers = registry.servers.filter((entry) => entry.id !== server.id);
  registry.servers.push(server);
  writeRegistry(registry);
  console.log(`Registered MCP server ${server.id} from ${server.url}.`);
  process.exit(0);
}

if (command === "remove") {
  registry.servers = registry.servers.filter((entry) => entry.id !== value);
  writeRegistry(registry);
  console.log(`Removed MCP server ${value}.`);
  process.exit(0);
}

if (command === "enable" || command === "disable") {
  const enabled = command === "enable";
  let found = false;
  registry.servers = registry.servers.map((entry) => {
    if (entry.id !== value) {
      return entry;
    }
    found = true;
    return { ...entry, enabled };
  });
  if (!found) {
    console.error(`MCP server not found: ${value}`);
    process.exit(1);
  }
  writeRegistry(registry);
  console.log(`${enabled ? "Enabled" : "Disabled"} MCP server ${value}.`);
}

function readRegistry() {
  if (!existsSync(registryPath)) {
    return { servers: [] };
  }
  const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
  return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
}

function writeRegistry(nextRegistry) {
  writeFileSync(registryPath, `${JSON.stringify(nextRegistry, null, 2)}\n`);
}

function normalizeServer(value) {
  const id = String(value.id ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  if (!id) {
    console.error("MCP server id is required.");
    process.exit(1);
  }
  const transport = value.transport === "streamable_http" ? "streamable_http" : "stdio";
  return {
    id,
    name: stringValue(value.name),
    enabled: value.enabled !== false,
    transport,
    command: stringValue(value.command),
    args: Array.isArray(value.args) ? value.args.filter((item) => typeof item === "string") : [],
    cwd: stringValue(value.cwd),
    env: recordOfStrings(value.env),
    url: stringValue(value.url),
    headers: recordOfStrings(value.headers),
    allowedTools: Array.isArray(value.allowedTools) ? value.allowedTools.filter((item) => typeof item === "string") : undefined,
    tools: Array.isArray(value.tools) ? value.tools.filter((tool) => tool && typeof tool.name === "string") : [],
    riskLevel: normalizeChoice(value.riskLevel, ["low", "medium", "high"]),
    costLevel: normalizeChoice(value.costLevel, ["low", "medium", "high"]),
    requiresConfirmation: Boolean(value.requiresConfirmation),
    timeoutMs: typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) ? value.timeoutMs : undefined
  };
}

function createServerFromUrl(input) {
  let parsed;
  try {
    parsed = new URL(input.url);
  } catch {
    console.error(`Invalid MCP URL: ${input.url}`);
    process.exit(1);
  }
  const token = stringValue(input.token);
  return {
    id: input.id || parsed.hostname,
    name: parsed.hostname,
    enabled: true,
    transport: "streamable_http",
    url: parsed.toString(),
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    tools: [],
    riskLevel: "medium",
    costLevel: "low",
    requiresConfirmation: false
  };
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordOfStrings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeChoice(value, choices) {
  return choices.includes(value) ? value : undefined;
}
