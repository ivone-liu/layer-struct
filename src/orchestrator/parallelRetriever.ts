import type { DocumentService } from "../services/documentService.js";
import type { MemoryService } from "../services/memoryService.js";
import type { DocumentCandidate, MemoryHit, RequestContext, RoutePlan } from "../types.js";

export interface RetrievalHints {
  memoryHits: MemoryHit[];
  documentCandidates: DocumentCandidate[];
  debug: Record<string, unknown>;
}

export class ParallelRetriever {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly documentService: DocumentService
  ) {}

  async searchHints(context: RequestContext, routePlan: RoutePlan): Promise<RetrievalHints> {
    const query = routePlan.resolvedQuery || routePlan.searchQueries[0] || context.message;
    const shouldSearchMemory = normalizeForCompare(query) !== normalizeForCompare(context.message);
    const [memoryResult, documentResult] = await Promise.allSettled([
      shouldSearchMemory ? this.memoryService.search({ query, projectId: context.projectId, userId: context.userId, limit: 6 }) : Promise.resolve([]),
      Promise.resolve(this.documentService.searchDocuments({ query, projectId: context.projectId, limit: 8 }))
    ]);

    return {
      memoryHits: memoryResult.status === "fulfilled" ? memoryResult.value : [],
      documentCandidates: documentResult.status === "fulfilled" ? documentResult.value : [],
      debug: {
        memoryError: memoryResult.status === "rejected" ? String(memoryResult.reason) : undefined,
        documentError: documentResult.status === "rejected" ? String(documentResult.reason) : undefined
      }
    };
  }
}


function normalizeForCompare(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
