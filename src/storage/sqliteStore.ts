import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvidenceItem, RequestContext, RoutePlan, StoredChunk, StoredDocument, StoredDocumentInput } from "../types.js";

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
        `INSERT INTO documents (id, title, source, project_id, content, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        document.id,
        document.title,
        document.source ?? null,
        document.projectId,
        document.content,
        JSON.stringify(document.metadata ?? {}),
        document.createdAt
      );

    return {
      id: document.id,
      title: document.title,
      source: document.source,
      projectId: document.projectId,
      content: document.content,
      metadata: document.metadata ?? {},
      createdAt: document.createdAt
    };
  }

  insertChunk(chunk: StoredChunk): void {
    this.db
      .prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, content, token_estimate, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(chunk.id, chunk.documentId, chunk.chunkIndex, chunk.content, estimateTokens(chunk.content), chunk.createdAt);
  }

  getDocument(documentId: string): StoredDocument | undefined {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId) as DocumentRow | undefined;
    return row ? mapDocument(row) : undefined;
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
    return rows.map(mapDocument);
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
           AND (d.title LIKE ? ESCAPE '\\' OR d.source LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\')
         ORDER BY d.created_at DESC, c.chunk_index ASC
         LIMIT ?`
      )
      .all(params.projectId, pattern, pattern, pattern, limit) as unknown as ChunkJoinRow[];

    return rows.map((row) => mapChunkEvidence(row, keywordScore(row, terms)));
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

  insertMessage(params: {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO conversation_messages (id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(params.id, params.sessionId, params.role, params.content, params.createdAt);
  }

  listSessionMessages(sessionId: string, limit = 12): Array<{ role: "user" | "assistant"; content: string }> {
    const rows = this.db
      .prepare(
        `SELECT role, content
         FROM conversation_messages
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(sessionId, limit) as Array<{ role: "user" | "assistant"; content: string }>;

    return rows.reverse();
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

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT,
        project_id TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON conversation_messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS route_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        user_message TEXT NOT NULL,
        route_plan_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }
}

interface DocumentRow {
  id: string;
  title: string;
  source: string | null;
  project_id: string;
  content: string;
  metadata_json: string;
  created_at: string;
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

function mapDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    title: row.title,
    source: row.source ?? undefined,
    projectId: row.project_id,
    content: row.content,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at
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
    score
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
