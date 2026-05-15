import { createHash } from "node:crypto";
import type { DocumentService } from "./documentService.js";
import type { MemoryService } from "./memoryService.js";
import type { SqliteStore } from "../storage/sqliteStore.js";
import type { CollectedItem, CollectedItemKind, DocumentWriteProgressEvent, ExecutionResult } from "../types.js";

export class CollectedContentWorkflow {
  constructor(
    private readonly sqlite: SqliteStore,
    private readonly documents: DocumentService,
    private readonly memory: MemoryService
  ) {}

  async ingest(params: {
    userId?: string;
    sessionId?: string;
    projectId: string;
    kind: CollectedItemKind;
    title: string;
    source?: string;
    content: string;
    metadata?: Record<string, unknown>;
    onProgress?: (event: DocumentWriteProgressEvent | { type: "collected_item_created" | "collected_item_completed" | "collected_item_failed"; item: CollectedItem }) => void | Promise<void>;
  }): Promise<ExecutionResult> {
    const contentHash = createHash("sha256").update(params.content).digest("hex");
    const item = this.sqlite.createCollectedItem({
      projectId: params.projectId,
      userId: params.userId,
      sessionId: params.sessionId,
      kind: params.kind,
      title: params.title,
      source: params.source,
      status: "pending",
      contentHash,
      metadata: params.metadata
    });
    await params.onProgress?.({ type: "collected_item_created", item });

    try {
      this.sqlite.updateCollectedItem({ id: item.id, status: "processing" });
      const result = await this.documents.writeDocument(
        {
          title: params.title,
          source: params.source,
          projectId: params.projectId,
          content: params.content,
          metadata: { ...(params.metadata ?? {}), collectedItemId: item.id, kind: params.kind, sessionId: params.sessionId }
        },
        params.onProgress
      );
      const memory = await this.memory.createDocumentAnchorMemory({
        userId: params.userId,
        projectId: params.projectId,
        sessionId: params.sessionId,
        documentId: result.document.id,
        title: result.document.title,
        source: result.document.source,
        contentSample: result.document.content.slice(0, 1600)
      });
      if (params.sessionId) {
        this.sqlite.upsertSessionState({
          sessionId: params.sessionId,
          currentDocumentId: result.document.id,
          currentDocumentTitle: result.document.title,
          currentDocumentSource: result.document.source
        });
      }
      const completed = this.sqlite.updateCollectedItem({ id: item.id, status: "completed", documentId: result.document.id, contentHash }) ?? item;
      await params.onProgress?.({ type: "collected_item_completed", item: completed });
      return {
        status: "success",
        capabilityId: "workflow.ingest_collected_content",
        message: "采集内容已写入 documents/chunks、LanceDB，并创建 memory anchor。",
        output: {
          collectedItemId: item.id,
          documentId: result.document.id,
          memoryId: memory.id,
          title: result.document.title,
          source: result.document.source,
          chunkCount: result.chunkCount,
          memoryCreated: true
        }
      };
    } catch (error) {
      const failed = this.sqlite.updateCollectedItem({ id: item.id, status: "failed", metadata: { error: error instanceof Error ? error.message : String(error) } }) ?? item;
      await params.onProgress?.({ type: "collected_item_failed", item: failed });
      return {
        status: "failed",
        capabilityId: "workflow.ingest_collected_content",
        message: "采集内容入库失败。",
        output: { collectedItemId: item.id },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
