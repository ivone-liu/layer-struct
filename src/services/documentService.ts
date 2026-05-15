import { randomUUID } from "node:crypto";
import type { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import { LanceVectorStore } from "../storage/lanceVectorStore.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import type { DocumentWriteProgressEvent, EvidencePack, StoredDocument, StoredDocumentInput } from "../types.js";

export class DocumentService {
  constructor(
    private readonly sqlite: SqliteStore,
    private readonly vectors: LanceVectorStore,
    private readonly ai: OpenAiCompatibleClient
  ) {}

  async writeDocument(
    input: StoredDocumentInput,
    onProgress?: (event: DocumentWriteProgressEvent) => void | Promise<void>
  ): Promise<{ document: StoredDocument; chunkCount: number }> {
    const createdAt = new Date().toISOString();
    const documentId = randomUUID();
    const chunks = chunkText(input.content);

    const document = this.sqlite.insertDocument({
      ...input,
      id: documentId,
      createdAt
    });
    await onProgress?.({ type: "document_created", documentId, title: input.title, chunkCount: chunks.length });

    const chunkRecords = chunks.map((content, index) => ({
      id: randomUUID(),
      documentId,
      chunkIndex: index,
      content,
      createdAt
    }));

    for (const chunk of chunkRecords) {
      this.sqlite.insertChunk(chunk);
    }
    await onProgress?.({ type: "chunks_created", documentId, chunkCount: chunkRecords.length });

    await onProgress?.({ type: "embedding_started", documentId, chunkCount: chunkRecords.length });
    const vectorRecords = [];
    const progressInterval = embeddingProgressInterval(chunkRecords.length);
    for (const [index, chunk] of chunkRecords.entries()) {
      const vector = await this.ai.embed(chunk.content);
      vectorRecords.push({
        id: chunk.id,
        chunkId: chunk.id,
        documentId,
        projectId: input.projectId,
        title: input.title,
        source: input.source ?? "",
        text: chunk.content,
        vector
      });

      const completed = index + 1;
      if (completed === chunkRecords.length || completed % progressInterval === 0) {
        await onProgress?.({ type: "embedding_progress", documentId, completed, total: chunkRecords.length });
      }
    }

    await this.vectors.addChunks(vectorRecords);
    await onProgress?.({ type: "vectors_written", documentId, vectorCount: vectorRecords.length });
    return { document, chunkCount: chunks.length };
  }

  async search(params: { query: string; projectId: string; limit?: number; skillId?: string }): Promise<EvidencePack> {
    if (params.skillId === "skill.sqlite_query") {
      return this.searchSqlite(params);
    }

    return this.searchLanceDb(params);
  }

  async searchLanceDb(params: { query: string; projectId: string; limit?: number }): Promise<EvidencePack> {
    const vector = await this.ai.embed(params.query);
    const items = await this.vectors.search({
      vector,
      projectId: params.projectId,
      limit: params.limit
    });

    return {
      query: params.query,
      skillId: "skill.lancedb_query",
      items
    };
  }

  async searchSqlite(params: { query: string; projectId: string; limit?: number }): Promise<EvidencePack> {
    return {
      query: params.query,
      skillId: "skill.sqlite_query",
      items: this.sqlite.searchChunks(params)
    };
  }

  async searchDocumentChunks(params: { documentId: string; query: string; limit?: number }): Promise<EvidencePack> {
    return {
      query: params.query,
      skillId: "skill.sqlite_query",
      items: this.sqlite.searchDocumentChunks(params)
    };
  }

  async listDocumentChunks(params: { documentId: string; limit?: number }): Promise<EvidencePack> {
    return {
      query: `document:${params.documentId}`,
      skillId: "skill.sqlite_query",
      items: this.sqlite.listDocumentChunks(params)
    };
  }
}

export function chunkText(text: string, maxChars = 1200, overlapChars = 160): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = withOverlap(current, overlapChars);
    }

    if (paragraph.length <= maxChars) {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
      continue;
    }

    for (let index = 0; index < paragraph.length; index += maxChars - overlapChars) {
      chunks.push(paragraph.slice(index, index + maxChars));
    }
    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function withOverlap(text: string, overlapChars: number): string {
  if (text.length <= overlapChars) {
    return text;
  }
  return text.slice(text.length - overlapChars);
}

function embeddingProgressInterval(total: number): number {
  if (total <= 0) {
    return 1;
  }
  return Math.max(5, Math.ceil(total * 0.2));
}
