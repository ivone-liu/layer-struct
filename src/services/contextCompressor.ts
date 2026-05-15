import { randomUUID } from "node:crypto";
import { parseJsonObject } from "../ai/json.js";
import type { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import type { AppConfig } from "../config/env.js";
import type { SqliteStore } from "../storage/sqliteStore.js";
import type { ConversationCompressedContext, ConversationContextPack, ConversationMessage } from "../types.js";
import { ConversationService } from "./conversationService.js";

export class ContextCompressor {
  private readonly model: string;

  constructor(
    private readonly ai: OpenAiCompatibleClient,
    private readonly config: AppConfig,
    private readonly sqlite: SqliteStore,
    private readonly conversations: ConversationService
  ) {
    this.model = config.ai.compressorModel || config.ai.routerModel || config.ai.chatModel;
  }

  async buildContextPack(params: { sessionId: string; projectId: string; userId?: string }): Promise<ConversationContextPack> {
    const recentMessages = this.conversations.getRecentMessages(params.sessionId, this.config.context.rawRecentTurns);
    const latestSummary = this.sqlite.getLatestConversationSummary(params.sessionId);
    let compressedContext = latestSummary?.summaryJson;
    let compressedText = latestSummary?.summaryText;
    let summaryId = latestSummary?.id;

    const allCompressible = this.conversations.getMessagesForCompression(params.sessionId, this.config.context.rawRecentTurns);
    const uncovered = latestSummary
      ? allCompressible.slice(allCompressible.findIndex((message) => message.id === latestSummary.toMessageId) + 1).filter((message) => message.id !== latestSummary.toMessageId)
      : allCompressible;
    const messagesToCompress = uncovered.slice(-this.config.context.compressMaxMessages);

    if (messagesToCompress.length >= this.config.context.compressMinMessages && this.ai.canChat(this.model)) {
      try {
        const mergedContext = await this.compressMessages(messagesToCompress, compressedContext);
        const now = new Date().toISOString();
        const summary = this.sqlite.insertConversationSummary({
          id: randomUUID(),
          sessionId: params.sessionId,
          projectId: params.projectId,
          userId: params.userId,
          fromMessageId: messagesToCompress[0].id,
          toMessageId: messagesToCompress[messagesToCompress.length - 1].id,
          messageCount: messagesToCompress.length,
          summaryJson: mergedContext,
          summaryText: renderCompressedContext(mergedContext),
          model: this.model,
          tokenEstimate: estimateTokens(renderCompressedContext(mergedContext)),
          createdAt: now,
          updatedAt: now
        });
        compressedContext = summary.summaryJson;
        compressedText = summary.summaryText;
        summaryId = summary.id;
      } catch {
        // Compression is best-effort and must never block final generation.
      }
    }

    return { compressedContext, compressedText, recentMessages, summaryId };
  }

  private async compressMessages(messages: ConversationMessage[], existing?: ConversationCompressedContext): Promise<ConversationCompressedContext> {
    const raw = messages.map((message) => ({ id: message.id, role: message.role, content: message.content, metadata: message.metadata, createdAt: message.createdAt }));
    const content = await this.ai.chat({
      model: this.model,
      jsonMode: true,
      temperature: 0,
      messages: [
        { role: "system", content: compressorPrompt() },
        { role: "user", content: JSON.stringify({ existingSummary: existing ?? emptyCompressedContext(), messages: raw }, null, 2) }
      ]
    });
    return normalizeCompressedContext(parseJsonObject<ConversationCompressedContext>(content));
  }
}

export function renderCompressedContext(context: ConversationCompressedContext): string {
  return [
    `userGoals: ${context.userGoals.join("；") || "无"}`,
    `facts: ${context.facts.join("；") || "无"}`,
    `decisions: ${context.decisions.join("；") || "无"}`,
    `openQuestions: ${context.openQuestions.join("；") || "无"}`,
    `referencedDocuments: ${context.referencedDocuments.map((doc) => `${doc.title ?? "未命名"} documentId=${doc.documentId ?? "unknown"} source=${doc.source ?? "unknown"} reason=${doc.reason}`).join("；") || "无"}`,
    `userPreferences: ${context.userPreferences.join("；") || "无"}`,
    `corrections: ${context.corrections.join("；") || "无"}`,
    `workflowResults: ${context.workflowResults.join("；") || "无"}`,
    `importantMessages: ${context.importantMessages.map((message) => `${message.role}: ${message.content} (${message.reason})`).join("；") || "无"}`
  ].join("\n");
}

function compressorPrompt(): string {
  return `你是上下文保真压缩器，不回答用户。只输出严格 JSON。
不要新增事实；不要删除用户明确要求、纠错、目标、文档 ID、工作流结果。
保留所有 documentId、source、标题、未解决问题。
输出结构必须是：{"userGoals":[],"facts":[],"decisions":[],"openQuestions":[],"referencedDocuments":[],"userPreferences":[],"corrections":[],"workflowResults":[],"importantMessages":[]}。`;
}

function emptyCompressedContext(): ConversationCompressedContext {
  return { userGoals: [], facts: [], decisions: [], openQuestions: [], referencedDocuments: [], userPreferences: [], corrections: [], workflowResults: [], importantMessages: [] };
}

function normalizeCompressedContext(value: ConversationCompressedContext): ConversationCompressedContext {
  return {
    userGoals: stringArray(value.userGoals),
    facts: stringArray(value.facts),
    decisions: stringArray(value.decisions),
    openQuestions: stringArray(value.openQuestions),
    referencedDocuments: Array.isArray(value.referencedDocuments) ? value.referencedDocuments.map((doc) => ({ documentId: doc.documentId, title: doc.title, source: doc.source, reason: doc.reason || "referenced" })) : [],
    userPreferences: stringArray(value.userPreferences),
    corrections: stringArray(value.corrections),
    workflowResults: stringArray(value.workflowResults),
    importantMessages: Array.isArray(value.importantMessages) ? value.importantMessages.map((message) => ({ role: message.role, content: message.content, reason: message.reason || "important" })) : []
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
