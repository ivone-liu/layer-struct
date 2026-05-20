import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config/env.js";
import type { ChatStreamEvent } from "../types.js";

export class InteractionLogger {
  constructor(private readonly config: AppConfig["log"]) {}

  get enabled(): boolean {
    return this.config.channel === "daily";
  }

  requestStarted(params: {
    requestLogId: string;
    endpoint: string;
    input: Record<string, unknown>;
  }): void {
    this.write({
      kind: "request_started",
      requestLogId: params.requestLogId,
      endpoint: params.endpoint,
      input: params.input
    });
  }

  streamEvent(params: { requestLogId: string; event: ChatStreamEvent }): void {
    this.write({
      kind: "stream_event",
      requestLogId: params.requestLogId,
      runId: params.event.runId,
      eventType: params.event.type,
      event: params.event
    });
  }

  requestCompleted(params: {
    requestLogId: string;
    endpoint: string;
    output: Record<string, unknown>;
  }): void {
    this.write({
      kind: "request_completed",
      requestLogId: params.requestLogId,
      endpoint: params.endpoint,
      output: params.output
    });
  }

  requestFailed(params: {
    requestLogId: string;
    endpoint: string;
    error: unknown;
    output?: Record<string, unknown>;
  }): void {
    this.write({
      kind: "request_failed",
      requestLogId: params.requestLogId,
      endpoint: params.endpoint,
      error: formatError(params.error),
      output: params.output
    });
  }

  private write(payload: Record<string, unknown>): void {
    if (!this.enabled) {
      return;
    }

    const now = new Date();
    const record = {
      timestamp: now.toISOString(),
      ...payload
    };
    const filePath = path.resolve(process.cwd(), this.config.dir, `${formatLocalDate(now)}.log`);
    const serialized = [
      "\n================================================================================",
      JSON.stringify(record, null, 2),
      "================================================================================\n"
    ].join("\n");

    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      appendFileSync(filePath, serialized, "utf8");
    } catch (error) {
      console.warn("interaction log write failed", error);
    }
  }
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}
