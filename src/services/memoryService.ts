import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import type { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import type { LanceVectorStore } from "../storage/lanceVectorStore.js";
import type { SqliteStore } from "../storage/sqliteStore.js";
import type { MemoryHit, MemoryItem } from "../types.js";

export class MemoryService {
  constructor(
    private readonly sqlite: SqliteStore,
    private readonly vectors: LanceVectorStore,
    private readonly ai: OpenAiCompatibleClient,
    private readonly config: AppConfig
  ) {}

  async createDocumentAnchorMemory(params: {
    userId?: string;
    projectId: string;
    sessionId?: string;
    documentId: string;
    title: string;
    source?: string;
    contentSample: string;
  }): Promise<MemoryItem> {
    const now = new Date().toISOString();
    const extracted = extractEntitiesAndTopics(`${params.title}\n${params.contentSample}`);
    const content = `用户保存了文档《${params.title}》，documentId=${params.documentId}，来源=${params.source ?? "local"}，主题包括${extracted.topics.join("、") || "未提取"}。`;
    const item: MemoryItem = {
      id: randomUUID(),
      kind: "document_anchor",
      userId: params.userId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      documentId: params.documentId,
      title: params.title,
      source: params.source,
      content,
      summary: params.contentSample.slice(0, 500),
      entities: extracted.entities,
      topics: extracted.topics,
      metadata: { documentId: params.documentId, source: params.source },
      score: this.config.memory.defaultScore,
      hitCount: 0,
      isPinned: false,
      isDeleted: false,
      createdAt: now,
      updatedAt: now
    };
    this.sqlite.insertMemoryItem(item);

    if (this.ai.canEmbed()) {
      const vector = await this.ai.embed(`${content}\n${item.summary ?? ""}\n${item.entities.join(" ")} ${item.topics.join(" ")}`);
      await this.vectors.addRecords(this.config.lanceDbMemoryTable, [
        {
          id: item.id,
          memoryId: item.id,
          kind: item.kind,
          projectId: item.projectId,
          userId: item.userId ?? "",
          sessionId: item.sessionId ?? "",
          documentId: item.documentId ?? "",
          title: item.title ?? "",
          source: item.source ?? "",
          text: item.content,
          vector
        }
      ]);
    }

    return item;
  }

  async search(params: { query: string; projectId: string; userId?: string; limit?: number }): Promise<MemoryHit[]> {
    const limit = params.limit ?? 6;
    const [vectorResult, keywordResult] = await Promise.allSettled([
      this.searchVector(params),
      Promise.resolve(this.sqlite.searchMemoryKeyword(params))
    ]);
    const rawHits = [
      ...(vectorResult.status === "fulfilled" ? vectorResult.value : []),
      ...(keywordResult.status === "fulfilled" ? keywordResult.value : [])
    ];

    const byId = new Map<string, MemoryHit>();
    for (const hit of rawHits) {
      const existing = byId.get(hit.memoryId);
      if (!existing || rankScore(hit) > rankScore(existing)) {
        byId.set(hit.memoryId, hit);
      }
    }

    const latestItems = this.sqlite.listMemoryItemsByIds([...byId.keys()]);
    const latestById = new Map(latestItems.map((item) => [item.id, item]));
    const hits = [...byId.values()]
      .map((hit) => {
        const latest = latestById.get(hit.memoryId);
        if (!latest || latest.isDeleted) return undefined;
        return itemToHit(latest, hit.vectorScore, hit.reason);
      })
      .filter((hit): hit is MemoryHit => Boolean(hit))
      .sort((a, b) => rankScore(b) - rankScore(a))
      .slice(0, limit);

    for (const hit of hits) {
      this.sqlite.markMemoryHit(hit.memoryId, this.config.memory.hitBoost);
    }
    return hits;
  }

  async decay(): Promise<{ decayed: number; deleted: number }> {
    return this.sqlite.decayMemoryItems({
      decayAmount: this.config.memory.decayAmount,
      deleteThreshold: this.config.memory.deleteScoreThreshold,
      deleteAfterDays: this.config.memory.deleteAfterDays
    });
  }

  private async searchVector(params: { query: string; projectId: string; userId?: string; limit?: number }): Promise<MemoryHit[]> {
    if (!this.ai.canEmbed()) return [];
    const vector = await this.ai.embed(params.query);
    const rows = await this.vectors.search(this.config.lanceDbMemoryTable, {
      vector,
      projectId: params.projectId,
      userId: params.userId,
      limit: params.limit ?? 6
    });
    const ids = rows.map((row) => String(row.memoryId ?? row.id)).filter(Boolean);
    const items = this.sqlite.listMemoryItemsByIds(ids);
    const byId = new Map(items.map((item) => [item.id, item]));
    return rows
      .map((row) => {
        const id = String(row.memoryId ?? row.id);
        const item = byId.get(id);
        if (!item || item.isDeleted) return undefined;
        return itemToHit(item, Number(row._distance ?? row.distance ?? row.score ?? 0), "vector_memory_anchor");
      })
      .filter((hit): hit is MemoryHit => Boolean(hit));
  }
}

function itemToHit(item: MemoryItem, vectorScore: number, reason: string): MemoryHit {
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

function rankScore(hit: MemoryHit): number {
  return (hit.vectorScore ? 1 / (1 + Math.max(0, hit.vectorScore)) : 0) + hit.score + hit.hitCount * 0.25;
}

function extractEntitiesAndTopics(text: string): { entities: string[]; topics: string[] } {
  const chineseNames = text.match(/[\u4e00-\u9fa5]{2,8}/gu) ?? [];
  const latinTerms = text.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [];
  const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 2))];
  const entities = unique([...chineseNames.filter((value) => /[A-Z]|[\u4e00-\u9fa5]{2,4}/u.test(value)), ...latinTerms]).slice(0, 12);
  const topics = unique([...chineseNames, ...latinTerms].filter((value) => value.length >= 3)).slice(0, 10);
  return { entities, topics };
}
