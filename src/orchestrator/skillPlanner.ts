import { randomUUID } from "node:crypto";
import type { CapabilityDefinition, DocumentResolution, MemoryHit, RequestContext, RoutePlan, SessionState, SkillCall, SkillPlan } from "../types.js";

export class SkillPlanner {
  plan(
    context: RequestContext,
    routePlan: RoutePlan,
    sessionState?: SessionState,
    _capabilities: CapabilityDefinition[] = [],
    documentResolution?: DocumentResolution,
    memoryHits: MemoryHit[] = []
  ): SkillPlan {
    if (routePlan.needsWorkflow || routePlan.taskType === "workflow") {
      return {
        answerStrategy: "workflow",
        calls: [],
        requiresEvidence: false,
        canAnswerWithoutSkill: true,
        rationale: "工作流请求交由现有 workflow 执行。"
      };
    }

    const message = context.message;
    const query = stringParam(routePlan.resolvedQuery) || stringParam(routePlan.extractedParams.query) || routePlan.searchQueries[0] || message;
    const mentionsCurrent = mentionsCurrentDocument(message);
    const citation = routePlan.answerStrategy === "citation" || isCitationRequest(message);
    const recentOrList = /(最近保存|刚才写入|列表|列出|标题|source|documentId|文档 ?id|来源)/iu.test(message);
    const semantic = /(核心观点|总结|提炼|类似观点|相似|语义|观点|详细展开)/iu.test(message);
    const requiresSavedData = Boolean(routePlan.requiresEvidence || routePlan.needsRag || routePlan.needsSkill || citation || mentionsCurrent || recentOrList);

    const calls: SkillCall[] = [];
    const addCall = (skillId: string, reason: string, params: Record<string, unknown>, required = true) => {
      if (calls.some((call) => call.skillId === skillId && JSON.stringify(call.params) === JSON.stringify(params))) {
        return;
      }
      calls.push({ id: randomUUID(), skillId, reason, params, required });
    };

    const mcpCapabilities = routePlan.candidateCapabilities.filter((capability) => capability.startsWith("mcp."));
    if (mcpCapabilities.length > 0) {
      for (const capability of mcpCapabilities) {
        addCall(capability, "Router 选择了外部 MCP 工具。", {
          query,
          ...routePlan.extractedParams
        });
      }
      return {
        answerStrategy: routePlan.answerStrategy ?? "multi_step",
        calls,
        requiresEvidence: Boolean(routePlan.requiresEvidence),
        canAnswerWithoutSkill: false,
        rationale: "识别到请求应由已注册 MCP 工具处理。"
      };
    }

    if (!requiresSavedData) {
      return {
        answerStrategy: "direct",
        calls: [],
        requiresEvidence: false,
        canAnswerWithoutSkill: true,
        rationale: "未识别到依赖已保存资料的需求，直接回答。"
      };
    }

    const memoryDocumentId = memoryHits.find((hit) => hit.kind === "document_anchor" && hit.documentId)?.documentId;
    const resolvedDocumentId = documentResolution?.status === "resolved" ? documentResolution.documentId : memoryDocumentId;
    const documentParams = resolvedDocumentId ? { documentId: resolvedDocumentId } : sessionState?.currentDocumentId ? { documentId: sessionState.currentDocumentId } : {};

    if (documentResolution?.status === "ambiguous") {
      return {
        answerStrategy: "direct",
        calls: [],
        requiresEvidence: false,
        canAnswerWithoutSkill: true,
        rationale: "多个 memory/document 候选分数接近，需要先让用户选择文档。"
      };
    }

    if (citation) {
      addCall("skill.sqlite_query", "用户需要原文段落或出处，需要精确读取本地文档/chunks", {
        query,
        limit: 8,
        ...documentParams
      });
      return {
        answerStrategy: "citation",
        calls,
        requiresEvidence: true,
        canAnswerWithoutSkill: false,
        rationale: "原文/引用类问题必须先取得可引用证据。"
      };
    }

    if ((mentionsCurrent && sessionState?.currentDocumentId) || resolvedDocumentId) {
      addCall("skill.sqlite_query", "用户指向刚才/这篇文章，先锁定并读取当前会话文档 chunks", {
        query,
        limit: 8,
        documentId: resolvedDocumentId ?? sessionState!.currentDocumentId
      });
      if (semantic) {
        addCall("skill.lancedb_query", "用户需要基于语义召回资料后总结", { query, projectId: context.projectId, limit: 6 }, false);
      }
      return {
        answerStrategy: semantic ? "rag" : routePlan.answerStrategy ?? "rag",
        calls,
        requiresEvidence: true,
        canAnswerWithoutSkill: false,
        rationale: "用户问题依赖当前会话锚定文档。"
      };
    }

    if (recentOrList || routePlan.candidateCapabilities.includes("skill.sqlite_query")) {
      addCall("skill.sqlite_query", "用户需要最近保存、标题、来源、documentId 或精确关键词查询", { query, projectId: context.projectId, limit: 8, ...documentParams });
    } else {
      if (resolvedDocumentId) {
        addCall("skill.sqlite_query", "memory/document resolver 已定位文档，先读取原文 chunks", { query, limit: 8, documentId: resolvedDocumentId });
        if (semantic) addCall("skill.lancedb_query", "语义召回作为补充，不作为原文引用依据", { query, projectId: context.projectId, limit: 6 }, false);
      } else {
        addCall("skill.lancedb_query", "用户需要基于语义召回资料后总结", { query, projectId: context.projectId, limit: 6 });
      }
    }

    return {
      answerStrategy: routePlan.answerStrategy === "multi_step" ? "multi_step" : "rag",
      calls,
      requiresEvidence: true,
      canAnswerWithoutSkill: false,
      rationale: "识别到用户需要已保存资料，生成动态 Skill 调用计划。"
    };
  }
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function mentionsCurrentDocument(message: string): boolean {
  return /(刚才那篇|这篇文章|上面那篇|刚才保存|刚才写入|刚才的文章|这篇)/iu.test(message);
}

function isCitationRequest(message: string): boolean {
  return /(原文|引用|具体段落|出处|文中怎么说|哪一段|摘录|这句话在哪篇资料|出现过)/iu.test(message);
}
