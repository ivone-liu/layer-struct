import { mkdirSync } from "node:fs";
import type { EvidenceItem } from "../types.js";

export type LanceTableName = "document_chunks" | "memory_items" | "session_summaries" | "capability_index";

type LanceRecord = Record<string, unknown> & { vector: number[] };

interface LanceTable {
  delete?(predicate: string): Promise<void>;
  add(records: LanceRecord[]): Promise<void>;
  vectorSearch(vector: number[]): {
    limit(limit: number): { toArray(): Promise<Array<Record<string, unknown>>> };
    toArray(): Promise<Array<Record<string, unknown>>>;
  };
}

export class LanceVectorStore {
  constructor(
    private readonly uri: string,
    private readonly defaultTableName: string
  ) {
    mkdirSync(uri, { recursive: true });
  }

  async addRecords(tableName: string, records: LanceRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const db = await this.connect();
    const existing = await this.openTable(db, tableName);
    if (existing) {
      await existing.add(records);
      return;
    }

    await db.createTable(tableName, records);
  }

  async addChunks(records: Array<LanceRecord & { chunkId: string; documentId: string; projectId: string; title: string; text: string; chunkIndex: number }>): Promise<void> {
    await this.addRecords(this.defaultTableName, records);
  }

  async deleteDocumentChunks(documentId: string): Promise<void> {
    const db = await this.connect();
    const table = await this.openTable(db, this.defaultTableName);
    if (!table?.delete) {
      return;
    }
    await table.delete(`documentId = '${escapeLanceString(documentId)}'`);
  }

  async search(params: { vector: number[]; projectId: string; limit?: number }): Promise<EvidenceItem[]>;
  async search(tableName: string, params: { vector: number[]; projectId?: string; userId?: string; limit?: number; filter?: Record<string, unknown> }): Promise<Array<Record<string, unknown>>>;
  async search(
    tableNameOrParams: string | { vector: number[]; projectId: string; limit?: number },
    maybeParams?: { vector: number[]; projectId?: string; userId?: string; limit?: number; filter?: Record<string, unknown> }
  ): Promise<EvidenceItem[] | Array<Record<string, unknown>>> {
    if (typeof tableNameOrParams !== "string") {
      const rows = await this.searchRecords(this.defaultTableName, tableNameOrParams);
      return rows.map(mapDocumentChunkRow);
    }
    return this.searchRecords(tableNameOrParams, maybeParams ?? { vector: [], limit: 0 });
  }

  private async searchRecords(
    tableName: string,
    params: { vector: number[]; projectId?: string; userId?: string; limit?: number; filter?: Record<string, unknown> }
  ): Promise<Array<Record<string, unknown>>> {
    const db = await this.connect();
    const table = await this.openTable(db, tableName);
    if (!table || params.vector.length === 0) {
      return [];
    }

    const limit = params.limit ?? 6;
    const rows = await table.vectorSearch(params.vector).limit(limit * 4).toArray();
    return rows
      .filter((row) => matchesFilters(row, params))
      .slice(0, limit)
      .map((row) => ({ ...row, chunkIndex: parseOptionalNumber(row.chunkIndex) ?? parseOptionalNumber(row.chunk_index) }));
  }

  private async connect(): Promise<LanceDatabase> {
    const lancedb = await import("@lancedb/lancedb");
    return lancedb.connect(this.uri) as unknown as Promise<LanceDatabase>;
  }

  private async openTable(db: LanceDatabase, tableName: string): Promise<LanceTable | undefined> {
    try {
      return (await db.openTable(tableName)) as LanceTable;
    } catch {
      return undefined;
    }
  }
}

interface LanceDatabase {
  openTable(name: string): Promise<unknown>;
  createTable(name: string, records: LanceRecord[]): Promise<unknown>;
}

function matchesFilters(row: Record<string, unknown>, params: { projectId?: string; userId?: string; filter?: Record<string, unknown> }): boolean {
  if (params.projectId && String(row.projectId ?? row.project_id ?? "") !== params.projectId) {
    return false;
  }
  if (params.userId && String(row.userId ?? row.user_id ?? "") !== params.userId) {
    return false;
  }
  for (const [key, value] of Object.entries(params.filter ?? {})) {
    if (value !== undefined && String(row[key] ?? "") !== String(value)) {
      return false;
    }
  }
  return true;
}

function mapDocumentChunkRow(row: Record<string, unknown>): EvidenceItem {
  return {
    chunkId: String(row.chunkId ?? row.id),
    documentId: String(row.documentId),
    projectId: String(row.projectId),
    title: String(row.title ?? ""),
    source: optionalString(row.source),
    content: String(row.text ?? row.content ?? ""),
    score: Number(row._distance ?? row.distance ?? row.score ?? 0),
    chunkIndex: parseOptionalNumber(row.chunkIndex ?? row.chunk_index),
    centerChunk: true
  };
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  return text.length > 0 ? text : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function escapeLanceString(value: string): string {
  return value.replace(/'/g, "''");
}
