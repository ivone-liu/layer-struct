import { randomUUID } from "node:crypto";
import { AiTimeoutError } from "../ai/openAiCompatibleClient.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import type { ChatStreamCallbacks, ChatStreamEvent, EvidencePack, ExecutionResult, MemoryHit, RoutePlan, RunStepName, SessionRequirementMemory, SkillCall, SkillExecutionResult, SkillObservation, SkillPlan } from "../types.js";

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

  async event(event: ChatStreamEvent): Promise<void> {
    await this.emit(event);
  }

  async metadata(payload: Record<string, unknown>, visibleMessage?: string): Promise<void> {
    await this.emit({
      type: "metadata",
      runId: this.runId,
      visibleMessage,
      payload,
      routePlan: "routePlan" in payload ? (payload.routePlan as RoutePlan) : undefined,
      evidencePack: "evidencePack" in payload ? (payload.evidencePack as EvidencePack | undefined) : undefined,
      executionResult: "executionResult" in payload ? (payload.executionResult as ExecutionResult | undefined) : undefined,
      skillPlan: "skillPlan" in payload ? (payload.skillPlan as SkillPlan | undefined) : undefined,
      skillResults: "skillResults" in payload ? (payload.skillResults as SkillExecutionResult[] | undefined) : undefined,
      observation: "observation" in payload ? (payload.observation as SkillObservation | undefined) : undefined,
      memoryHits: "memoryHits" in payload ? (payload.memoryHits as MemoryHit[] | undefined) : undefined,
      sessionRequirementMemory: "sessionRequirementMemory" in payload ? (payload.sessionRequirementMemory as SessionRequirementMemory | undefined) : undefined
    });
  }

  async skillPlan(skillPlan: SkillPlan, visibleMessage = "我需要先从已保存资料里查找相关内容。"): Promise<void> {
    await this.emit({ type: "skill_plan", runId: this.runId, visibleMessage, skillPlan });
  }

  async skillStarted(call: SkillCall, visibleMessage?: string): Promise<void> {
    await this.emit({ type: "skill_started", runId: this.runId, visibleMessage: visibleMessage ?? renderSkillStart(call.skillId), call });
  }

  async skillCompleted(result: SkillExecutionResult, visibleMessage?: string): Promise<void> {
    const message = visibleMessage ?? `已找到 ${result.evidencePack?.items.length ?? 0} 条相关内容。`;
    await this.emit({ type: "skill_completed", runId: this.runId, visibleMessage: message, result });
  }

  async skillFailed(result: SkillExecutionResult, visibleMessage = "资料查询失败。"): Promise<void> {
    await this.emit({ type: "skill_failed", runId: this.runId, visibleMessage, result });
  }

  async observation(observation: SkillObservation, visibleMessage?: string): Promise<void> {
    await this.emit({
      type: "observation",
      runId: this.runId,
      visibleMessage: visibleMessage ?? (observation.enoughToAnswer ? "证据足够，开始生成回答。" : "没有找到足够证据，停止生成。"),
      observation
    });
  }

  async answerDelta(content: string): Promise<void> {
    await this.emit({ type: "assistant_delta", runId: this.runId, content });
  }

  async done(payload: Omit<Extract<ChatStreamEvent, { type: "done" }>, "type" | "runId" | "status">, status: "completed" | "completed_with_fallback" = "completed"): Promise<void> {
    this.sqlite.updateRunStatus(this.runId, status);
    await this.emit({ type: "done", runId: this.runId, status, ...payload });
  }

  async error(error: unknown): Promise<void> {
    const rawError = formatError(error);
    const friendlyMessage = formatUserFacingError(error);
    this.sqlite.updateRunStatus(this.runId, "failed");
    await this.emit({
      type: "error",
      runId: this.runId,
      status: "failed",
      error: friendlyMessage,
      friendlyMessage,
      recoverable: isTimeoutLikeError(error),
      debug: { rawError }
    });
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

export function formatUserFacingError(error: unknown): string {
  if (error instanceof AiTimeoutError) {
    return "生成模型响应超时，请稍后重试或缩短问题。";
  }
  const raw = formatError(error);
  if (isTimeoutLikeError(error) || raw.includes("This operation was aborted")) {
    return "生成请求被超时中断，请稍后重试或缩短问题。";
  }
  return "处理过程中出现错误。";
}

function isTimeoutLikeError(error: unknown): boolean {
  return error instanceof AiTimeoutError || error instanceof Error && error.name === "AbortError";
}

function renderSkillStart(skillId: string): string {
  if (skillId.startsWith("mcp.")) {
    return `正在调用 MCP 工具 ${skillId}。`;
  }
  return skillId === "skill.sqlite_query" ? "正在调用资料库精确查询。" : "正在调用资料库语义检索。";
}
