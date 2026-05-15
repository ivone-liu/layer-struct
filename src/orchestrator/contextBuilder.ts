import type { AnswerStrategy, EvidenceItem, FinalContext, RoutePlan, SkillExecutionResult, SkillPlan } from "../types.js";

export function buildFinalPrompt(context: FinalContext): string {
  const answerStrategy = context.answerStrategy ?? context.skillPlan?.answerStrategy ?? context.routePlan.answerStrategy ?? "direct";
  const evidence = renderEvidence(context.evidencePack?.items ?? [], answerStrategy);

  return `用户请求：
${context.request.message}

RoutePlan（compact）：
${JSON.stringify(compactRoutePlan(context.routePlan), null, 2)}

AnswerStrategy：${answerStrategy}

SkillPlan（compact）：
${context.skillPlan ? JSON.stringify(compactSkillPlan(context.skillPlan), null, 2) : "无 SkillPlan。"}

SkillResults（summary）：
${context.skillResults?.length ? JSON.stringify(summarizeSkillResults(context.skillResults), null, 2) : "无 SkillResults。"}

Observation（compact）：
${context.observation ? JSON.stringify({ enoughToAnswer: context.observation.enoughToAnswer, missing: context.observation.missing, nextCallCount: context.observation.nextCalls.length, rationale: context.observation.rationale }, null, 2) : "无 Observation。"}

证据包（仅此处包含正文）：
skillId=${context.evidencePack?.skillId ?? "none"} query=${context.evidencePack?.query ?? "none"}
${evidence}

执行结果（compact）：
${context.executionResult ? JSON.stringify({ status: context.executionResult.status, capabilityId: context.executionResult.capabilityId, message: context.executionResult.message, error: context.executionResult.error }, null, 2) : "无能力执行结果。"}

约束：
${context.constraints.map((item) => `- ${item}`).join("\n")}`;
}

export function summarizeSkillResults(skillResults: SkillExecutionResult[]): Array<{
  callId: string;
  skillId: string;
  status: SkillExecutionResult["status"];
  evidenceCount: number;
  error?: string;
}> {
  return skillResults.map((result) => ({
    callId: result.callId,
    skillId: result.skillId,
    status: result.status,
    evidenceCount: result.evidencePack?.items.length ?? 0,
    error: result.error
  }));
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
      "只能引用 evidencePack 中的原文，历史对话只能用于理解用户意图，不能作为原文依据。",
      "每个观点必须绑定一个 evidence item，标注对应的 chunkId/documentId 或序号。",
      "如果没有证据，不允许补写；应明确写入未确认部分。",
      "输出结构必须包含：## 结论、## 原文引用与解读、## 未确认部分。",
      ...base
    ];
  }
  return [
    "必须优先基于 skillResults/evidencePack 回答。",
    "不要编造资料库不存在的信息；证据不足时明确说明不足。",
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
      paramsKeys: Object.keys(call.params)
    }))
  };
}

function renderEvidence(items: EvidenceItem[], answerStrategy: AnswerStrategy): string {
  if (answerStrategy === "direct") {
    return "direct 策略不注入 evidence 正文。";
  }

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
