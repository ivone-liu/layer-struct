import { randomUUID } from "node:crypto";
import { SqliteStore } from "../storage/sqliteStore.js";
import type { ChatStreamCallbacks, ChatStreamEvent, EvidencePack, ExecutionResult, RoutePlan, RunStepName } from "../types.js";

export class RunTracker {
  private readonly activeStepIds = new Map<RunStepName, string>();

  constructor(
    private readonly sqlite: SqliteStore,
    private readonly callbacks: ChatStreamCallbacks,
    private readonly runId: string
  ) {}

  async runStarted(message: string): Promise<void> {
    this.sqlite.updateRunStatus(this.runId, "running");
    await this.emit({
      type: "run_started",
      runId: this.runId,
      status: "running",
      visibleMessage: message,
      createdAt: new Date().toISOString()
    });
  }

  async stepStarted(step: RunStepName, message: string, debug?: Record<string, unknown>): Promise<void> {
    const stepId = randomUUID();
    this.activeStepIds.set(step, stepId);
    this.sqlite.insertRunStep({
      id: stepId,
      runId: this.runId,
      stepName: step,
      status: "running",
      visibleMessage: message,
      debug,
      startedAt: new Date().toISOString()
    });
    await this.emit({ type: "step_started", runId: this.runId, step, status: "running", visibleMessage: message, debug });
  }

  async stepCompleted(step: RunStepName, message: string, debug?: Record<string, unknown>): Promise<void> {
    const stepId = this.ensureStep(step, "completed", message, debug);
    this.sqlite.updateRunStep(stepId, {
      status: "completed",
      visibleMessage: message,
      debug,
      endedAt: new Date().toISOString()
    });
    this.activeStepIds.delete(step);
    await this.emit({ type: "step_completed", runId: this.runId, step, status: "completed", visibleMessage: message, debug });
  }

  async stepFailed(step: RunStepName, message: string, error: unknown, debug?: Record<string, unknown>): Promise<void> {
    const formattedError = formatError(error);
    const stepId = this.ensureStep(step, "failed", message, debug);
    this.sqlite.updateRunStep(stepId, {
      status: "failed",
      visibleMessage: message,
      debug,
      endedAt: new Date().toISOString(),
      error: formattedError
    });
    this.activeStepIds.delete(step);
    await this.emit({
      type: "step_failed",
      runId: this.runId,
      step,
      status: "failed",
      visibleMessage: message,
      error: formattedError,
      debug
    });
  }

  async metadata(payload: Record<string, unknown>, visibleMessage?: string): Promise<void> {
    await this.emit({
      type: "metadata",
      runId: this.runId,
      visibleMessage,
      payload,
      routePlan: "routePlan" in payload ? (payload.routePlan as RoutePlan) : undefined,
      evidencePack: "evidencePack" in payload ? (payload.evidencePack as EvidencePack | undefined) : undefined,
      executionResult: "executionResult" in payload ? (payload.executionResult as ExecutionResult | undefined) : undefined
    });
  }

  async answerDelta(content: string): Promise<void> {
    await this.emit({ type: "assistant_delta", runId: this.runId, content });
  }

  async done(payload: Omit<Extract<ChatStreamEvent, { type: "done" }>, "type" | "runId" | "status">): Promise<void> {
    this.sqlite.updateRunStatus(this.runId, "completed");
    await this.emit({ type: "done", runId: this.runId, status: "completed", ...payload });
  }

  async error(error: unknown): Promise<void> {
    this.sqlite.updateRunStatus(this.runId, "failed");
    await this.emit({ type: "error", runId: this.runId, status: "failed", error: formatError(error) });
  }

  private ensureStep(
    step: RunStepName,
    status: "completed" | "failed",
    message: string,
    debug?: Record<string, unknown>
  ): string {
    const existing = this.activeStepIds.get(step);
    if (existing) {
      return existing;
    }

    const stepId = randomUUID();
    this.activeStepIds.set(step, stepId);
    this.sqlite.insertRunStep({
      id: stepId,
      runId: this.runId,
      stepName: step,
      status,
      visibleMessage: message,
      debug,
      startedAt: new Date().toISOString()
    });
    return stepId;
  }

  private async emit(event: ChatStreamEvent): Promise<void> {
    this.sqlite.insertRunEvent({
      id: randomUUID(),
      runId: this.runId,
      eventType: event.type,
      visibleMessage: "visibleMessage" in event ? event.visibleMessage : undefined,
      payload: event as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString()
    });
    await this.callbacks.onEvent(event);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
