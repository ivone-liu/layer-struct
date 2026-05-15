import type { SkillExecutionResult, SkillObservation, SkillPlan } from "../types.js";

export function observeSkillResults(skillPlan: SkillPlan, skillResults: SkillExecutionResult[]): SkillObservation {
  if (!skillPlan.requiresEvidence) {
    return { enoughToAnswer: true, missing: [], nextCalls: [], rationale: "该请求不需要外部证据。" };
  }

  const requiredIds = new Set(skillPlan.calls.filter((call) => call.required).map((call) => call.id));
  const requiredResults = skillResults.filter((result) => requiredIds.has(result.callId));
  const hasRequiredEvidence = requiredResults.some((result) => (result.evidencePack?.items.length ?? 0) > 0);
  const enoughToAnswer = skillPlan.answerStrategy === "citation" ? hasRequiredEvidence : hasRequiredEvidence;

  return {
    enoughToAnswer,
    missing: enoughToAnswer ? [] : ["required_evidence"],
    nextCalls: [],
    rationale: enoughToAnswer ? "必要 Skill 返回了可用证据。" : "所有必要 Skill 均未返回可用证据或执行失败。"
  };
}
