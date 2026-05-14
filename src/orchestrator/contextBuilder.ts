import type { FinalContext } from "../types.js";

export function buildFinalPrompt(context: FinalContext): string {
  const evidence = context.evidencePack?.items.length
    ? context.evidencePack.items
        .map(
          (item, index) =>
            `[${index + 1}] title=${item.title} source=${item.source ?? "local-db"} score=${item.score}\n${item.content}`
        )
        .join("\n\n")
    : "无外部证据。";

  const execution = context.executionResult
    ? JSON.stringify(context.executionResult, null, 2)
    : "无能力执行结果。";

  return `用户请求：
${context.request.message}

RoutePlan：
${JSON.stringify(context.routePlan, null, 2)}

证据包：
${evidence}

执行结果：
${execution}

约束：
${context.constraints.map((item) => `- ${item}`).join("\n")}`;
}

export function defaultConstraints(): string[] {
  return [
    "优先基于证据包和执行结果回答。",
    "证据不足时明确说明不足，不要编造数据库中不存在的内容。",
    "对写入、查询等系统动作，简洁说明结果、数量和可追踪 ID。",
    "输出中文。"
  ];
}
