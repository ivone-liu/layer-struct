import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CollectedItem,
  CollectedItemKind,
  ConversationCompressedContext,
  ConversationMessage,
  ConversationSession,
  ConversationSummary,
  DocumentTag,
  DocumentTagAssignment,
  DocumentTagSuggestion,
  EvidenceItem,
  ExpandedEvidenceItem,
  MemoryHit,
  MemoryItem,
  RequestContext,
  RoutePlan,
  RunStatus,
  RunStepName,
  RunStepStatus,
  SessionRequirementMemory,
  StoredChunk,
  StoredDocument,
  StoredDocumentInput,
  StoredDocumentUpdateInput,
  SessionState
} from "../types.js";

export class SqliteStore {
  private readonly db: DatabaseSync;

  constructor(private readonly sqlitePath: string) {
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.db = new DatabaseSync(sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  insertDocument(document: StoredDocumentInput & { id: string; createdAt: string }): StoredDocument {
    this.db
      .prepare(
        `INSERT INTO documents (id, title, source, project_id, content, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        document.id,
        document.title,
        document.source ?? null,
        document.projectId,
        document.content,
        JSON.stringify(document.metadata ?? {}),
        document.createdAt,
        document.createdAt
      );

    return {
      id: document.id,
      title: document.title,
      source: document.source,
      projectId: document.projectId,
      content: document.content,
      metadata: document.metadata ?? {},
      tags: document.tags ?? tagsFromMetadata(document.metadata),
      createdAt: document.createdAt,
      updatedAt: document.createdAt
    };
  }

  updateDocument(input: StoredDocumentUpdateInput & { updatedAt: string }): StoredDocument | undefined {
    const existing = this.getDocument(input.id);
    if (!existing) return undefined;

    const nextMetadata = input.metadata ? { ...existing.metadata, ...input.metadata } : existing.metadata;
    this.db
      .prepare(
        `UPDATE documents
         SET title = COALESCE(?, title),
             source = ?,
             project_id = COALESCE(?, project_id),
             content = COALESCE(?, content),
             metadata_json = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.title ?? null,
        input.source === undefined ? existing.source ?? null : input.source,
        input.projectId ?? null,
        input.content ?? null,
        JSON.stringify(nextMetadata),
        input.updatedAt,
        input.id
      );

    return this.getDocument(input.id);
  }

  insertChunk(chunk: StoredChunk): void {
    this.db
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, content, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(chunk.id, chunk.documentId, chunk.chunkIndex, chunk.content, estimateTokens(chunk.content), chunk.createdAt);
  }

  replaceDocumentChunks(documentId: string, chunks: StoredChunk[]): void {
    this.db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
    for (const chunk of chunks) {
      this.insertChunk(chunk);
    }
  }

  getDocument(documentId: string): StoredDocument | undefined {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as DocumentRow | undefined;
    return row ? this.hydrateDocument(row) : undefined;
  }

  getChunk(chunkId: string): (StoredChunk & { title: string; source?: string; projectId: string }) | undefined {
    const row = this.db
      .prepare(
        `SELECT c.*, d.title, d.source, d.project_id
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE c.id = ?`
      )
      .get(chunkId) as ChunkJoinRow | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      createdAt: row.created_at,
      title: row.title,
      source: row.source ?? undefined,
      projectId: row.project_id
    };
  }

  listRecentDocuments(limit = 20): StoredDocument[] {
    const rows = this.db
      .prepare("SELECT * FROM documents ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as DocumentRow[];
    return rows.map((row) => this.hydrateDocument(row));
  }

  createTag(params: { projectId: string; name: string; description?: string; now?: string }): DocumentTag {
    const now = params.now ?? new Date().toISOString();
    const name = normalizeTagName(params.name);
    const normalizedName = normalizeTagKey(name);
    const existing = this.getTagByName(params.projectId, name);
    if (existing) {
      return existing;
    }

    const tag: DocumentTag = {
      id: cryptoRandomId(),
      projectId: params.projectId,
      name,
      description: params.description,
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `INSERT INTO document_tags (id, project_id, name, normalized_name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(tag.id, tag.projectId, tag.name, normalizedName, tag.description ?? null, tag.createdAt, tag.updatedAt);
    return tag;
  }

  updateTag(params: { id: string; name?: string; description?: string | null }): DocumentTag | undefined {
    const existing = this.getTag(params.id);
    if (!existing) return undefined;
    const nextName = params.name ? normalizeTagName(params.name) : existing.name;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE document_tags
         SET name = ?, normalized_name = ?, description = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(nextName, normalizeTagKey(nextName), params.description === undefined ? existing.description ?? null : params.description, now, params.id);
    return this.getTag(params.id);
  }

  deleteTag(id: string): boolean {
    const result = this.db.prepare("DELETE FROM document_tags WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  getTag(id: string): DocumentTag | undefined {
    const row = this.db.prepare("SELECT * FROM document_tags WHERE id = ?").get(id) as DocumentTagRow | undefined;
    return row ? mapDocumentTag(row) : undefined;
  }

  getTagByName(projectId: string, name: string): DocumentTag | undefined {
    const row = this.db
      .prepare("SELECT * FROM document_tags WHERE project_id = ? AND normalized_name = ?")
      .get(projectId, normalizeTagKey(name)) as DocumentTagRow | undefined;
    return row ? mapDocumentTag(row) : undefined;
  }

  listTags(params: { projectId: string; query?: string; limit?: number; offset?: number }): DocumentTag[] {
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    if (params.query?.trim()) {
      const pattern = `%${escapeLike(params.query.trim())}%`;
      const rows = this.db
        .prepare(
          `SELECT * FROM document_tags
           WHERE project_id = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
           ORDER BY updated_at DESC, name ASC
           LIMIT ? OFFSET ?`
        )
        .all(params.projectId, pattern, pattern, limit, offset) as unknown as DocumentTagRow[];
      return rows.map(mapDocumentTag);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM document_tags
         WHERE project_id = ?
         ORDER BY updated_at DESC, name ASC
         LIMIT ? OFFSET ?`
      )
      .all(params.projectId, limit, offset) as unknown as DocumentTagRow[];
    return rows.map(mapDocumentTag);
  }

  replaceDocumentTags(documentId: string, projectId: string, suggestions: DocumentTagSuggestion[]): DocumentTagAssignment[] {
    const now = new Date().toISOString();
    const existing = this.getDocument(documentId);
    if (!existing) return [];
    const deduped = dedupeTagSuggestions(suggestions);
    this.db.prepare("DELETE FROM document_tag_links WHERE document_id = ?").run(documentId);

    const assignments: DocumentTagAssignment[] = [];
    for (const suggestion of deduped) {
      const tag = this.createTag({ projectId, name: suggestion.name, now });
      this.db
        .prepare(
          `INSERT INTO document_tag_links (document_id, tag_id, confidence, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(document_id, tag_id) DO UPDATE SET
             confidence = excluded.confidence,
             reason = excluded.reason,
             updated_at = excluded.updated_at`
        )
        .run(documentId, tag.id, clampConfidence(suggestion.confidence), suggestion.reason ?? null, now, now);
      assignments.push({
        documentId,
        tagId: tag.id,
        name: tag.name,
        projectId: tag.projectId,
        confidence: clampConfidence(suggestion.confidence),
        reason: suggestion.reason,
        createdAt: now,
        updatedAt: now
      });
    }

    const metadata = { ...existing.metadata, tags: assignments.map((tag) => tag.name), tagAssignments: assignments };
    this.db.prepare("UPDATE documents SET metadata_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(metadata), now, documentId);
    return assignments;
  }

  getDocumentTags(documentId: string): DocumentTagAssignment[] {
    const rows = this.db
      .prepare(
        `SELECT l.document_id, l.tag_id, l.confidence, l.reason, l.created_at, l.updated_at,
                t.project_id, t.name
         FROM document_tag_links l
         JOIN document_tags t ON t.id = l.tag_id
         WHERE l.document_id = ?
         ORDER BY l.confidence DESC, t.name ASC`
      )
      .all(documentId) as unknown as DocumentTagLinkJoinRow[];
    return rows.map(mapDocumentTagAssignment);
  }

  private hydrateDocument(row: DocumentRow): StoredDocument {
    const document = mapDocument(row);
    const tags = this.getDocumentTags(document.id).map((tag) => tag.name);
    return { ...document, tags: tags.length > 0 ? tags : document.tags };
  }


  searchDocuments(params: { query: string; projectId: string; limit?: number }): import("../types.js").DocumentCandidate[] {
    const limit = params.limit ?? 8;
    const trimmed = params.query.trim();
    const terms = trimmed.split(/\s+/).filter(Boolean).slice(0, 6);
    if (!trimmed) {
      return this.listRecentDocuments(limit)
        .filter((doc) => doc.projectId === params.projectId)
        .map((doc, index) => ({ documentId: doc.id, title: doc.title, source: doc.source, projectId: doc.projectId, score: limit - index, reason: "recent_document" }));
    }
    const pattern = `%${escapeLike(trimmed)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM documents
         WHERE project_id = ?
           AND (
             title LIKE ? ESCAPE '\\'
             OR source LIKE ? ESCAPE '\\'
             OR content LIKE ? ESCAPE '\\'
             OR metadata_json LIKE ? ESCAPE '\\'
             OR EXISTS (
               SELECT 1
               FROM document_tag_links dtl
               JOIN document_tags dt ON dt.id = dtl.tag_id
               WHERE dtl.document_id = documents.id
                 AND dt.name LIKE ? ESCAPE '\\'
             )
           )
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(params.projectId, pattern, pattern, pattern, pattern, pattern, limit) as unknown as DocumentRow[];
    return rows.map((row) => ({
      documentId: row.id,
      title: row.title,
      source: row.source ?? undefined,
      projectId: row.project_id,
      score: documentKeywordScore(row, terms),
      reason: "sqlite_document_keyword"
    }));
  }

  getSessionState(sessionId: string): SessionState | undefined {
    const row = this.db
      .prepare("SELECT * FROM session_state WHERE session_id = ?")
      .get(sessionId) as SessionStateRow | undefined;
    return row ? mapSessionState(row) : undefined;
  }

  upsertSessionState(params: {
    sessionId: string;
    currentDocumentId?: string;
    currentDocumentTitle?: string;
    currentDocumentSource?: string;
    updatedAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO session_state (session_id, current_document_id, current_document_title, current_document_source, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           current_document_id = excluded.current_document_id,
           current_document_title = excluded.current_document_title,
           current_document_source = excluded.current_document_source,
           updated_at = excluded.updated_at`
      )
      .run(
        params.sessionId,
        params.currentDocumentId ?? null,
        params.currentDocumentTitle ?? null,
        params.currentDocumentSource ?? null,
        params.updatedAt ?? new Date().toISOString()
      );
  }

  searchChunks(params: { query: string; projectId: string; limit?: number }): EvidenceItem[] {
    const limit = params.limit ?? 6;
    const trimmed = params.query.trim();
    const terms = trimmed.split(/\s+/).filter(Boolean).slice(0, 6);

    if (terms.length === 0 || /^(最近|最新|recent|list|列出|全部)$/iu.test(trimmed)) {
      return this.listRecentChunkEvidence(params.projectId, limit);
    }

    const pattern = `%${escapeLike(trimmed)}%`;
    const rows = this.db
      .prepare(
        `SELECT c.*, d.title, d.source, d.project_id
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE d.project_id = ?
           AND (
             d.title LIKE ? ESCAPE '\\'
             OR d.source LIKE ? ESCAPE '\\'
             OR c.content LIKE ? ESCAPE '\\'
             OR d.metadata_json LIKE ? ESCAPE '\\'
             OR EXISTS (
               SELECT 1
               FROM document_tag_links dtl
               JOIN document_tags dt ON dt.id = dtl.tag_id
               WHERE dtl.document_id = d.id
                 AND dt.name LIKE ? ESCAPE '\\'
             )
           )
         ORDER BY d.created_at DESC, c.chunk_index ASC
         LIMIT ?`
      )
      .all(params.projectId, pattern, pattern, pattern, pattern, pattern, limit) as unknown as ChunkJoinRow[];

    return rows.map((row) => mapChunkEvidence(row, keywordScore(row, terms)));
  }



  searchDocumentChunks(params: { documentId: string; query: string; limit?: number }): EvidenceItem[] {
    const limit = params.limit ?? 8;
    const trimmed = params.query.trim();
    const terms = trimmed.split(/\s+/).filter(Boolean).slice(0, 6);
    if (terms.length === 0) {
      return this.listDocumentChunks({ documentId: params.documentId, limit });
    }

    const pattern = `%${escapeLike(trimmed)}%`;
    const rows = this.db
      .prepare(
        `SELECT c.*, d.title, d.source, d.project_id
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE c.document_id = ?
           AND (
             d.title LIKE ? ESCAPE '\\'
             OR d.source LIKE ? ESCAPE '\\'
             OR c.content LIKE ? ESCAPE '\\'
             OR d.metadata_json LIKE ? ESCAPE '\\'
             OR EXISTS (
               SELECT 1
               FROM document_tag_links dtl
               JOIN document_tags dt ON dt.id = dtl.tag_id
               WHERE dtl.document_id = d.id
                 AND dt.name LIKE ? ESCAPE '\\'
             )
           )
         ORDER BY c.chunk_index ASC
         LIMIT ?`
      )
      .all(params.documentId, pattern, pattern, pattern, pattern, pattern, limit) as unknown as ChunkJoinRow[];

    return rows.map((row) => mapChunkEvidence(row, keywordScore(row, terms)));
  }

  listDocumentChunks(params: { documentId: string; limit?: number }): EvidenceItem[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, d.title, d.source, d.project_id
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE c.document_id = ?
         ORDER BY c.chunk_index ASC
         LIMIT ?`
      )
      .all(params.documentId, params.limit ?? 8) as unknown as ChunkJoinRow[];

    return rows.map((row, index) => mapChunkEvidence(row, index));
  }

  listRecentChunkEvidence(projectId: string, limit = 6): EvidenceItem[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, d.title, d.source, d.project_id
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         WHERE d.project_id = ?
         ORDER BY d.created_at DESC, c.chunk_index ASC
         LIMIT ?`
      )
      .all(projectId, limit) as unknown as ChunkJoinRow[];

    return rows.map((row, index) => mapChunkEvidence(row, index));
  }


  insertMemoryItem(item: MemoryItem): MemoryItem {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memory_items (
          id, kind, user_id, project_id, session_id, document_id, title, source, content, summary,
          entities_json, topics_json, metadata_json, score, hit_count, last_hit_at, last_decay_at,
          is_pinned, is_deleted, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.kind,
        item.userId ?? null,
        item.projectId,
        item.sessionId ?? null,
        item.documentId ?? null,
        item.title ?? null,
        item.source ?? null,
        item.content,
        item.summary ?? null,
        JSON.stringify(item.entities),
        JSON.stringify(item.topics),
        JSON.stringify(item.metadata),
        item.score,
        item.hitCount,
        item.lastHitAt ?? null,
        item.lastDecayAt ?? null,
        item.isPinned ? 1 : 0,
        item.isDeleted ? 1 : 0,
        item.createdAt,
        item.updatedAt
      );
    return item;
  }

  getMemoryItem(id: string): MemoryItem | undefined {
    const row = this.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as MemoryRow | undefined;
    return row ? mapMemoryItem(row) : undefined;
  }

  listMemoryItemsByIds(ids: string[]): MemoryItem[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM memory_items WHERE id IN (${placeholders})`).all(...ids) as unknown as MemoryRow[];
    const byId = new Map(rows.map((row) => [row.id, mapMemoryItem(row)]));
    return ids.map((id) => byId.get(id)).filter((item): item is MemoryItem => Boolean(item));
  }

  markMemoryHit(id: string, boost = 1): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE memory_items SET hit_count = hit_count + 1, score = score + ?, last_hit_at = ?, updated_at = ? WHERE id = ?`)
      .run(boost, now, now, id);
  }

  decayMemoryItems(params: { decayAmount: number; deleteThreshold: number; deleteAfterDays: number; staleAfterDays?: number }): { decayed: number; deleted: number } {
    const now = new Date();
    const nowIso = now.toISOString();
    const staleBeforeIso = new Date(now.getTime() - (params.staleAfterDays ?? 1) * 86400000).toISOString();
    const deleteBeforeIso = new Date(now.getTime() - params.deleteAfterDays * 86400000).toISOString();
    const decayed = this.db
      .prepare(
        `UPDATE memory_items
         SET score = score - ?, last_decay_at = ?, updated_at = ?
         WHERE is_pinned = 0 AND is_deleted = 0
           AND (last_hit_at IS NULL OR last_hit_at <= ?)`
      )
      .run(params.decayAmount, nowIso, nowIso, staleBeforeIso).changes;
    const deleted = this.db
      .prepare(
        `UPDATE memory_items
         SET is_deleted = 1, updated_at = ?
         WHERE is_pinned = 0 AND is_deleted = 0 AND score <= ? AND COALESCE(last_hit_at, created_at) <= ?`
      )
      .run(nowIso, params.deleteThreshold, deleteBeforeIso).changes;
    return { decayed: Number(decayed), deleted: Number(deleted) };
  }

  searchMemoryKeyword(params: { query: string; projectId: string; userId?: string; limit?: number }): MemoryHit[] {
    const limit = params.limit ?? 6;
    const terms = params.query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (terms.length === 0) return [];
    const pattern = `%${escapeLike(params.query.trim())}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
         WHERE project_id = ? AND is_deleted = 0
           AND (? IS NULL OR user_id IS NULL OR user_id = ?)
           AND (title LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR entities_json LIKE ? ESCAPE '\\' OR topics_json LIKE ? ESCAPE '\\')
         ORDER BY score DESC, hit_count DESC, updated_at DESC
         LIMIT ?`
      )
      .all(params.projectId, params.userId ?? null, params.userId ?? null, pattern, pattern, pattern, pattern, pattern, pattern, limit) as unknown as MemoryRow[];
    return rows.map((row) => memoryItemToHit(mapMemoryItem(row), keywordScoreMemory(row, terms), "keyword_memory_fallback"));
  }

  getNeighborChunks(params: { documentId: string; chunkIndex: number; before?: number; after?: number }): StoredChunk[] {
    const start = Math.max(0, params.chunkIndex - (params.before ?? 1));
    const end = params.chunkIndex + (params.after ?? 1);
    const rows = this.db
      .prepare(
        `SELECT * FROM chunks
         WHERE document_id = ? AND chunk_index BETWEEN ? AND ?
         ORDER BY chunk_index ASC`
      )
      .all(params.documentId, start, end) as unknown as ChunkRow[];
    return rows.map(mapChunk);
  }

  expandEvidenceItems(items: EvidenceItem[], window = 1): ExpandedEvidenceItem[] {
    const seen = new Set<string>();
    const expanded: ExpandedEvidenceItem[] = [];
    for (const item of items) {
      if (item.chunkIndex === undefined) {
        expanded.push({ ...item, centerChunk: true, centerChunkIndex: item.chunkIndex, expandedContent: `命中段：\n${item.content}` });
        continue;
      }
      const chunkIndex = item.chunkIndex;
      const key = `${item.documentId}:${chunkIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const neighbors = this.getNeighborChunks({ documentId: item.documentId, chunkIndex, before: window, after: window });
      const before = neighbors.filter((chunk) => chunk.chunkIndex < chunkIndex).map((chunk) => chunk.content).join("\n\n");
      const center = neighbors.find((chunk) => chunk.chunkIndex === chunkIndex)?.content ?? item.content;
      const after = neighbors.filter((chunk) => chunk.chunkIndex > chunkIndex).map((chunk) => chunk.content).join("\n\n");
      const parts = [];
      if (before) parts.push(`上文：\n${before}`);
      parts.push(`命中段：\n${center}`);
      if (after) parts.push(`下文：\n${after}`);
      expanded.push({
        ...item,
        centerChunk: true,
        centerChunkIndex: item.chunkIndex,
        contextBefore: before || undefined,
        contextAfter: after || undefined,
        expandedContent: parts.join("\n\n")
      });
    }
    return expanded;
  }


  createConversationSession(params: {
    id?: string;
    userId?: string;
    projectId: string;
    title?: string;
    status?: ConversationSession["status"];
    createdAt?: string;
  }): ConversationSession {
    const now = params.createdAt ?? new Date().toISOString();
    const session: ConversationSession = {
      id: params.id ?? cryptoRandomId(),
      userId: params.userId,
      projectId: params.projectId,
      title: normalizeTitle(params.title || "新对话"),
      status: params.status ?? "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `INSERT INTO conversation_sessions (id, user_id, project_id, title, status, message_count, last_message_preview, last_message_at, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(session.id, session.userId ?? null, session.projectId, session.title, session.status, session.messageCount, null, null, session.createdAt, session.updatedAt, null);
    return session;
  }

  getConversationSession(sessionId: string): ConversationSession | undefined {
    const row = this.db.prepare("SELECT * FROM conversation_sessions WHERE id = ?").get(sessionId) as ConversationSessionRow | undefined;
    return row ? mapConversationSession(row) : undefined;
  }

  listConversationSessions(params: { projectId: string; userId?: string; limit?: number; offset?: number; includeArchived?: boolean }): ConversationSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_sessions
         WHERE project_id = ?
           AND (? IS NULL OR user_id IS NULL OR user_id = ?)
           AND (? = 1 OR status != 'archived')
         ORDER BY COALESCE(last_message_at, updated_at) DESC, updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(params.projectId, params.userId ?? null, params.userId ?? null, params.includeArchived ? 1 : 0, params.limit ?? 30, params.offset ?? 0) as unknown as ConversationSessionRow[];
    return rows.map(mapConversationSession);
  }

  updateConversationSession(params: { sessionId: string; title?: string; status?: ConversationSession["status"]; lastMessagePreview?: string; lastMessageAt?: string; archivedAt?: string | null }): ConversationSession | undefined {
    const existing = this.getConversationSession(params.sessionId);
    if (!existing) return undefined;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE conversation_sessions
         SET title = COALESCE(?, title),
             status = COALESCE(?, status),
             last_message_preview = COALESCE(?, last_message_preview),
             last_message_at = COALESCE(?, last_message_at),
             archived_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(
        params.title ? normalizeTitle(params.title) : null,
        params.status ?? null,
        params.lastMessagePreview ?? null,
        params.lastMessageAt ?? null,
        params.archivedAt === undefined ? existing.archivedAt ?? null : params.archivedAt,
        updatedAt,
        params.sessionId
      );
    return this.getConversationSession(params.sessionId);
  }

  archiveConversationSession(sessionId: string): ConversationSession | undefined {
    return this.updateConversationSession({ sessionId, status: "archived", archivedAt: new Date().toISOString() });
  }

  ensureConversationSession(params: { sessionId?: string; userId?: string; projectId: string; firstMessage?: string }): ConversationSession {
    if (params.sessionId) {
      const existing = this.getConversationSession(params.sessionId);
      if (existing) return existing;
    }
    return this.createConversationSession({
      id: params.sessionId,
      userId: params.userId,
      projectId: params.projectId,
      title: params.firstMessage ? titleFromMessage(params.firstMessage) : "新对话"
    });
  }

  insertMessage(params: Partial<ConversationMessage> & {
    id: string;
    sessionId: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: string;
  }): ConversationMessage {
    const message: ConversationMessage = {
      id: params.id,
      sessionId: params.sessionId,
      runId: params.runId,
      role: params.role,
      content: params.content,
      contentType: params.contentType ?? "text",
      metadata: params.metadata ?? {},
      tokenEstimate: params.tokenEstimate ?? estimateTokens(params.content),
      createdAt: params.createdAt
    };
    this.db
      .prepare(
        `INSERT INTO conversation_messages (id, session_id, run_id, role, content, content_type, metadata_json, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(message.id, message.sessionId, message.runId ?? null, message.role, message.content, message.contentType, JSON.stringify(message.metadata), message.tokenEstimate, message.createdAt);
    this.updateConversationAfterMessage(message.sessionId, message);
    return message;
  }

  updateConversationMessage(params: {
    id: string;
    content?: string;
    contentType?: ConversationMessage["contentType"];
    metadata?: Record<string, unknown>;
    updatedAt?: string;
  }): ConversationMessage | undefined {
    const existingRow = this.db.prepare("SELECT * FROM conversation_messages WHERE id = ?").get(params.id) as ConversationMessageRow | undefined;
    if (!existingRow) return undefined;

    const existing = mapConversationMessage(existingRow);
    const nextContent = params.content ?? existing.content;
    const nextMetadata = params.metadata ? { ...existing.metadata, ...params.metadata } : existing.metadata;
    this.db
      .prepare(
        `UPDATE conversation_messages
         SET content = ?,
             content_type = COALESCE(?, content_type),
             metadata_json = ?,
             token_estimate = ?
         WHERE id = ?`
      )
      .run(nextContent, params.contentType ?? null, JSON.stringify(nextMetadata), estimateTokens(nextContent), params.id);

    const updated = this.getConversationMessage(params.id);
    if (updated) {
      this.updateConversationAfterMessage(updated.sessionId, {
        content: updated.content,
        createdAt: params.updatedAt ?? new Date().toISOString()
      });
    }
    return updated;
  }

  getConversationMessage(messageId: string): ConversationMessage | undefined {
    const row = this.db.prepare("SELECT * FROM conversation_messages WHERE id = ?").get(messageId) as ConversationMessageRow | undefined;
    return row ? mapConversationMessage(row) : undefined;
  }

  listSessionMessages(sessionId: string, limit = 12): ConversationMessage[] {
    return this.listConversationMessages({ sessionId, limit });
  }

  listConversationMessages(params: { sessionId: string; limit?: number; before?: string; after?: string }): ConversationMessage[] {
    const clauses = ["session_id = ?"];
    const args: Array<string | number | null> = [params.sessionId];
    if (params.before) {
      clauses.push("created_at < ?");
      args.push(params.before);
    }
    if (params.after) {
      clauses.push("created_at > ?");
      args.push(params.after);
    }
    const limit = params.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_messages
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...args, limit) as unknown as ConversationMessageRow[];
    return rows.reverse().map(mapConversationMessage);
  }

  countConversationMessages(sessionId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM conversation_messages WHERE session_id = ?").get(sessionId) as { count: number };
    return Number(row.count);
  }

  updateConversationAfterMessage(sessionId: string, message: Pick<ConversationMessage, "content" | "createdAt">): void {
    if (!this.getConversationSession(sessionId)) return;
    const count = this.countConversationMessages(sessionId);
    this.db
      .prepare(
        `UPDATE conversation_sessions
         SET message_count = ?, last_message_preview = ?, last_message_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(count, previewText(message.content), message.createdAt, message.createdAt, sessionId);
  }

  insertConversationSummary(summary: ConversationSummary): ConversationSummary {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO conversation_summaries (id, session_id, project_id, user_id, from_message_id, to_message_id, message_count, summary_json, summary_text, model, token_estimate, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(summary.id, summary.sessionId, summary.projectId, summary.userId ?? null, summary.fromMessageId, summary.toMessageId, summary.messageCount, JSON.stringify(summary.summaryJson), summary.summaryText, summary.model, summary.tokenEstimate, summary.createdAt, summary.updatedAt);
    return summary;
  }

  getLatestConversationSummary(sessionId: string): ConversationSummary | undefined {
    const row = this.db.prepare("SELECT * FROM conversation_summaries WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1").get(sessionId) as ConversationSummaryRow | undefined;
    return row ? mapConversationSummary(row) : undefined;
  }

  listConversationSummaries(sessionId: string): ConversationSummary[] {
    const rows = this.db.prepare("SELECT * FROM conversation_summaries WHERE session_id = ? ORDER BY updated_at DESC").all(sessionId) as unknown as ConversationSummaryRow[];
    return rows.map(mapConversationSummary);
  }

  getSessionRequirementMemory(sessionId: string): SessionRequirementMemory | undefined {
    const row = this.db
      .prepare("SELECT * FROM session_requirement_memory WHERE session_id = ?")
      .get(sessionId) as SessionRequirementMemoryRow | undefined;
    return row ? mapSessionRequirementMemory(row) : undefined;
  }

  upsertSessionRequirementMemory(memory: SessionRequirementMemory): SessionRequirementMemory {
    this.db
      .prepare(
        `INSERT INTO session_requirement_memory (
          id, session_id, project_id, user_id, core_question, current_understanding,
          details_json, open_questions_json, first_user_message_id, last_user_message_id,
          last_assistant_message_id, model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          project_id = excluded.project_id,
          user_id = excluded.user_id,
          core_question = excluded.core_question,
          current_understanding = excluded.current_understanding,
          details_json = excluded.details_json,
          open_questions_json = excluded.open_questions_json,
          first_user_message_id = COALESCE(session_requirement_memory.first_user_message_id, excluded.first_user_message_id),
          last_user_message_id = excluded.last_user_message_id,
          last_assistant_message_id = excluded.last_assistant_message_id,
          model = excluded.model,
          updated_at = excluded.updated_at`
      )
      .run(
        memory.id,
        memory.sessionId,
        memory.projectId,
        memory.userId ?? null,
        memory.coreQuestion,
        memory.currentUnderstanding,
        JSON.stringify(memory.details),
        JSON.stringify(memory.openQuestions),
        memory.firstUserMessageId ?? null,
        memory.lastUserMessageId ?? null,
        memory.lastAssistantMessageId ?? null,
        memory.model,
        memory.createdAt,
        memory.updatedAt
      );
    return this.getSessionRequirementMemory(memory.sessionId) ?? memory;
  }

  createCollectedItem(params: {
    id?: string;
    projectId: string;
    userId?: string;
    sessionId?: string;
    kind: CollectedItemKind;
    title: string;
    source?: string;
    status?: CollectedItem["status"];
    documentId?: string;
    contentHash?: string;
    metadata?: Record<string, unknown>;
  }): CollectedItem {
    const now = new Date().toISOString();
    const item: CollectedItem = {
      id: params.id ?? cryptoRandomId(),
      projectId: params.projectId,
      userId: params.userId,
      sessionId: params.sessionId,
      kind: params.kind,
      title: params.title,
      source: params.source,
      status: params.status ?? "pending",
      documentId: params.documentId,
      contentHash: params.contentHash,
      metadata: params.metadata ?? {},
      createdAt: now,
      updatedAt: now
    };
    this.db
      .prepare(
        `INSERT INTO collected_items (id, project_id, user_id, session_id, kind, title, source, status, document_id, content_hash, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(item.id, item.projectId, item.userId ?? null, item.sessionId ?? null, item.kind, item.title, item.source ?? null, item.status, item.documentId ?? null, item.contentHash ?? null, JSON.stringify(item.metadata), item.createdAt, item.updatedAt);
    return item;
  }

  updateCollectedItem(params: { id: string; status?: CollectedItem["status"]; documentId?: string; contentHash?: string; metadata?: Record<string, unknown> }): CollectedItem | undefined {
    const existing = this.getCollectedItem(params.id);
    if (!existing) return undefined;
    const metadata = params.metadata ? { ...existing.metadata, ...params.metadata } : existing.metadata;
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE collected_items
         SET status = COALESCE(?, status), document_id = COALESCE(?, document_id), content_hash = COALESCE(?, content_hash), metadata_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(params.status ?? null, params.documentId ?? null, params.contentHash ?? null, JSON.stringify(metadata), updatedAt, params.id);
    return this.getCollectedItem(params.id);
  }

  getCollectedItem(id: string): CollectedItem | undefined {
    const row = this.db.prepare("SELECT * FROM collected_items WHERE id = ?").get(id) as CollectedItemRow | undefined;
    return row ? mapCollectedItem(row) : undefined;
  }

  listCollectedItems(params: { projectId: string; userId?: string; limit?: number; offset?: number; status?: CollectedItem["status"] }): CollectedItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM collected_items
         WHERE project_id = ?
           AND (? IS NULL OR user_id IS NULL OR user_id = ?)
           AND (? IS NULL OR status = ?)
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(params.projectId, params.userId ?? null, params.userId ?? null, params.status ?? null, params.status ?? null, params.limit ?? 30, params.offset ?? 0) as unknown as CollectedItemRow[];
    return rows.map(mapCollectedItem);
  }

  insertRouteLog(context: RequestContext, routePlan: RoutePlan): void {
    this.db
      .prepare(
        `INSERT INTO route_logs (id, session_id, project_id, user_message, route_plan_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        context.requestId,
        context.sessionId,
        context.projectId,
        context.message,
        JSON.stringify(routePlan),
        context.createdAt
      );
  }


  createRun(params: {
    id: string;
    sessionId: string;
    projectId: string;
    userMessage: string;
    status: RunStatus;
    createdAt: string;
    updatedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, project_id, user_message, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.id,
        params.sessionId,
        params.projectId,
        params.userMessage,
        params.status,
        params.createdAt,
        params.updatedAt
      );
  }

  updateRunStatus(id: string, status: RunStatus, updatedAt = new Date().toISOString()): void {
    this.db.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`).run(status, updatedAt, id);
  }

  insertRunStep(params: {
    id: string;
    runId: string;
    stepName: RunStepName;
    status: RunStepStatus;
    visibleMessage?: string;
    debug?: Record<string, unknown>;
    startedAt?: string;
    endedAt?: string;
    error?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_steps (id, run_id, step_name, status, visible_message, debug_json, started_at, ended_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.id,
        params.runId,
        params.stepName,
        params.status,
        params.visibleMessage ?? null,
        JSON.stringify(params.debug ?? {}),
        params.startedAt ?? null,
        params.endedAt ?? null,
        params.error ?? null
      );
  }

  updateRunStep(
    id: string,
    params: {
      status?: RunStepStatus;
      visibleMessage?: string;
      debug?: Record<string, unknown>;
      startedAt?: string;
      endedAt?: string;
      error?: string;
    }
  ): void {
    const existing = this.db.prepare(`SELECT debug_json FROM run_steps WHERE id = ?`).get(id) as
      | { debug_json: string }
      | undefined;
    if (!existing) {
      return;
    }

    const currentDebug = safeParseRecord(existing.debug_json);
    const nextDebug = params.debug ? { ...currentDebug, ...params.debug } : currentDebug;
    this.db
      .prepare(
        `UPDATE run_steps
         SET status = COALESCE(?, status),
             visible_message = COALESCE(?, visible_message),
             debug_json = ?,
             started_at = COALESCE(?, started_at),
             ended_at = COALESCE(?, ended_at),
             error = COALESCE(?, error)
         WHERE id = ?`
      )
      .run(
        params.status ?? null,
        params.visibleMessage ?? null,
        JSON.stringify(nextDebug),
        params.startedAt ?? null,
        params.endedAt ?? null,
        params.error ?? null,
        id
      );
  }

  insertRunEvent(params: {
    id: string;
    runId: string;
    eventType: string;
    visibleMessage?: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO run_events (id, run_id, event_type, visible_message, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.id,
        params.runId,
        params.eventType,
        params.visibleMessage ?? null,
        JSON.stringify(params.payload),
        params.createdAt
      );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id, chunk_index);

      CREATE TABLE IF NOT EXISTS document_tags (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, normalized_name)
      );

      CREATE TABLE IF NOT EXISTS document_tag_links (
        document_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (document_id, tag_id),
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES document_tags(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_document_tags_project_name ON document_tags(project_id, normalized_name);
      CREATE INDEX IF NOT EXISTS idx_document_tag_links_document ON document_tag_links(document_id);
      CREATE INDEX IF NOT EXISTS idx_document_tag_links_tag ON document_tag_links(tag_id);

      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        last_message_preview TEXT,
        last_message_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_sessions_project_updated ON conversation_sessions(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_sessions_user_updated ON conversation_sessions(user_id, updated_at);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT DEFAULT 'text',
        metadata_json TEXT DEFAULT '{}',
        token_estimate INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON conversation_messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        user_id TEXT,
        from_message_id TEXT NOT NULL,
        to_message_id TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        summary_json TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        model TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_summaries_session ON conversation_summaries(session_id, updated_at);

      CREATE TABLE IF NOT EXISTS session_requirement_memory (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        user_id TEXT,
        core_question TEXT NOT NULL,
        current_understanding TEXT NOT NULL,
        details_json TEXT NOT NULL,
        open_questions_json TEXT NOT NULL,
        first_user_message_id TEXT,
        last_user_message_id TEXT,
        last_assistant_message_id TEXT,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_requirement_project_updated ON session_requirement_memory(project_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_session_requirement_user_updated ON session_requirement_memory(user_id, updated_at);

      CREATE TABLE IF NOT EXISTS collected_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT,
        session_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT,
        status TEXT NOT NULL,
        document_id TEXT,
        content_hash TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_collected_items_project_updated ON collected_items(project_id, updated_at);

      CREATE TABLE IF NOT EXISTS session_state (
        session_id TEXT PRIMARY KEY,
        current_document_id TEXT,
        current_document_title TEXT,
        current_document_source TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        user_id TEXT,
        project_id TEXT NOT NULL,
        session_id TEXT,
        document_id TEXT,
        title TEXT,
        source TEXT,
        content TEXT NOT NULL,
        summary TEXT,
        entities_json TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        score REAL NOT NULL,
        hit_count INTEGER NOT NULL,
        last_hit_at TEXT,
        last_decay_at TEXT,
        is_pinned INTEGER NOT NULL,
        is_deleted INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_project_kind ON memory_items(project_id, kind);
      CREATE INDEX IF NOT EXISTS idx_memory_document ON memory_items(document_id);
      CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_items(user_id);
      CREATE INDEX IF NOT EXISTS idx_memory_deleted_score ON memory_items(is_deleted, score);

      CREATE TABLE IF NOT EXISTS route_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        user_message TEXT NOT NULL,
        route_plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        user_message TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        status TEXT NOT NULL,
        visible_message TEXT,
        debug_json TEXT,
        started_at TEXT,
        ended_at TEXT,
        error TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        visible_message TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, created_at);
    `);
    this.addColumnIfMissing("conversation_messages", "run_id", "TEXT");
    this.addColumnIfMissing("conversation_messages", "content_type", "TEXT DEFAULT 'text'");
    this.addColumnIfMissing("conversation_messages", "metadata_json", "TEXT DEFAULT '{}'");
    this.addColumnIfMissing("conversation_messages", "token_estimate", "INTEGER DEFAULT 0");
    this.addColumnIfMissing("documents", "updated_at", "TEXT");
    this.db.exec("UPDATE documents SET updated_at = created_at WHERE updated_at IS NULL;");
    this.backfillConversationSessions();
  }

  private backfillConversationSessions(): void {
    try {
      this.db.exec(`
        INSERT OR IGNORE INTO conversation_sessions (id, user_id, project_id, title, status, message_count, last_message_preview, last_message_at, created_at, updated_at, archived_at)
        SELECT
          session_id,
          NULL,
          'default',
          COALESCE(substr((SELECT content FROM conversation_messages cm2 WHERE cm2.session_id = cm.session_id AND cm2.role = 'user' ORDER BY created_at ASC LIMIT 1), 1, 30), '历史对话'),
          'active',
          COUNT(*),
          substr((SELECT content FROM conversation_messages cm3 WHERE cm3.session_id = cm.session_id ORDER BY created_at DESC LIMIT 1), 1, 120),
          MAX(created_at),
          MIN(created_at),
          MAX(created_at),
          NULL
        FROM conversation_messages cm
        GROUP BY session_id
      `);
    } catch {
      // Best-effort backfill for databases created before conversation_sessions existed.
    }
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!rows.some((row) => row.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    } catch {
      // Best-effort compatibility migration for older SQLite files.
    }
  }
}


interface ConversationSessionRow {
  id: string;
  user_id: string | null;
  project_id: string;
  title: string;
  status: ConversationSession["status"];
  message_count: number;
  last_message_preview: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ConversationMessageRow {
  id: string;
  session_id: string;
  run_id: string | null;
  role: ConversationMessage["role"];
  content: string;
  content_type: ConversationMessage["contentType"] | null;
  metadata_json: string | null;
  token_estimate: number | null;
  created_at: string;
}

interface ConversationSummaryRow {
  id: string;
  session_id: string;
  project_id: string;
  user_id: string | null;
  from_message_id: string;
  to_message_id: string;
  message_count: number;
  summary_json: string;
  summary_text: string;
  model: string;
  token_estimate: number;
  created_at: string;
  updated_at: string;
}

interface SessionRequirementMemoryRow {
  id: string;
  session_id: string;
  project_id: string;
  user_id: string | null;
  core_question: string;
  current_understanding: string;
  details_json: string;
  open_questions_json: string;
  first_user_message_id: string | null;
  last_user_message_id: string | null;
  last_assistant_message_id: string | null;
  model: string;
  created_at: string;
  updated_at: string;
}

interface CollectedItemRow {
  id: string;
  project_id: string;
  user_id: string | null;
  session_id: string | null;
  kind: CollectedItemKind;
  title: string;
  source: string | null;
  status: CollectedItem["status"];
  document_id: string | null;
  content_hash: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface DocumentRow {
  id: string;
  title: string;
  source: string | null;
  project_id: string;
  content: string;
  metadata_json: string;
  created_at: string;
  updated_at: string | null;
}

interface DocumentTagRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentTagLinkJoinRow {
  document_id: string;
  tag_id: string;
  name: string;
  project_id: string;
  confidence: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionStateRow {
  session_id: string;
  current_document_id: string | null;
  current_document_title: string | null;
  current_document_source: string | null;
  updated_at: string;
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  created_at: string;
}

interface MemoryRow {
  id: string;
  kind: MemoryItem["kind"];
  user_id: string | null;
  project_id: string;
  session_id: string | null;
  document_id: string | null;
  title: string | null;
  source: string | null;
  content: string;
  summary: string | null;
  entities_json: string;
  topics_json: string;
  metadata_json: string;
  score: number;
  hit_count: number;
  last_hit_at: string | null;
  last_decay_at: string | null;
  is_pinned: number;
  is_deleted: number;
  created_at: string;
  updated_at: string;
}

interface ChunkJoinRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  created_at: string;
  title: string;
  source: string | null;
  project_id: string;
}


function mapConversationSession(row: ConversationSessionRow): ConversationSession {
  return {
    id: row.id,
    userId: row.user_id ?? undefined,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    messageCount: row.message_count,
    lastMessagePreview: row.last_message_preview ?? undefined,
    lastMessageAt: row.last_message_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined
  };
}

function mapConversationMessage(row: ConversationMessageRow): ConversationMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    role: row.role,
    content: row.content,
    contentType: row.content_type ?? "text",
    metadata: safeParseRecord(row.metadata_json),
    tokenEstimate: row.token_estimate ?? estimateTokens(row.content),
    createdAt: row.created_at
  };
}

function mapConversationSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    userId: row.user_id ?? undefined,
    fromMessageId: row.from_message_id,
    toMessageId: row.to_message_id,
    messageCount: row.message_count,
    summaryJson: safeParseCompressedContext(row.summary_json),
    summaryText: row.summary_text,
    model: row.model,
    tokenEstimate: row.token_estimate,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSessionRequirementMemory(row: SessionRequirementMemoryRow): SessionRequirementMemory {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    userId: row.user_id ?? undefined,
    coreQuestion: row.core_question,
    currentUnderstanding: row.current_understanding,
    details: safeParseStringArray(row.details_json),
    openQuestions: safeParseStringArray(row.open_questions_json),
    firstUserMessageId: row.first_user_message_id ?? undefined,
    lastUserMessageId: row.last_user_message_id ?? undefined,
    lastAssistantMessageId: row.last_assistant_message_id ?? undefined,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCollectedItem(row: CollectedItemRow): CollectedItem {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    kind: row.kind,
    title: row.title,
    source: row.source ?? undefined,
    status: row.status,
    documentId: row.document_id ?? undefined,
    contentHash: row.content_hash ?? undefined,
    metadata: safeParseRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function cryptoRandomId(): string {
  return randomUUID();
}

function normalizeTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, 80) : "新对话";
}

function titleFromMessage(message: string): string {
  return normalizeTitle(message.slice(0, 30));
}

function previewText(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 120);
}

function safeParseCompressedContext(value: string | null): ConversationCompressedContext {
  const parsed = safeParseRecord(value);
  return {
    userGoals: toStringArray(parsed.userGoals),
    facts: toStringArray(parsed.facts),
    decisions: toStringArray(parsed.decisions),
    openQuestions: toStringArray(parsed.openQuestions),
    referencedDocuments: Array.isArray(parsed.referencedDocuments)
      ? parsed.referencedDocuments
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
          .map((item) => ({
            documentId: typeof item.documentId === "string" ? item.documentId : undefined,
            title: typeof item.title === "string" ? item.title : undefined,
            source: typeof item.source === "string" ? item.source : undefined,
            reason: typeof item.reason === "string" ? item.reason : ""
          }))
      : [],
    userPreferences: toStringArray(parsed.userPreferences),
    corrections: toStringArray(parsed.corrections),
    workflowResults: toStringArray(parsed.workflowResults),
    importantMessages: Array.isArray(parsed.importantMessages)
      ? parsed.importantMessages
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
          .map((item) => ({
            role: item.role === "assistant" || item.role === "system" ? item.role : "user",
            content: typeof item.content === "string" ? item.content : "",
            reason: typeof item.reason === "string" ? item.reason : ""
          }))
      : []
  };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapSessionState(row: SessionStateRow): SessionState {
  return {
    sessionId: row.session_id,
    currentDocumentId: row.current_document_id ?? undefined,
    currentDocumentTitle: row.current_document_title ?? undefined,
    currentDocumentSource: row.current_document_source ?? undefined,
    updatedAt: row.updated_at
  };
}

function mapDocument(row: DocumentRow): StoredDocument {
  const metadata = safeParseRecord(row.metadata_json);
  return {
    id: row.id,
    title: row.title,
    source: row.source ?? undefined,
    projectId: row.project_id,
    content: row.content,
    metadata,
    tags: tagsFromMetadata(metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at
  };
}

function mapDocumentTag(row: DocumentTagRow): DocumentTag {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDocumentTagAssignment(row: DocumentTagLinkJoinRow): DocumentTagAssignment {
  return {
    documentId: row.document_id,
    tagId: row.tag_id,
    name: row.name,
    projectId: row.project_id,
    confidence: row.confidence,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapChunkEvidence(row: ChunkJoinRow, score: number): EvidenceItem {
  return {
    chunkId: row.id,
    documentId: row.document_id,
    projectId: row.project_id,
    title: row.title,
    source: row.source ?? undefined,
    content: row.content,
    score,
    chunkIndex: row.chunk_index
  };
}

function keywordScore(row: ChunkJoinRow, terms: string[]): number {
  const haystack = `${row.title}
${row.source ?? ""}
${row.content}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}


function mapChunk(row: ChunkRow): StoredChunk {
  return { id: row.id, documentId: row.document_id, chunkIndex: row.chunk_index, content: row.content, createdAt: row.created_at };
}

function mapMemoryItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    kind: row.kind,
    userId: row.user_id ?? undefined,
    projectId: row.project_id,
    sessionId: row.session_id ?? undefined,
    documentId: row.document_id ?? undefined,
    title: row.title ?? undefined,
    source: row.source ?? undefined,
    content: row.content,
    summary: row.summary ?? undefined,
    entities: safeParseStringArray(row.entities_json),
    topics: safeParseStringArray(row.topics_json),
    metadata: safeParseRecord(row.metadata_json),
    score: row.score,
    hitCount: row.hit_count,
    lastHitAt: row.last_hit_at ?? undefined,
    lastDecayAt: row.last_decay_at ?? undefined,
    isPinned: row.is_pinned === 1,
    isDeleted: row.is_deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function memoryItemToHit(item: MemoryItem, vectorScore: number, reason: string): MemoryHit {
  return {
    memoryId: item.id,
    kind: item.kind,
    projectId: item.projectId,
    userId: item.userId,
    sessionId: item.sessionId,
    documentId: item.documentId,
    title: item.title,
    source: item.source,
    content: item.content,
    summary: item.summary,
    entities: item.entities,
    topics: item.topics,
    score: item.score,
    vectorScore,
    hitCount: item.hitCount,
    reason
  };
}

function keywordScoreMemory(row: MemoryRow, terms: string[]): number {
  const haystack = `${row.title ?? ""} ${row.source ?? ""} ${row.content} ${row.summary ?? ""} ${row.entities_json} ${row.topics_json}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function documentKeywordScore(row: DocumentRow, terms: string[]): number {
  const haystack = `${row.title} ${row.source ?? ""} ${row.content} ${row.metadata_json}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function normalizeTagName(name: string): string {
  return name.replace(/\s+/g, " ").trim().replace(/^#/, "").slice(0, 40);
}

function normalizeTagKey(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

function dedupeTagSuggestions(suggestions: DocumentTagSuggestion[]): DocumentTagSuggestion[] {
  const byKey = new Map<string, DocumentTagSuggestion>();
  for (const suggestion of suggestions) {
    const name = normalizeTagName(suggestion.name);
    if (!name) continue;
    const key = normalizeTagKey(name);
    const normalized = { ...suggestion, name, confidence: clampConfidence(suggestion.confidence) };
    const existing = byKey.get(key);
    if (!existing || normalized.confidence > existing.confidence) {
      byKey.set(key, normalized);
    }
  }
  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 12);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.65;
  return Math.min(1, Math.max(0, value));
}

function tagsFromMetadata(metadata?: Record<string, unknown>): string[] {
  const value = metadata?.tags;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function safeParseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function safeParseRecord(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
