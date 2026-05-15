import { mkdirSync } from "node:fs";
import type { EvidenceItem } from "../types.js";

interface LanceChunkRecord {
  id: string;
  chunkId: string;
  documentId: string;
  projectId: string;
  title: string;
  source: string;
  text: string;
  vector: number[];
}

interface LanceTable {
  add(records: LanceChunkRecord[]): Promise<void>;
  vectorSearch(vector: number[]): {
    limit(limit: number): { toArray(): Promise<Array<Record<string, unknown>>> };
    toArray(): Promise<Array<Record<string, unknown>>>;
  };
}

export class LanceVectorStore {
  constructor(
    private readonly uri: string,
    private readonly tableName: string
  ) {
    mkdirSync(uri, { recursive: true });
  }

  async addChunks(records: LanceChunkRecord[]): Promise<void> {
    if (records.length === 0) {
      return;
    }

    const db = await this.connect();
    const existing = await this.openTable(db);
    if (existing) {
      await existing.add(records);
      return;
    }

    await db.createTable(this.tableName, records);
  }

  async search(params: { vector: number[]; projectId: string; limit?: number }): Promise<EvidenceItem[]> {
    const db = await this.connect();
    const table = await this.openTable(db);
    if (!table) {
      return [];
    }

    const limit = params.limit ?? 6;
    const rows = (await table
      .vectorSearch(params.vector)
      .limit(limit * 4)
      .toArray()).filter((row) => String(row.projectId) === params.projectId).slice(0, limit);

    return rows.map((row) => ({
      chunkId: String(row.chunkId),
      documentId: String(row.documentId),
      projectId: String(row.projectId),
      title: String(row.title),
      source: optionalString(row.source),
      content: String(row.text),
      score: Number(row._distance ?? row.distance ?? row.score ?? 0)
    }));
  }

  private async connect(): Promise<LanceDatabase> {
    const lancedb = await import("@lancedb/lancedb");
    return lancedb.connect(this.uri) as unknown as Promise<LanceDatabase>;
  }

  private async openTable(db: LanceDatabase): Promise<LanceTable | undefined> {
    try {
      return (await db.openTable(this.tableName)) as LanceTable;
    } catch {
      return undefined;
    }
  }

}

interface LanceDatabase {
  openTable(name: string): Promise<unknown>;
  createTable(name: string, records: LanceChunkRecord[]): Promise<unknown>;
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : "";
  return text.length > 0 ? text : undefined;
}
