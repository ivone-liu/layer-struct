import { parseJsonObject } from "../ai/json.js";
import type { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import { extractWeChatArticleUrl } from "../services/weChatArticleWorkflow.js";
import type { RequestContext, RoutePlan } from "../types.js";
import { capabilities } from "./registry.js";

export class Router {
  constructor(
    private readonly ai: OpenAiCompatibleClient,
    private readonly routerModel: string
  ) {}

  async route(context: RequestContext): Promise<RoutePlan> {
    if (this.ai.canChat(this.routerModel)) {
      try {
        return normalizeRoutePlan(
          parseJsonObject<RoutePlan>(
            await this.ai.chat({
              model: this.routerModel,
              jsonMode: true,
              temperature: 0,
              messages: [
                { role: "system", content: routerSystemPrompt() },
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

function routerSystemPrompt(): string {
  return `你是 AI Orchestrator Router，只输出 JSON，不回答用户。

任务类型只能是 chat、rag_chat、skill_call、workflow。
当用户要求保存、记录、入库、写入数据库时，选择 workflow。
当用户消息中包含 https://mp.weixin.qq.com/ 开头链接，并要求保存/入库/记录公众号文章内容时，选择 workflow.ingest_wechat_article，并提取 url。
当用户要求查询数据库、知识库、根据资料回答、检索资料时，选择 rag_chat 或 skill_call。
普通解释、写作、分析且不依赖资料时，选择 chat。

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
  "rationale": string
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
        capabilityQuery: "写入数据库 文本入库 知识库保存",
        searchQueries: [],
        candidateCapabilities: ["workflow.ingest_text_database"],
        extractedParams: writePayload,
        missingParams: writePayload.content ? [] : ["content"],
        confidence: 0.86,
        rationale: "规则识别到写入数据库意图。"
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
        capabilityQuery: "查询数据库 知识库检索 RAG",
        searchQueries: [query],
        candidateCapabilities: ["skill.query_database"],
        extractedParams: { query },
        missingParams: query ? [] : ["query"],
        confidence: 0.82,
        rationale: "规则识别到查询数据库或知识库检索意图。"
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
  const candidateCapabilities = Array.isArray(plan.candidateCapabilities) ? plan.candidateCapabilities : [];
  const wechatUrl = extractWeChatArticleUrl(message);
  if (taskType === "workflow" && wechatUrl && !candidateCapabilities.includes("workflow.ingest_wechat_article")) {
    candidateCapabilities.unshift("workflow.ingest_wechat_article");
  }
  if (taskType === "workflow" && candidateCapabilities.length === 0) {
    candidateCapabilities.push(wechatUrl ? "workflow.ingest_wechat_article" : "workflow.ingest_text_database");
  }
  if ((taskType === "rag_chat" || taskType === "skill_call") && candidateCapabilities.length === 0) {
    candidateCapabilities.push("skill.query_database");
  }

  return {
    taskType,
    needsRag: Boolean(plan.needsRag || taskType === "rag_chat"),
    needsMemory: Boolean(plan.needsMemory),
    needsSkill: Boolean(plan.needsSkill || taskType === "skill_call"),
    needsWorkflow: Boolean(plan.needsWorkflow || taskType === "workflow"),
    capabilityQuery: plan.capabilityQuery ?? "",
    searchQueries: searchQueries.length > 0 ? searchQueries : taskType === "rag_chat" ? [message] : [],
    candidateCapabilities,
    extractedParams: normalizeExtractedParams(plan.extractedParams, wechatUrl),
    missingParams: Array.isArray(plan.missingParams) ? plan.missingParams : [],
    confidence: clamp(Number(plan.confidence) || 0.5, 0, 1),
    rationale: plan.rationale
  };
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
  const contentStart = payload.replace(/^(写入数据库|保存到数据库|保存这段资料到知识库|保存这段|入库|记录到知识库|保存到知识库)[:：]?\s*/u, "");
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hasWriteIntent(message: string): boolean {
  return /(写入数据库|保存到数据库|保存这段|保存|入库|记录到知识库|保存到知识库|公众号文章)/u.test(message);
}
