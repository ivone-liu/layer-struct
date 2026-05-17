import { randomUUID } from "node:crypto";
import { parseJsonObject } from "../ai/json.js";
import type { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import type { AppConfig } from "../config/env.js";
import type { SqliteStore } from "../storage/sqliteStore.js";
import type { SessionRequirementMemory } from "../types.js";

interface RequirementMemoryDraft {
  coreQuestion?: unknown;
  currentUnderstanding?: unknown;
  details?: unknown;
  openQuestions?: unknown;
}

export class SessionRequirementMemoryService {
  private readonly model: string;

  constructor(
    private readonly ai: OpenAiCompatibleClient,
    config: AppConfig,
    private readonly sqlite: SqliteStore
  ) {
    this.model = config.ai.requirementMemoryModel || config.ai.compressorModel || config.ai.routerModel || config.ai.chatModel;
  }

  async refineBeforeAnswer(params: {
    sessionId: string;
    projectId: string;
    userId?: string;
    userMessage: string;
    userMessageId: string;
  }): Promise<SessionRequirementMemory> {
    const existing = this.sqlite.getSessionRequirementMemory(params.sessionId);
    const now = new Date().toISOString();

    if (!this.ai.canChat(this.model)) {
      return this.sqlite.upsertSessionRequirementMemory(
        normalizeMemory({
          existing,
          draft: heuristicDraft(existing, params.userMessage),
          params,
          now,
          assistantMessageId: existing?.lastAssistantMessageId,
          model: this.model
        })
      );
    }

    try {
      const raw = await this.ai.chat({
        model: this.model,
        jsonMode: true,
        temperature: 0,
        messages: [
          { role: "system", content: requirementMemoryPrompt("before_answer") },
          {
            role: "user",
            content: JSON.stringify(
              {
                existingMemory: existing ? compactMemory(existing) : null,
                currentUserMessage: params.userMessage
              },
              null,
              2
            )
          }
        ]
      });
      return this.sqlite.upsertSessionRequirementMemory(
        normalizeMemory({
          existing,
          draft: parseJsonObject<RequirementMemoryDraft>(raw),
          params,
          now,
          assistantMessageId: existing?.lastAssistantMessageId,
          model: this.model
        })
      );
    } catch {
      return this.sqlite.upsertSessionRequirementMemory(
        normalizeMemory({
          existing,
          draft: heuristicDraft(existing, params.userMessage),
          params,
          now,
          assistantMessageId: existing?.lastAssistantMessageId,
          model: this.model
        })
      );
    }
  }

  async refineAfterAnswer(params: {
    sessionId: string;
    projectId: string;
    userId?: string;
    userMessage: string;
    userMessageId: string;
    assistantAnswer: string;
    assistantMessageId?: string;
  }): Promise<SessionRequirementMemory | undefined> {
    const existing = this.sqlite.getSessionRequirementMemory(params.sessionId);
    if (!existing) {
      return undefined;
    }

    const now = new Date().toISOString();
    if (!this.ai.canChat(this.model)) {
      return this.sqlite.upsertSessionRequirementMemory({
        ...existing,
        lastUserMessageId: params.userMessageId,
        lastAssistantMessageId: params.assistantMessageId ?? existing.lastAssistantMessageId,
        updatedAt: now
      });
    }

    try {
      const raw = await this.ai.chat({
        model: this.model,
        jsonMode: true,
        temperature: 0,
        messages: [
          { role: "system", content: requirementMemoryPrompt("after_answer") },
          {
            role: "user",
            content: JSON.stringify(
              {
                existingMemory: compactMemory(existing),
                currentUserMessage: params.userMessage,
                assistantAnswer: params.assistantAnswer.slice(0, 4000)
              },
              null,
              2
            )
          }
        ]
      });
      return this.sqlite.upsertSessionRequirementMemory(
        normalizeMemory({
          existing,
          draft: parseJsonObject<RequirementMemoryDraft>(raw),
          params,
          now,
          assistantMessageId: params.assistantMessageId ?? existing.lastAssistantMessageId,
          model: this.model
        })
      );
    } catch {
      return this.sqlite.upsertSessionRequirementMemory({
        ...existing,
        lastUserMessageId: params.userMessageId,
        lastAssistantMessageId: params.assistantMessageId ?? existing.lastAssistantMessageId,
        updatedAt: now
      });
    }
  }
}

function requirementMemoryPrompt(phase: "before_answer" | "after_answer"): string {
  const phaseInstruction =
    phase === "before_answer"
      ? "根据当前用户消息识别或更新本 session 的用户真实需求。第一轮必须从第一段用户提示中提取核心问题；后续轮次只在用户明确扩展、纠正或收窄目标时调整。"
      : "结合助手刚完成的回答，为本 session 的用户真实需求补充少量必要细节。不要把助手回答里的普通解释、证据正文或系统实现细节搬进 memory。";

  return `你是 session 用户需求 memory 维护器，只输出严格 JSON，不回答用户。
${phaseInstruction}

边界：
- 这个 memory 只服务当前 session，不能写入跨 session 长期记忆。
- coreQuestion 必须稳定表示本 session 的核心问题，优先来自第一段用户提示。
- currentUnderstanding 是当前对用户需求的简洁理解。
- details 只保留 0 到 5 条对完成任务有帮助的约束、范围、偏好或已明确的补充。
- openQuestions 只保留仍会影响回答的问题，最多 3 条。
- 不要过度细化，不要保存与本 session 目标无关的信息。

输出 JSON：
{"coreQuestion":"...","currentUnderstanding":"...","details":["..."],"openQuestions":["..."]}`;
}

function normalizeMemory(input: {
  existing?: SessionRequirementMemory;
  draft: RequirementMemoryDraft;
  params: {
    sessionId: string;
    projectId: string;
    userId?: string;
    userMessage: string;
    userMessageId: string;
  };
  now: string;
  assistantMessageId?: string;
  model: string;
}): SessionRequirementMemory {
  const coreQuestion = cleanText(input.draft.coreQuestion) || input.existing?.coreQuestion || firstParagraph(input.params.userMessage);
  const currentUnderstanding = cleanText(input.draft.currentUnderstanding) || input.existing?.currentUnderstanding || coreQuestion;
  return {
    id: input.existing?.id ?? randomUUID(),
    sessionId: input.params.sessionId,
    projectId: input.params.projectId,
    userId: input.params.userId ?? input.existing?.userId,
    coreQuestion: limitText(coreQuestion, 500),
    currentUnderstanding: limitText(currentUnderstanding, 800),
    details: normalizeList(input.draft.details, input.existing?.details, 5, 280),
    openQuestions: normalizeList(input.draft.openQuestions, input.existing?.openQuestions, 3, 240),
    firstUserMessageId: input.existing?.firstUserMessageId ?? input.params.userMessageId,
    lastUserMessageId: input.params.userMessageId,
    lastAssistantMessageId: input.assistantMessageId,
    model: input.model,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now
  };
}

function heuristicDraft(existing: SessionRequirementMemory | undefined, message: string): RequirementMemoryDraft {
  const userNeed = firstParagraph(message);
  return {
    coreQuestion: existing?.coreQuestion ?? userNeed,
    currentUnderstanding: existing ? `${existing.currentUnderstanding}\n最新补充：${userNeed}` : userNeed,
    details: existing?.details ?? [],
    openQuestions: existing?.openQuestions ?? []
  };
}

function compactMemory(memory: SessionRequirementMemory): Record<string, unknown> {
  return {
    coreQuestion: memory.coreQuestion,
    currentUnderstanding: memory.currentUnderstanding,
    details: memory.details,
    openQuestions: memory.openQuestions
  };
}

function firstParagraph(value: string): string {
  const paragraph = value
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .find(Boolean);
  return limitText(paragraph || value.trim() || "用户尚未提出明确问题。", 500);
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function normalizeList(value: unknown, fallback: string[] | undefined, limit: number, itemLimit: number): string[] {
  const raw = Array.isArray(value) ? value : fallback ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const cleaned = cleanText(item);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    result.push(limitText(cleaned, itemLimit));
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function limitText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
