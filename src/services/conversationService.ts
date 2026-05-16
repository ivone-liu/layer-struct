import { randomUUID } from "node:crypto";
import type { ConversationMessage, ConversationSession } from "../types.js";
import type { SqliteStore } from "../storage/sqliteStore.js";

export class ConversationService {
  constructor(private readonly sqlite: SqliteStore) {}

  createSession(params: { projectId: string; userId?: string; title?: string }): ConversationSession {
    return this.sqlite.createConversationSession(params);
  }

  listSessions(params: { projectId: string; userId?: string; limit?: number; offset?: number; includeArchived?: boolean }): ConversationSession[] {
    return this.sqlite.listConversationSessions(params);
  }

  getSessionWithMessages(params: { sessionId: string; limit?: number }): { conversation?: ConversationSession; messages: ConversationMessage[] } {
    return {
      conversation: this.sqlite.getConversationSession(params.sessionId),
      messages: this.sqlite.listConversationMessages({ sessionId: params.sessionId, limit: params.limit ?? 200 })
    };
  }

  archiveSession(sessionId: string): ConversationSession | undefined {
    return this.sqlite.archiveConversationSession(sessionId);
  }

  updateSessionTitle(sessionId: string, title: string): ConversationSession | undefined {
    return this.sqlite.updateConversationSession({ sessionId, title });
  }

  ensureConversationSession(params: { sessionId?: string; userId?: string; projectId: string; firstMessage?: string }): ConversationSession {
    return this.sqlite.ensureConversationSession(params);
  }

  appendMessage(params: {
    sessionId: string;
    runId?: string;
    role: ConversationMessage["role"];
    content: string;
    contentType?: ConversationMessage["contentType"];
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): ConversationMessage {
    return this.sqlite.insertMessage({
      id: randomUUID(),
      sessionId: params.sessionId,
      runId: params.runId,
      role: params.role,
      content: params.content,
      contentType: params.contentType ?? (params.role === "assistant" ? "markdown" : "text"),
      metadata: params.metadata ?? {},
      createdAt: params.createdAt ?? new Date().toISOString()
    });
  }

  updateMessage(params: {
    id: string;
    content?: string;
    contentType?: ConversationMessage["contentType"];
    metadata?: Record<string, unknown>;
    updatedAt?: string;
  }): ConversationMessage | undefined {
    return this.sqlite.updateConversationMessage(params);
  }

  getRecentMessages(sessionId: string, rawTurns = 2): ConversationMessage[] {
    const limit = Math.max(1, rawTurns) * 2;
    return this.sqlite.listConversationMessages({ sessionId, limit });
  }

  getMessagesForCompression(sessionId: string, excludeLastTurns = 2): ConversationMessage[] {
    const all = this.sqlite.listConversationMessages({ sessionId, limit: 1000 });
    const excludeCount = Math.max(1, excludeLastTurns) * 2;
    return all.slice(0, Math.max(0, all.length - excludeCount));
  }
}
