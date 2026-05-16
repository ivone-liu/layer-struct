import type { DocumentService } from "../services/documentService.js";
import type { RequestContext, SkillCall, SkillExecutionResult } from "../types.js";
import { McpClientManager } from "../mcp/clientManager.js";

export class SkillExecutor {
  constructor(
    private readonly documents: DocumentService,
    private readonly mcp = new McpClientManager()
  ) {}

  async execute(call: SkillCall, context: RequestContext): Promise<SkillExecutionResult> {
    try {
      if (call.skillId.startsWith("mcp.")) {
        return this.mcp.callTool(call, context);
      }

      if (call.skillId === "skill.lancedb_query") {
        const evidencePack = await this.documents.search({
          query: stringParam(call.params.query) || context.message,
          projectId: stringParam(call.params.projectId) || context.projectId,
          limit: numberParam(call.params.limit) ?? 6,
          skillId: "skill.lancedb_query"
        });
        return { callId: call.id, skillId: call.skillId, status: evidencePack.items.length > 0 ? "success" : "empty", evidencePack };
      }

      if (call.skillId === "skill.sqlite_query") {
        const documentId = stringParam(call.params.documentId);
        const query = stringParam(call.params.query) || context.message;
        const limit = numberParam(call.params.limit) ?? 8;
        const evidencePack = documentId
          ? await this.searchDocumentFirst(documentId, query, limit)
          : await this.documents.search({ query, projectId: context.projectId, limit, skillId: "skill.sqlite_query" });
        return { callId: call.id, skillId: call.skillId, status: evidencePack.items.length > 0 ? "success" : "empty", evidencePack };
      }

      return { callId: call.id, skillId: call.skillId, status: "skipped", error: `Unsupported skill: ${call.skillId}` };
    } catch (error) {
      return {
        callId: call.id,
        skillId: call.skillId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async searchDocumentFirst(documentId: string, query: string, limit: number) {
    const searched = await this.documents.searchDocumentChunks({ documentId, query, limit });
    if (searched.items.length > 0) {
      return searched;
    }
    return this.documents.listDocumentChunks({ documentId, limit });
  }
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
