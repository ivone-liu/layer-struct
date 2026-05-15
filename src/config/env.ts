import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const dotEnv = loadDotEnv(path.resolve(process.cwd(), ".env"));

export interface AppConfig {
  port: number;
  dataDir: string;
  sqlitePath: string;
  lanceDbUri: string;
  lanceDbTable: string;
  defaultProjectId: string;
  wespy: {
    command: string;
    outputDir: string;
    timeoutMs: number;
  };
  ai: {
    baseUrl: string;
    apiKey: string;
    routerModel: string;
    chatModel: string;
    embeddingModel: string;
    embeddingDim: number;
    requestTimeoutMs: number;
    streamConnectTimeoutMs: number;
    streamFirstTokenTimeoutMs: number;
    streamIdleTimeoutMs: number;
    streamTotalTimeoutMs: number;
  };
}

function loadDotEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const env: Record<string, string> = {};
  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    env[key] = value;
  }
  return env;
}

function readString(key: string, fallback = ""): string {
  return process.env[key] ?? dotEnv[key] ?? fallback;
}

function readNumber(key: string, fallback: number): number {
  const value = readString(key);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): AppConfig {
  const dataDir = readString("DATA_DIR", "./data");
  return {
    port: readNumber("PORT", 3000),
    dataDir,
    sqlitePath: readString("SQLITE_PATH", path.join(dataDir, "orchestrator.sqlite")),
    lanceDbUri: readString("LANCEDB_URI", path.join(dataDir, "lancedb")),
    lanceDbTable: readString("LANCEDB_TABLE", "document_chunks"),
    defaultProjectId: readString("DEFAULT_PROJECT_ID", "default"),
    wespy: {
      command: readString("WESPY_COMMAND", "wespy"),
      outputDir: readString("WESPY_OUTPUT_DIR", path.join(dataDir, "wespy")),
      timeoutMs: readNumber("WESPY_TIMEOUT_MS", 120000)
    },
    ai: {
      baseUrl: readString("AI_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, ""),
      apiKey: readString("AI_API_KEY"),
      routerModel: readString("AI_ROUTER_MODEL"),
      chatModel: readString("AI_CHAT_MODEL"),
      embeddingModel: readString("AI_EMBEDDING_MODEL"),
      embeddingDim: readNumber("AI_EMBEDDING_DIM", 1536),
      requestTimeoutMs: readNumber("AI_REQUEST_TIMEOUT_MS", 60000),
      streamConnectTimeoutMs: readNumber("AI_STREAM_CONNECT_TIMEOUT_MS", 30000),
      streamFirstTokenTimeoutMs: readNumber("AI_STREAM_FIRST_TOKEN_TIMEOUT_MS", 60000),
      streamIdleTimeoutMs: readNumber("AI_STREAM_IDLE_TIMEOUT_MS", 60000),
      streamTotalTimeoutMs: readNumber("AI_STREAM_TOTAL_TIMEOUT_MS", 180000)
    }
  };
}
