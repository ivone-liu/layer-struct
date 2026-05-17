import type { AnswerStrategy, ExpandedEvidenceItem, EvidenceItem, FinalContext, MemoryHit, RoutePlan, SkillExecutionResult, SkillPlan } from "../types.js";

export function buildFinalPrompt(context: FinalContext): string {
  const answerStrategy = context.answerStrategy ?? context.skillPlan?.answerStrategy ?? context.routePlan.answerStrategy ?? "direct";
  const evidence = renderEvidence(context.evidencePack, answerStrategy);
  const conversationContext = renderConversationContext(context.conversationContext);
  const sessionRequirementMemory = renderSessionRequirementMemory(context.sessionRequirementMemory);
  const memoryHits = context.memoryHits ?? context.evidencePack?.memoryHits ?? [];

  return `用户请求：
${context.request.message}

${sessionRequirementMemory}

${conversationContext}

RoutePlan（compact）：
${JSON.stringify(compactRoutePlan(context.routePlan), null, 2)}

AnswerStrategy：${answerStrategy}

MemoryHits Compact（仅导航线索，不是原文证据；需要原文引用时必须回到 document_chunks/chunks）：
${memoryHits.length ? JSON.stringify(compactMemoryHits(memoryHits), null, 2) : "无 MemoryHits。"}

SkillPlan（compact）：
${context.skillPlan ? JSON.stringify(compactSkillPlan(context.skillPlan), null, 2) : "无 SkillPlan。"}

SkillResults（summary）：
${context.skillResults?.length ? JSON.stringify(summarizeSkillResults(context.skillResults), null, 2) : "无 SkillResults。"}

Observation（compact）：
${context.observation ? JSON.stringify({ enoughToAnswer: context.observation.enoughToAnswer, missing: context.observation.missing, nextCallCount: context.observation.nextCalls.length, rationale: context.observation.rationale }, null, 2) : "无 Observation。"}

证据包（仅此处包含正文；优先使用 expandedItems，不重复输出原 items）：
skillId=${context.evidencePack?.skillId ?? "none"} query=${context.evidencePack?.query ?? "none"}
${evidence}

执行结果（compact）：
${context.executionResult ? JSON.stringify({ status: context.executionResult.status, capabilityId: context.executionResult.capabilityId, message: context.executionResult.message, error: context.executionResult.error }, null, 2) : "无能力执行结果。"}

约束：
${context.constraints.map((item) => `- ${item}`).join("\n")}`;
}

function renderSessionRequirementMemory(memory: FinalContext["sessionRequirementMemory"]): string {
  if (!memory) {
    return "Session 用户需求 Memory（最高优先级）：无。";
  }

  const details = memory.details.length ? memory.details.map((item) => `- ${item}`).join("\n") : "- 无";
  const openQuestions = memory.openQuestions.length ? memory.openQuestions.map((item) => `- ${item}`).join("\n") : "- 无";
  return `Session 用户需求 Memory（最高优先级；只描述本 session 用户真实需求，不是外部证据；回答必须优先满足并随当前用户请求校正）：
coreQuestion: ${memory.coreQuestion}
currentUnderstanding: ${memory.currentUnderstanding}
details:
${details}
openQuestions:
${openQuestions}`;
}

function renderConversationContext(pack: FinalContext["conversationContext"]): string {
  if (!pack) {
    return "对话压缩上下文：无。\n\n最近两轮原文：无。";
  }
  const compressed = pack.compressedText
    ? `对话压缩上下文（历史对话的保真压缩上下文，用于延续目标和约束；不可把压缩内容当作原文资料证据）：\n${pack.compressedText}`
    : "对话压缩上下文：无。";
  const recent = pack.recentMessages.length
    ? pack.recentMessages.map((message) => `[${message.role}] ${message.content}`).join("\n\n")
    : "无。";
  return `${compressed}\n\n最近两轮原文（优先级高于压缩摘要，保持 role 和 content）：\n${recent}`;
}

export function summarizeSkillResults(skillResults: SkillExecutionResult[]): Array<{
  callId: string;
  skillId: string;
  status: SkillExecutionResult["status"];
  evidenceCount: number;
  output?: Record<string, unknown>;
  error?: string;
}> {
  return skillResults.map((result) => ({
    callId: result.callId,
    skillId: result.skillId,
    status: result.status,
    evidenceCount: result.evidencePack?.items.length ?? 0,
    output: summarizeOutput(result.output),
    error: result.error
  }));
}

function summarizeOutput(output: SkillExecutionResult["output"]): Record<string, unknown> | undefined {
  if (!output) {
    return undefined;
  }
  const text = typeof output.text === "string" ? truncate(output.text, 3000) : undefined;
  return {
    ...output,
    text,
    raw: undefined
  };
}

export function defaultConstraints(answerStrategy: AnswerStrategy = "direct"): string[] {
  const base = ["输出中文。"]; 
  if (answerStrategy === "direct") {
    return ["可以正常回答用户问题。", ...base];
  }
  if (answerStrategy === "workflow") {
    return ["简洁说明执行结果、数量和可追踪 ID。", ...base];
  }
  if (answerStrategy === "citation") {
    return [
      "只能引用 evidencePack 中来自 document_chunks/chunks 的原文，MemoryHits 只能用于定位文档，不能作为原文依据。",
      "每个观点必须绑定一个 evidence item，标注对应的 chunkId/documentId 或序号。",
      "如果没有证据，不允许补写；应明确写入未确认部分。",
      "输出结构必须包含：## 结论、## 原文引用与解读、## 未确认部分。",
      ...base
    ];
  }
  return [
    "必须优先基于 skillResults/evidencePack 回答。",
    "不要编造资料库不存在的信息；证据不足时明确说明不足。",
    "MemoryHits 不是原文证据，只能作为导航线索。",
    "对查询等系统动作，可简洁说明证据数量和来源。",
    ...base
  ];
}

function compactRoutePlan(routePlan: RoutePlan): Record<string, unknown> {
  return {
    taskType: routePlan.taskType,
    answerStrategy: routePlan.answerStrategy,
    requiresEvidence: routePlan.requiresEvidence,
    candidateCapabilities: routePlan.candidateCapabilities,
    documentResolution: routePlan.documentResolution,
    rationale: routePlan.rationale
  };
}

function compactSkillPlan(skillPlan: SkillPlan): Record<string, unknown> {
  return {
    answerStrategy: skillPlan.answerStrategy,
    requiresEvidence: skillPlan.requiresEvidence,
    rationale: skillPlan.rationale,
    calls: skillPlan.calls.map((call) => ({
      skillId: call.skillId,
      reason: call.reason,
      required: call.required,
      params: call.params
    }))
  };
}

function compactMemoryHits(memoryHits: MemoryHit[]): Array<Record<string, unknown>> {
  return memoryHits.slice(0, 6).map((hit) => ({
    memoryId: hit.memoryId,
    kind: hit.kind,
    documentId: hit.documentId,
    title: hit.title,
    entities: hit.entities,
    topics: hit.topics,
    reason: hit.reason
  }));
}

function renderEvidence(evidencePack: FinalContext["evidencePack"], answerStrategy: AnswerStrategy): string {
  if (answerStrategy === "direct") {
    return "direct 策略不注入 evidence 正文。";
  }

  const expandedItems = evidencePack?.expandedItems;
  if (expandedItems?.length) {
    const limit = answerStrategy === "citation" ? 8 : 5;
    return expandedItems.slice(0, limit).map((item, index) => renderExpandedEvidenceItem(item, index)).join("\n\n");
  }

  const items = evidencePack?.items ?? [];
  if (!items.length) {
    return "无外部证据。";
  }

  const limit = answerStrategy === "citation" ? 8 : 6;
  const contentLimit = answerStrategy === "citation" ? 1600 : 1200;
  return items
    .slice(0, limit)
    .map((item, index) => renderEvidenceItem(item, index, contentLimit))
    .join("\n\n");
}

function renderExpandedEvidenceItem(item: ExpandedEvidenceItem, index: number): string {
  return [
    `[证据 ${index + 1}]`,
    `title=${item.title}`,
    `source=${item.source ?? "local-db"}`,
    `documentId=${item.documentId}`,
    `chunkIndex=${item.centerChunkIndex ?? item.chunkIndex ?? "unknown"}`,
    `chunkId=${item.chunkId}`,
    truncate(item.expandedContent, 2000)
  ].join("\n");
}

function renderEvidenceItem(item: EvidenceItem, index: number, contentLimit: number): string {
  return [
    `[${index + 1}]`,
    `chunkId=${item.chunkId}`,
    `documentId=${item.documentId}`,
    `chunkIndex=${item.chunkIndex ?? "unknown"}`,
    `title=${item.title}`,
    `source=${item.source ?? "local-db"}`,
    `score=${item.score}`,
    `content excerpt:\n${truncate(item.content, contentLimit)}`
  ].join("\n");
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
