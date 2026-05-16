import type { CostLevel, RiskLevel } from "../types.js";

export type McpTransportType = "stdio" | "streamable_http";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  examples?: string[];
  riskLevel?: RiskLevel;
  costLevel?: CostLevel;
  requiresConfirmation?: boolean;
}

export interface McpServerDefinition {
  id: string;
  name?: string;
  enabled: boolean;
  transport: McpTransportType;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
  tools?: McpToolDefinition[];
  riskLevel?: RiskLevel;
  costLevel?: CostLevel;
  requiresConfirmation?: boolean;
  timeoutMs?: number;
}

export interface McpUrlServerInput {
  id?: string;
  name?: string;
  url: string;
  token?: string;
  tokenHeader?: string;
  tokenScheme?: string;
  allowedTools?: string[];
  enabled?: boolean;
  timeoutMs?: number;
}

export interface McpRegistryFile {
  servers: McpServerDefinition[];
}

export interface McpToolCallResult {
  serverId: string;
  toolName: string;
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  raw: unknown;
}
