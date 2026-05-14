import { randomUUID } from "node:crypto";
import type { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import { LanceVectorStore } from "../storage/lanceVectorStore.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import type { EvidencePack, StoredDocument, StoredDocumentInput } from "../types.js";

export class DocumentService {
  constructor(
    private readonly sqlite: SqliteStore,
    private readonly vectors: LanceVectorStore,
    private readonly ai: OpenAiCompatibleClient
  ) {}

  async writeDocument(input: StoredDocumentInput): Promise<{ document: StoredDocument; chunkCount: number }> {
    const createdAt = new Date().toISOString();
    const documentId = randomUUID();
    const chunks = chunkText(input.content);

    const document = this.sqlite.insertDocument({
      ...input,
      id: documentId,
      createdAt
    });

    const vectorRecords = [];
    for (const [index, content] of chunks.entries()) {
      const chunkId = randomUUID();
      this.sqlite.insertChunk({
        id: chunkId,
        documentId,
        chunkIndex: index,
        content,
        createdAt
      });

      const vector = await this.ai.embed(content);
      vectorRecords.push({
        id: chunkId,
        chunkId,
        documentId,
        projectId: input.projectId,
        title: input.title,
        source: input.source ?? "",
        text: content,
        vector
      });
    }

    await this.vectors.addChunks(vectorRecords);
    return { document, chunkCount: chunks.length };
  }

  async search(params: { query: string; projectId: string; limit?: number }): Promise<EvidencePack> {
    const vector = await this.ai.embed(params.query);
    const items = await this.vectors.search({
      vector,
      projectId: params.projectId,
      limit: params.limit
    });

    return {
      query: params.query,
      items
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
