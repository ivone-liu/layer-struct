import type { SqliteStore } from "../storage/sqliteStore.js";
import type { DocumentCandidate, DocumentResolution, MemoryHit, RequestContext, RoutePlan, SessionState } from "../types.js";

export class DocumentResolver {
  constructor(private readonly sqlite: SqliteStore) {}

  resolve(params: {
    context: RequestContext;
    routePlan: RoutePlan;
    sessionState?: SessionState;
    memoryHits: MemoryHit[];
    documentCandidates: DocumentCandidate[];
  }): DocumentResolution {
    const { context, routePlan, sessionState, memoryHits, documentCandidates } = params;
    if (routePlan.targetDocumentId) {
      const doc = this.sqlite.getDocument(routePlan.targetDocumentId);
      if (doc) return resolved(doc.id, doc.title, doc.source, "routePlan.targetDocumentId", []);
    }

    if (sessionState?.currentDocumentId && mentionsCurrentDocument(context.message)) {
      const doc = this.sqlite.getDocument(sessionState.currentDocumentId);
      if (doc) return resolved(doc.id, doc.title, doc.source, "sessionState.currentDocumentId", []);
    }

    const memoryCandidates = memoryHits
      .filter((hit) => hit.kind === "document_anchor" && hit.documentId)
      .map((hit) => ({
        documentId: hit.documentId!,
        title: hit.title ?? hit.documentId!,
        source: hit.source,
        projectId: hit.projectId,
        score: hit.score + hit.hitCount * 0.25 + (hit.vectorScore ? 1 / (1 + Math.max(0, hit.vectorScore)) : 0),
        reason: `memory:${hit.reason}`
      }));

    const candidates = mergeCandidates([...memoryCandidates, ...documentCandidates]);
    if (candidates.length === 0) {
      const recent = this.sqlite.listRecentDocuments(5).filter((doc) => doc.projectId === context.projectId);
      if (recent.length === 1 && mentionsCurrentDocument(context.message)) return resolved(recent[0].id, recent[0].title, recent[0].source, "recent_document", []);
      return { status: "not_found", reason: "没有找到可定位的历史文档。", candidates: recent.map((doc, index) => ({ documentId: doc.id, title: doc.title, source: doc.source, projectId: doc.projectId, score: 1 - index * 0.1, reason: "recent_document" })) };
    }

    candidates.sort((a, b) => b.score - a.score);
    const [first, second] = candidates;
    if (second && Math.abs(first.score - second.score) <= 0.5) {
      return { status: "ambiguous", reason: "多个候选文档分数接近，需要用户选择。", candidates: candidates.slice(0, 5) };
    }
    const doc = this.sqlite.getDocument(first.documentId);
    return resolved(first.documentId, doc?.title ?? first.title, doc?.source ?? first.source, first.reason, candidates.slice(0, 5));
  }
}

function resolved(documentId: string, title: string, source: string | undefined, reason: string, candidates: DocumentCandidate[]): DocumentResolution {
  return { status: "resolved", documentId, title, source, reason, candidates };
}

function mergeCandidates(candidates: DocumentCandidate[]): DocumentCandidate[] {
  const byId = new Map<string, DocumentCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.documentId);
    if (!existing || candidate.score > existing.score) byId.set(candidate.documentId, candidate);
  }
  return [...byId.values()];
}

function mentionsCurrentDocument(message: string): boolean {
  return /(刚才那篇|这篇文章|上面那篇|刚才保存|刚才写入|刚才的文章|这篇)/iu.test(message);
}
