import type { AnswerStrategy, FinalContext } from "../types.js";

export function buildFinalPrompt(context: FinalContext): string {
  const evidence = context.evidencePack?.items.length
    ? context.evidencePack.items
        .map(
          (item, index) =>
            `[${index + 1}] chunkId=${item.chunkId} documentId=${item.documentId} chunkIndex=${item.chunkIndex ?? "unknown"} title=${item.title} source=${item.source ?? "local-db"} score=${item.score}\n${item.content}`
        )
        .join("\n\n")
    : "无外部证据。";

  const execution = context.executionResult ? JSON.stringify(context.executionResult, null, 2) : "无能力执行结果。";
  const skillPlan = context.skillPlan ? JSON.stringify(context.skillPlan, null, 2) : "无 SkillPlan。";
  const skillResults = context.skillResults ? JSON.stringify(context.skillResults, null, 2) : "无 SkillResults。";
  const observation = context.observation ? JSON.stringify(context.observation, null, 2) : "无 Observation。";

  return `用户请求：
${context.request.message}

RoutePlan：
${JSON.stringify(context.routePlan, null, 2)}

AnswerStrategy：${context.answerStrategy ?? context.skillPlan?.answerStrategy ?? context.routePlan.answerStrategy ?? "direct"}

SkillPlan：
${skillPlan}

SkillResults：
${skillResults}

Observation：
${observation}

证据包：
skillId=${context.evidencePack?.skillId ?? "none"} query=${context.evidencePack?.query ?? "none"}
${evidence}

执行结果：
${execution}

约束：
${context.constraints.map((item) => `- ${item}`).join("\n")}`;
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
