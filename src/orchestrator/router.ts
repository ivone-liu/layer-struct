import { parseJsonObject } from "../ai/json.js";
import type { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import { extractWeChatArticleUrl } from "../services/weChatArticleWorkflow.js";
import type { RequestContext, RoutePlan } from "../types.js";
import { loadCapabilities } from "./registry.js";

export class Router {
  constructor(
    private readonly ai: OpenAiCompatibleClient,
    private readonly routerModel: string
  ) {}

  async route(context: RequestContext): Promise<RoutePlan> {
    const capabilities = loadCapabilities();
    if (this.ai.canChat(this.routerModel)) {
      try {
        return normalizeRoutePlan(
          parseJsonObject<RoutePlan>(
            await this.ai.chat({
              model: this.routerModel,
              jsonMode: true,
              temperature: 0,
              messages: [
                { role: "system", content: routerSystemPrompt(capabilities) },
                { role: "user", content: context.message }
              ]
            })
          ),
          context.message
        );
      } catch {
        return routeByRules(context.message);
      }
    }

    return routeByRules(context.message);
  }
}

function routerSystemPrompt(capabilities: ReturnType<typeof loadCapabilities>): string {
  return `你是 AI Orchestrator Router，只输出 JSON，不回答用户。

任务类型只能是 chat、rag_chat、skill_call、workflow。
当用户要求保存、采集、收集、记录、入库、存为资料、保存到知识库、写入数据库时，优先选择 workflow.ingest_collected_content。
当用户消息中包含 https://mp.weixin.qq.com/ 开头链接，并要求保存/入库/记录公众号文章内容时，选择 workflow.ingest_wechat_article，并提取 url。
当用户要求查询数据库、知识库、根据资料回答、检索资料时，选择 rag_chat 或 skill_call。语义/相似/RAG/向量检索优先 skill.lancedb_query；SQLite/SQL/元数据/标题/来源/最近/精确关键词查询优先 skill.sqlite_query。
如果用户实际依赖已保存资料，即使没有说“查询”，也必须标记 needsSkill=true、needsRag=true、requiresEvidence=true，不能默认 chat。包括：原文、引用、具体段落、出处、文中怎么说、哪一段、摘录；这篇文章、上面那篇、刚才保存、刚才写入、最近保存；根据资料、从库里、知识库、数据库、历史记录、已保存内容；帮我总结刚才那篇、提炼刚才那篇、详细展开刚才那篇。
如果用户要原文/出处/引用/具体段落，answerStrategy 必须是 citation 且 requiresEvidence=true。
Router 不回答用户，只判断用户真实需求。普通解释、写作、分析且不依赖资料时，选择 chat。

输出 JSON 字段：
{
  "taskType": "chat|rag_chat|skill_call|workflow",
  "needsRag": boolean,
  "needsMemory": boolean,
  "needsSkill": boolean,
  "needsWorkflow": boolean,
  "capabilityQuery": string,
  "searchQueries": string[],
  "candidateCapabilities": string[],
  "extractedParams": object,
  "missingParams": string[],
  "confidence": number,
  "rationale": string,
  "answerStrategy": "direct|rag|citation|workflow|multi_step",
  "requiresEvidence": boolean,
  "resolvedQuery": string
}

已注册能力：
${capabilities.map((capability) => `- ${capability.id}: ${capability.description}`).join("\n")}`;
}

function routeByRules(message: string): RoutePlan {
  const wechatUrl = extractWeChatArticleUrl(message);
  if (wechatUrl && hasWriteIntent(message)) {
    return normalizeRoutePlan(
      {
        taskType: "workflow",
        needsRag: false,
        needsMemory: false,
        needsSkill: false,
        needsWorkflow: true,
        capabilityQuery: "保存公众号文章 WeSpy 微信文章入库",
        searchQueries: [],
        candidateCapabilities: ["workflow.ingest_wechat_article"],
        extractedParams: { url: wechatUrl },
        missingParams: [],
        confidence: 0.92,
        rationale: "规则识别到公众号文章链接和保存/入库意图。"
      },
      message
    );
  }

  const writePayload = extractWritePayload(message);
  if (writePayload) {
    return normalizeRoutePlan(
      {
        taskType: "workflow",
        needsRag: false,
        needsMemory: false,
        needsSkill: false,
        needsWorkflow: true,
        capabilityQuery: "采集信息入库 文本入库 知识库保存",
        searchQueries: [],
        candidateCapabilities: ["workflow.ingest_collected_content"],
        extractedParams: writePayload,
        missingParams: writePayload.content ? [] : ["content"],
        confidence: 0.86,
        rationale: "规则识别到写入数据库意图。"
      },
      message
    );
  }

  const explicitMcpCapability = extractExplicitMcpCapability(message);
  if (explicitMcpCapability) {
    return normalizeRoutePlan(
      {
        taskType: "skill_call",
        needsRag: false,
        needsMemory: false,
        needsSkill: true,
        needsWorkflow: false,
        capabilityQuery: explicitMcpCapability,
        searchQueries: [message],
        candidateCapabilities: [explicitMcpCapability],
        extractedParams: { query: message.replace(explicitMcpCapability, "").trim() || message },
        missingParams: [],
        confidence: 0.86,
        rationale: "规则识别到用户显式指定 MCP capability。",
        answerStrategy: "multi_step",
        requiresEvidence: false,
        resolvedQuery: message
      },
      message
    );
  }

  const query = extractQueryPayload(message);
  if (query) {
    return normalizeRoutePlan(
      {
        taskType: "rag_chat",
        needsRag: true,
        needsMemory: false,
        needsSkill: true,
        needsWorkflow: false,
        capabilityQuery: selectQuerySkill(message) === "skill.sqlite_query" ? "SQLite 精确查询 元数据查询" : "LanceDB 语义检索 知识库 RAG",
        searchQueries: [query],
        candidateCapabilities: [selectQuerySkill(message)],
        extractedParams: { query },
        missingParams: query ? [] : ["query"],
        confidence: 0.82,
        rationale: "规则识别到查询数据库或知识库检索意图。"
      },
      message
    );
  }


  const implicitEvidenceQuery = extractImplicitEvidenceQuery(message);
  if (implicitEvidenceQuery) {
    const skillId = selectQuerySkill(message);
    const strategy = isCitationRequest(message) ? "citation" : isMultiStepRequest(message) ? "multi_step" : "rag";
    return normalizeRoutePlan(
      {
        taskType: "rag_chat",
        needsRag: true,
        needsMemory: false,
        needsSkill: true,
        needsWorkflow: false,
        capabilityQuery: skillId === "skill.sqlite_query" ? "SQLite 精确查询 本地文档 chunks" : "LanceDB 语义检索 知识库 RAG",
        searchQueries: [implicitEvidenceQuery],
        candidateCapabilities: [skillId],
        extractedParams: { query: implicitEvidenceQuery },
        missingParams: [],
        confidence: 0.84,
        rationale: "规则识别到用户真实需求依赖已保存资料或原文证据。",
        answerStrategy: strategy,
        requiresEvidence: true,
        resolvedQuery: implicitEvidenceQuery
      },
      message
    );
  }

  return {
    taskType: "chat",
    needsRag: false,
    needsMemory: false,
    needsSkill: false,
    needsWorkflow: false,
    capabilityQuery: "",
    searchQueries: [],
    candidateCapabilities: [],
    extractedParams: {},
    missingParams: [],
    confidence: 0.7,
    rationale: "默认普通对话路径。"
  };
}

function normalizeRoutePlan(plan: RoutePlan, message: string): RoutePlan {
  const taskType = ["chat", "rag_chat", "skill_call", "workflow"].includes(plan.taskType) ? plan.taskType : "chat";
  const searchQueries = Array.isArray(plan.searchQueries) ? plan.searchQueries.filter(Boolean) : [];
  const candidateCapabilities = normalizeCandidateCapabilities(plan.candidateCapabilities, message);
  const wechatUrl = extractWeChatArticleUrl(message);
  if (taskType === "workflow" && wechatUrl && !candidateCapabilities.includes("workflow.ingest_wechat_article")) {
    candidateCapabilities.unshift("workflow.ingest_wechat_article");
  }
  if (taskType === "workflow" && candidateCapabilities.length === 0) {
    candidateCapabilities.push(wechatUrl ? "workflow.ingest_wechat_article" : "workflow.ingest_collected_content");
  }
  if ((taskType === "rag_chat" || taskType === "skill_call") && candidateCapabilities.length === 0) {
    candidateCapabilities.push(selectQuerySkill(message));
  }

  const evidenceIntent = hasImplicitEvidenceIntent(message);
  const answerStrategy = normalizeAnswerStrategy(plan.answerStrategy, message, taskType, evidenceIntent);
  const needsRag = Boolean(plan.needsRag || taskType === "rag_chat" || evidenceIntent);
  const needsSkill = Boolean(plan.needsSkill || taskType === "skill_call" || evidenceIntent || needsRag);
  const requiresEvidence = Boolean(plan.requiresEvidence || evidenceIntent || answerStrategy === "citation");

  if (evidenceIntent && candidateCapabilities.length === 0) {
    candidateCapabilities.push(selectQuerySkill(message));
  }

  return {
    taskType: evidenceIntent && taskType === "chat" ? "rag_chat" : taskType,
    needsRag,
    needsMemory: Boolean(plan.needsMemory),
    needsSkill,
    needsWorkflow: Boolean(plan.needsWorkflow || taskType === "workflow"),
    capabilityQuery: plan.capabilityQuery ?? "",
    searchQueries: searchQueries.length > 0 ? searchQueries : needsRag ? [message] : [],
    candidateCapabilities,
    extractedParams: normalizeExtractedParams(plan.extractedParams, wechatUrl),
    missingParams: Array.isArray(plan.missingParams) ? plan.missingParams : [],
    confidence: clamp(Number(plan.confidence) || 0.5, 0, 1),
    rationale: plan.rationale,
    answerStrategy,
    requiresEvidence,
    targetDocumentId: typeof plan.targetDocumentId === "string" ? plan.targetDocumentId : undefined,
    targetDocumentTitle: typeof plan.targetDocumentTitle === "string" ? plan.targetDocumentTitle : undefined,
    resolvedQuery: typeof plan.resolvedQuery === "string" && plan.resolvedQuery.trim() ? plan.resolvedQuery.trim() : undefined,
    skillPlan: plan.skillPlan
  };
}

function normalizeCandidateCapabilities(value: unknown, message: string): string[] {
  const capabilities = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return capabilities.map((capability) => capability === "skill.query_database" ? selectQuerySkill(message) : capability === "workflow.ingest_text_database" ? "workflow.ingest_collected_content" : capability);
}

function normalizeExtractedParams(params: unknown, wechatUrl?: string): Record<string, unknown> {
  const normalized = params && typeof params === "object" ? { ...(params as Record<string, unknown>) } : {};
  if (wechatUrl && typeof normalized.url !== "string") {
    normalized.url = wechatUrl;
  }
  return normalized;
}

export function extractWritePayload(message: string): { title: string; content: string; source?: string } | undefined {
  if (!hasWriteIntent(message) || extractWeChatArticleUrl(message)) {
    return undefined;
  }

  const payload = message.replace(/^(请你|请|帮我)?\s*(把|将)?\s*(以下|下面|这段)?\s*/, "");
  const contentStart = payload.replace(/^(写入数据库|保存到数据库|保存这段资料到知识库|保存这段|采集这段|收集一下|入库|存为资料|记录这篇|记录到知识库|保存到知识库)[:：]?\s*/u, "");
  const titleMatch = contentStart.match(/标题[:：]\s*(.+)/);
  const sourceMatch = contentStart.match(/来源[:：]\s*(.+)/);
  const lines = contentStart
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const title =
    titleMatch?.[1]?.trim() ||
    (lines[0] && lines[0].length <= 80 && lines.length > 1 ? lines[0].replace(/^标题[:：]\s*/, "") : "未命名资料");
  const content = lines
    .filter((line) => !line.startsWith("标题:") && !line.startsWith("标题：") && !line.startsWith("来源:") && !line.startsWith("来源："))
    .join("\n")
    .trim();

  return {
    title,
    content,
    source: sourceMatch?.[1]?.trim()
  };
}

export function extractQueryPayload(message: string): string | undefined {
  if (!/(查询数据库|查数据库|检索数据库|查询知识库|检索知识库|根据资料|从知识库|RAG)/i.test(message)) {
    return undefined;
  }

  return message
    .replace(/^(请你|请|帮我)?\s*/, "")
    .replace(/^(查询数据库|查数据库|检索数据库|查询知识库|检索知识库|从知识库里找|从知识库|根据资料回答)[:：]?\s*/iu, "")
    .trim();
}

function selectQuerySkill(message: string): string {
  if (/(sqlite|sql|元数据|metadata|标题|来源|最近|最新|列出|route_logs|conversation_messages|documents|chunks|精确|关键词|原文|引用|具体段落|出处|文中怎么说|哪一段|摘录|这句话在哪篇资料|出现过)/iu.test(message)) {
    return "skill.sqlite_query";
  }
  return "skill.lancedb_query";
}

function extractExplicitMcpCapability(message: string): string | undefined {
  return message.match(/\bmcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+\b/u)?.[0];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hasWriteIntent(message: string): boolean {
  return /(写入数据库|保存到数据库|保存这段|采集这段|收集一下|保存|入库|存为资料|记录这篇|记录到知识库|保存到知识库|公众号文章)/u.test(message);
}

function extractImplicitEvidenceQuery(message: string): string | undefined {
  if (!hasImplicitEvidenceIntent(message)) {
    return undefined;
  }
  return message
    .replace(/^(请你|请|帮我)?\s*/, "")
    .replace(/^(我想知道|我希望能够|希望|请问)?\s*/, "")
    .trim();
}

function hasImplicitEvidenceIntent(message: string): boolean {
  return (
    isCitationRequest(message) ||
    /(这篇文章|上面那篇|刚才保存|刚才写入|最近保存|刚才那篇|根据资料|从库里|知识库|数据库|历史记录|已保存内容|保存的内容|帮我总结刚才那篇|提炼刚才那篇|详细展开刚才那篇|在哪篇资料|哪篇资料里|类似观点的资料|核心观点)/iu.test(message)
  );
}

function isCitationRequest(message: string): boolean {
  return /(原文|引用|具体段落|出处|文中怎么说|哪一段|摘录|这句话在哪篇资料|出现过)/iu.test(message);
}

function isMultiStepRequest(message: string): boolean {
  return /(先.+再|多步|分别|对比|综合)/iu.test(message);
}

function normalizeAnswerStrategy(value: unknown, message: string, taskType: string, evidenceIntent: boolean) {
  if (taskType === "workflow") {
    return "workflow" as const;
  }
  if (isCitationRequest(message)) {
    return "citation" as const;
  }
  if (isMultiStepRequest(message)) {
    return "multi_step" as const;
  }
  if (evidenceIntent || taskType === "rag_chat" || taskType === "skill_call") {
    return "rag" as const;
  }
  return value === "direct" || value === "rag" || value === "citation" || value === "workflow" || value === "multi_step"
    ? value
    : "direct";
}
