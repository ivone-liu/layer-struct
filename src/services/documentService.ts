import { randomUUID } from "node:crypto";
import { parseJsonObject } from "../ai/json.js";
import type { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import { LanceVectorStore } from "../storage/lanceVectorStore.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import type { AppConfig } from "../config/env.js";
import type { MemoryService } from "./memoryService.js";
import type { DocumentCandidate, DocumentTagAssignment, DocumentTagSuggestion, DocumentWriteProgressEvent, EvidencePack, MemoryHit, StoredChunk, StoredDocument, StoredDocumentInput, StoredDocumentUpdateInput } from "../types.js";

export class DocumentService {
  constructor(
    private readonly sqlite: SqliteStore,
    private readonly vectors: LanceVectorStore,
    private readonly ai: OpenAiCompatibleClient,
    private readonly config?: AppConfig,
    private readonly memory?: MemoryService
  ) {}

  async writeDocument(
    input: StoredDocumentInput,
    onProgress?: (event: DocumentWriteProgressEvent) => void | Promise<void>
  ): Promise<{ document: StoredDocument; chunkCount: number }> {
    const createdAt = new Date().toISOString();
    const documentId = randomUUID();
    const chunks = chunkText(input.content);
    const tagSuggestions = await this.generateDocumentTags({
      title: input.title,
      source: input.source,
      projectId: input.projectId,
      content: input.content,
      manualTags: input.tags
    });

    const document = this.sqlite.insertDocument({
      ...input,
      metadata: { ...(input.metadata ?? {}), tags: tagSuggestions.map((tag) => tag.name) },
      tags: tagSuggestions.map((tag) => tag.name),
      id: documentId,
      createdAt
    });
    await onProgress?.({ type: "document_created", documentId, title: input.title, chunkCount: chunks.length });

    const tags = this.sqlite.replaceDocumentTags(documentId, input.projectId, tagSuggestions);
    await onProgress?.({ type: "tags_generated", documentId, tags });

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
    try {
      await this.embedAndStoreChunks({ documentId, projectId: input.projectId, title: input.title, source: input.source, chunks: chunkRecords, onProgress });
    } catch (error) {
      throw new DocumentWriteFailure({
        phase: "embedding",
        documentId,
        title: input.title,
        chunkCount: chunks.length,
        cause: error
      });
    }
    await onProgress?.({ type: "vectors_written", documentId, vectorCount: chunkRecords.length });
    return { document: this.sqlite.getDocument(documentId) ?? { ...document, tags: tags.map((tag) => tag.name) }, chunkCount: chunks.length };
  }

  async updateDocument(
    input: StoredDocumentUpdateInput,
    onProgress?: (event: DocumentWriteProgressEvent) => void | Promise<void>
  ): Promise<{ document: StoredDocument; chunkCount: number; tags: DocumentTagAssignment[] }> {
    const existing = this.sqlite.getDocument(input.id);
    if (!existing) {
      throw new Error(`Document not found: ${input.id}`);
    }

    const updatedAt = new Date().toISOString();
    const nextTitle = input.title ?? existing.title;
    const nextSource = input.source === undefined ? existing.source : input.source ?? undefined;
    const nextProjectId = input.projectId ?? existing.projectId;
    const nextContent = input.content ?? existing.content;
    if (!nextContent.trim()) {
      throw new Error("Document content cannot be empty.");
    }

    const tagSuggestions = await this.generateDocumentTags({
      title: nextTitle,
      source: nextSource,
      projectId: nextProjectId,
      content: nextContent,
      manualTags: input.tags
    });
    const updated = this.sqlite.updateDocument({
      ...input,
      projectId: nextProjectId,
      metadata: { ...(input.metadata ?? {}), tags: tagSuggestions.map((tag) => tag.name) },
      updatedAt
    });
    if (!updated) {
      throw new Error(`Document not found: ${input.id}`);
    }

    const tags = this.sqlite.replaceDocumentTags(input.id, nextProjectId, tagSuggestions);
    await onProgress?.({ type: "tags_generated", documentId: input.id, tags });

    let chunkRecords = this.sqlite.listDocumentChunks({ documentId: input.id, limit: 100000 }).map((item) => ({
      id: item.chunkId,
      documentId: item.documentId,
      chunkIndex: item.chunkIndex ?? 0,
      content: item.content,
      createdAt: updatedAt
    }));

    const shouldRefreshVectors =
      input.content !== undefined || input.title !== undefined || input.source !== undefined || input.projectId !== undefined;

    if (input.content !== undefined) {
      const chunks = chunkText(nextContent);
      chunkRecords = chunks.map((content, index) => ({
        id: randomUUID(),
        documentId: input.id,
        chunkIndex: index,
        content,
        createdAt: updatedAt
      }));
      this.sqlite.replaceDocumentChunks(input.id, chunkRecords);
      await onProgress?.({ type: "chunks_created", documentId: input.id, chunkCount: chunkRecords.length });
    }

    if (shouldRefreshVectors) {
      await onProgress?.({ type: "embedding_started", documentId: input.id, chunkCount: chunkRecords.length });
      try {
        await this.vectors.deleteDocumentChunks(input.id);
        await this.embedAndStoreChunks({ documentId: input.id, projectId: nextProjectId, title: nextTitle, source: nextSource, chunks: chunkRecords, onProgress });
      } catch (error) {
        throw new DocumentWriteFailure({
          phase: "embedding",
          documentId: input.id,
          title: nextTitle,
          chunkCount: chunkRecords.length,
          cause: error
        });
      }
      await onProgress?.({ type: "vectors_written", documentId: input.id, vectorCount: chunkRecords.length });
    }

    await onProgress?.({ type: "document_updated", documentId: input.id, title: nextTitle, chunkCount: chunkRecords.length });
    return { document: this.sqlite.getDocument(input.id) ?? updated, chunkCount: chunkRecords.length, tags };
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

    return this.expandEvidencePack({
      query: params.query,
      skillId: "skill.lancedb_query",
      items,
      retrievalSources: ["document_chunks"]
    });
  }

  async searchSqlite(params: { query: string; projectId: string; limit?: number }): Promise<EvidencePack> {
    return this.expandEvidencePack({
      query: params.query,
      skillId: "skill.sqlite_query",
      items: this.sqlite.searchChunks(params),
      retrievalSources: ["sqlite_chunks"]
    });
  }

  async searchDocumentChunks(params: { documentId: string; query: string; limit?: number }): Promise<EvidencePack> {
    return this.expandEvidencePack({
      query: params.query,
      skillId: "skill.sqlite_query",
      items: this.sqlite.searchDocumentChunks(params),
      retrievalSources: ["sqlite_document_chunks"]
    });
  }

  async listDocumentChunks(params: { documentId: string; limit?: number }): Promise<EvidencePack> {
    return this.expandEvidencePack({
      query: `document:${params.documentId}`,
      skillId: "skill.sqlite_query",
      items: this.sqlite.listDocumentChunks(params),
      retrievalSources: ["sqlite_document_chunks"]
    });
  }

  searchDocuments(params: { query: string; projectId: string; limit?: number }): DocumentCandidate[] {
    return this.sqlite.searchDocuments(params);
  }

  async searchMemory(params: { query: string; projectId: string; userId?: string; limit?: number }): Promise<MemoryHit[]> {
    return this.memory?.search(params) ?? [];
  }

  async expandEvidencePack(evidencePack: EvidencePack, window = this.config?.evidenceContextWindow ?? 1): Promise<EvidencePack> {
    if (evidencePack.expandedItems) {
      return evidencePack;
    }
    return {
      ...evidencePack,
      expandedItems: this.sqlite.expandEvidenceItems(evidencePack.items, window)
    };
  }

  private async embedAndStoreChunks(params: {
    documentId: string;
    projectId: string;
    title: string;
    source?: string;
    chunks: StoredChunk[];
    onProgress?: (event: DocumentWriteProgressEvent) => void | Promise<void>;
  }): Promise<void> {
    const vectorRecords = [];
    const progressInterval = embeddingProgressInterval(params.chunks.length);
    for (const [index, chunk] of params.chunks.entries()) {
      const vector = await this.ai.embed(chunk.content);
      vectorRecords.push({
        id: chunk.id,
        chunkId: chunk.id,
        documentId: params.documentId,
        projectId: params.projectId,
        title: params.title,
        source: params.source ?? "",
        text: chunk.content,
        chunkIndex: chunk.chunkIndex,
        vector
      });

      const completed = index + 1;
      if (completed === params.chunks.length || completed % progressInterval === 0) {
        await params.onProgress?.({ type: "embedding_progress", documentId: params.documentId, completed, total: params.chunks.length });
      }
    }
    await this.vectors.addChunks(vectorRecords);
  }

  private async generateDocumentTags(params: {
    title: string;
    source?: string;
    projectId: string;
    content: string;
    manualTags?: string[];
  }): Promise<DocumentTagSuggestion[]> {
    const manual = normalizeTagSuggestions((params.manualTags ?? []).map((name) => ({ name, confidence: 1, reason: "用户指定标签" })));
    const model = this.config?.ai.compressorModel || this.config?.ai.routerModel || this.config?.ai.chatModel;
    if (!model || !this.ai.canChat(model)) {
      return normalizeTagSuggestions([...manual, ...fallbackTagSuggestions(params)]).slice(0, 8);
    }

    try {
      const raw = await this.ai.chat({
        model,
        temperature: 0.1,
        jsonMode: true,
        messages: [
          {
            role: "system",
            content:
              "你是资料标签归档模型。请基于标题、来源和正文内容推理最适合后续数据关联的标签。只输出 JSON：{\"tags\":[{\"name\":\"标签名\",\"confidence\":0.0,\"reason\":\"简短依据\"}]}。要求：4 到 8 个标签；优先中文短标签；避免“文章”“资料”“文本”等泛化词；覆盖主题、领域、关键实体、任务意图或场景。"
          },
          {
            role: "user",
            content: [
              `projectId: ${params.projectId}`,
              `title: ${params.title}`,
              `source: ${params.source ?? "local"}`,
              "content:",
              params.content.slice(0, 8000)
            ].join("\n")
          }
        ]
      });
      const parsed = parseJsonObject<{ tags?: Array<{ name?: unknown; confidence?: unknown; reason?: unknown }> }>(raw);
      const modelTags = (parsed.tags ?? [])
        .map((tag) => ({
          name: typeof tag.name === "string" ? tag.name : "",
          confidence: typeof tag.confidence === "number" ? tag.confidence : Number(tag.confidence ?? 0.75),
          reason: typeof tag.reason === "string" ? tag.reason : undefined
        }));
      return normalizeTagSuggestions([...manual, ...modelTags, ...fallbackTagSuggestions(params)]).slice(0, 8);
    } catch {
      return normalizeTagSuggestions([...manual, ...fallbackTagSuggestions(params)]).slice(0, 8);
    }
  }
}

export class DocumentWriteFailure extends Error {
  readonly phase: "embedding" | "vector_write";
  readonly documentId: string;
  readonly title: string;
  readonly chunkCount: number;

  constructor(params: {
    phase: "embedding" | "vector_write";
    documentId: string;
    title: string;
    chunkCount: number;
    cause: unknown;
  }) {
    const detail = params.cause instanceof Error ? params.cause.message : String(params.cause);
    const phaseLabel = params.phase === "embedding" ? "向量生成" : "向量写入";
    super(`${phaseLabel}失败；SQLite 文档和 chunks 已写入。documentId=${params.documentId}，chunkCount=${params.chunkCount}。原因：${detail}`);
    this.name = "DocumentWriteFailure";
    this.phase = params.phase;
    this.documentId = params.documentId;
    this.title = params.title;
    this.chunkCount = params.chunkCount;
    this.cause = params.cause;
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

function fallbackTagSuggestions(params: { title: string; source?: string; content: string }): DocumentTagSuggestion[] {
  const text = `${params.title}\n${params.source ?? ""}\n${params.content.slice(0, 4000)}`;
  const chineseTerms = text.match(/[\u4e00-\u9fa5]{2,8}/gu) ?? [];
  const latinTerms = text.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const term of [...chineseTerms, ...latinTerms]) {
    const name = normalizeTagName(term);
    if (!name || isWeakTag(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({
      name,
      confidence: Math.min(0.85, 0.55 + count * 0.05),
      reason: "本地关键词兜底提取"
    }));
}

function normalizeTagSuggestions(suggestions: DocumentTagSuggestion[]): DocumentTagSuggestion[] {
  const byKey = new Map<string, DocumentTagSuggestion>();
  for (const suggestion of suggestions) {
    const name = normalizeTagName(suggestion.name);
    if (!name || isWeakTag(name)) continue;
    const key = name.toLowerCase();
    const confidence = clampConfidence(suggestion.confidence);
    const existing = byKey.get(key);
    if (!existing || confidence > existing.confidence) {
      byKey.set(key, { name, confidence, reason: suggestion.reason?.slice(0, 160) });
    }
  }
  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence);
}

function normalizeTagName(name: string): string {
  return name.replace(/^#/, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.75;
  }
  return Math.min(1, Math.max(0, value));
}

function isWeakTag(name: string): boolean {
  return /^(文章|资料|文本|内容|记录|文档|document|article|note)$/iu.test(name);
}
