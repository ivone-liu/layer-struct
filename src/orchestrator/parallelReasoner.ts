import type { AppConfig } from "../config/env.js";
import type { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import type { FinalContext, ReasoningCandidate } from "../types.js";
import { buildFinalPrompt, defaultConstraints } from "./contextBuilder.js";

const MIN_REASONING_THREADS = 3;

export class ParallelReasoner {
  constructor(
    private readonly ai: OpenAiCompatibleClient,
    private readonly config: AppConfig
  ) {}

  async generateCandidates(context: Omit<FinalContext, "constraints"> & { constraints?: string[] }): Promise<ReasoningCandidate[]> {
    if (!shouldReason(context) || !this.ai.hasApiKey()) {
      return [];
    }

    const models = this.resolveReasoningModels();
    if (models.length === 0) {
      return [];
    }

    const answerStrategy = context.answerStrategy ?? context.skillPlan?.answerStrategy ?? context.routePlan.answerStrategy ?? "rag";
    const basePrompt = buildFinalPrompt({
      ...context,
      answerStrategy,
      constraints: context.constraints ?? defaultConstraints(answerStrategy)
    });

    const threads = models.slice(0, MIN_REASONING_THREADS).map((model, index) =>
      this.runIsolatedThread({ model, index, basePrompt })
    );
    const results = await Promise.allSettled(threads);

    return results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      return {
        id: `reasoning-${index + 1}`,
        model: models[index] ?? "unknown",
        status: "failed",
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      } satisfies ReasoningCandidate;
    });
  }

  private async runIsolatedThread(params: { model: string; index: number; basePrompt: string }): Promise<ReasoningCandidate> {
    const id = `reasoning-${params.index + 1}`;
    if (!this.ai.canChat(params.model)) {
      return { id, model: params.model, status: "failed", error: `Reasoning model is not configured: ${params.model}` };
    }

    const content = await this.ai.chat({
      model: params.model,
      temperature: 0.15 + params.index * 0.05,
      messages: [
        {
          role: "system",
          content: [
            "你是一个独立的资料推理线程。",
            "你只能看到本线程收到的资料，不能假设或引用其他线程的结论。",
            "请基于证据包和上下文生成一个可供最终大模型参考的推理候选。",
            "要求：输出中文；明确列出结论、关键依据、证据不足或风险；不要编造证据外事实。"
          ].join("\n")
        },
        {
          role: "user",
          content: params.basePrompt
        }
      ]
    });

    return {
      id,
      model: params.model,
      status: "success",
      content: truncate(content, 6000)
    };
  }

  private resolveReasoningModels(): string[] {
    const configured = this.config.ai.reasoningModels.filter((model) => this.ai.canChat(model));
    const fallbacks = [this.config.ai.chatModel, this.config.ai.routerModel, this.config.ai.compressorModel, this.config.ai.requirementMemoryModel]
      .map((model) => model.trim())
      .filter((model) => model.length > 0 && this.ai.canChat(model));

    const models = [...configured, ...fallbacks];
    if (models.length === 0) {
      return [];
    }

    while (models.length < MIN_REASONING_THREADS) {
      models.push(models[models.length % Math.max(1, models.length)] ?? models[0]);
    }
    return models.slice(0, MIN_REASONING_THREADS);
  }
}

function shouldReason(context: Omit<FinalContext, "constraints">): boolean {
  if (context.executionResult?.capabilityId?.startsWith("workflow.")) {
    return false;
  }
  const answerStrategy = context.answerStrategy ?? context.skillPlan?.answerStrategy ?? context.routePlan.answerStrategy;
  if (answerStrategy === "direct" || answerStrategy === "workflow") {
    return false;
  }
  return Boolean(context.evidencePack?.items.length || context.evidencePack?.expandedItems?.length);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
