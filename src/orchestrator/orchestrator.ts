import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import type {
  ChatResponse,
  ChatStreamCallbacks,
  DocumentWriteProgressEvent,
  ExecutionResult,
  EvidenceItem,
  EvidencePack,
  MemoryHit,
  RequestContext,
  RoutePlan,
  SkillExecutionResult,
  SkillObservation,
  SkillPlan,
  StoredDocumentInput
} from "../types.js";
import { AiTimeoutError, OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import { buildFinalPrompt, defaultConstraints } from "./contextBuilder.js";
import { extractWritePayload, Router } from "./router.js";
import { DocumentService } from "../services/documentService.js";
import { extractWeChatArticleUrl, WeChatArticleWorkflow } from "../services/weChatArticleWorkflow.js";
import { RunTracker } from "./runTracker.js";
import { SkillPlanner } from "./skillPlanner.js";
import { SkillExecutor } from "./skillExecutor.js";
import { observeSkillResults } from "./skillObserver.js";
import { capabilities } from "./registry.js";
import { MemoryService } from "../services/memoryService.js";
import { ParallelRetriever } from "./parallelRetriever.js";
import { DocumentResolver } from "./documentResolver.js";

export class Orchestrator {
  private readonly router: Router;
  private readonly wechatArticles: WeChatArticleWorkflow;
  private readonly skillPlanner = new SkillPlanner();
  private readonly skillExecutor: SkillExecutor;
  private readonly parallelRetriever: ParallelRetriever;
  private readonly documentResolver: DocumentResolver;

  constructor(
    private readonly config: AppConfig,
    private readonly sqlite: SqliteStore,
    private readonly documents: DocumentService,
    private readonly ai: OpenAiCompatibleClient,
    private readonly memory: MemoryService
  ) {
    this.router = new Router(ai, config.ai.routerModel);
    this.wechatArticles = new WeChatArticleWorkflow(config.wespy);
    this.skillExecutor = new SkillExecutor(documents);
    this.parallelRetriever = new ParallelRetriever(memory, documents);
    this.documentResolver = new DocumentResolver(sqlite);
  }

  async chat(input: { message: string; sessionId?: string; userId?: string; projectId?: string }): Promise<ChatResponse> {
    const context = createRequestContext(input, this.config.defaultProjectId);
    this.insertUserMessage(context);

    const sessionState = this.sqlite.getSessionState(context.sessionId);
    const routePlan = await this.router.route(context);
    this.sqlite.insertRouteLog(context, routePlan);
    const hints = await this.parallelRetriever.searchHints(context, routePlan);
    const memoryHits = hints.memoryHits;
    const documentResolution = this.documentResolver.resolve({ context, routePlan, sessionState, memoryHits, documentCandidates: hints.documentCandidates });
    routePlan.documentResolution = documentResolution;
    if (documentResolution.status === "ambiguous") {
      const answer = renderAmbiguousDocumentAnswer(documentResolution.candidates);
      this.insertAssistantMessage(context.sessionId, answer);
      return { answer, routePlan, memoryHits };
    }
    const skillPlan = this.skillPlanner.plan(context, routePlan, sessionState, capabilities, documentResolution, memoryHits);
    routePlan.skillPlan = skillPlan;
    routePlan.answerStrategy = skillPlan.answerStrategy;
    routePlan.requiresEvidence = skillPlan.requiresEvidence;

    const executionResult = await this.executeIfNeeded(context, routePlan, undefined, context.userId);
    let { skillResults, observation, evidencePack } = await this.executeSkillsIfNeeded(context, skillPlan);
    evidencePack = evidencePack ? await this.documents.expandEvidencePack({ ...evidencePack, memoryHits, retrievalSources: [...(evidencePack.retrievalSources ?? []), "memory_items"] }) : undefined;
    const guardAnswer = guardedNoEvidenceAnswer(skillPlan, observation);
    const answer = guardAnswer ?? (await this.generateAnswer(context, routePlan, executionResult, evidencePack, skillPlan, skillResults, observation, memoryHits));

    this.insertAssistantMessage(context.sessionId, answer);
    return { answer, routePlan, evidencePack, executionResult, skillPlan, skillResults, observation, memoryHits };
  }

  async chatStream(
    input: { message: string; sessionId?: string; userId?: string; projectId?: string },
    callbacks: ChatStreamCallbacks
  ): Promise<ChatResponse> {
    const context = createRequestContext(input, this.config.defaultProjectId);
    this.insertUserMessage(context);

    const runId = randomUUID();
    this.sqlite.createRun({
      id: runId,
      sessionId: context.sessionId,
      projectId: context.projectId,
      userMessage: context.message,
      status: "running",
      createdAt: context.createdAt,
      updatedAt: context.createdAt
    });
    const tracker = new RunTracker(this.sqlite, callbacks, runId);

    let routePlan: RoutePlan | undefined;
    let skillPlan: SkillPlan | undefined;
    let skillResults: SkillExecutionResult[] = [];
    let observation: SkillObservation | undefined;
    let executionResult: ExecutionResult | undefined;
    let evidencePack: EvidencePack | undefined;
    let finalAnswer = "";
    let memoryHits: MemoryHit[] = [];
    let completedWithFallback = false;

    try {
      await tracker.runStarted("已收到问题，正在判断处理方式。");
      await tracker.stepCompleted("intake", "问题已进入 Orchestrator。", {
        requestId: context.requestId,
        sessionId: context.sessionId,
        projectId: context.projectId
      });

      const sessionState = this.sqlite.getSessionState(context.sessionId);
      await tracker.stepStarted("router", "正在判断这是普通对话、资料查询还是工作流任务。");
      routePlan = await this.router.route(context);
      this.sqlite.insertRouteLog(context, routePlan);
      await tracker.stepCompleted("router", renderRouteMessage(routePlan), { routePlan, sessionState });
      callbacks.onEvent({ type: "memory_started", runId, visibleMessage: "正在查找跨对话记忆。" });
      const hints = await this.parallelRetriever.searchHints(context, routePlan);
      memoryHits = hints.memoryHits;
      callbacks.onEvent({ type: "memory_completed", runId, visibleMessage: `已找到 ${memoryHits.length} 条相关记忆。`, memoryHits });
      const documentResolution = this.documentResolver.resolve({ context, routePlan, sessionState, memoryHits, documentCandidates: hints.documentCandidates });
      routePlan.documentResolution = documentResolution;
      if (documentResolution.status === "ambiguous") {
        callbacks.onEvent({ type: "document_ambiguous", runId, visibleMessage: "找到多篇候选文档，需要选择。", documentResolution });
        finalAnswer = renderAmbiguousDocumentAnswer(documentResolution.candidates);
        await tracker.answerDelta(finalAnswer);
        this.insertAssistantMessage(context.sessionId, finalAnswer);
        const result = { answer: finalAnswer, routePlan, evidencePack, executionResult, skillPlan, skillResults, observation, memoryHits };
        await tracker.done(result, "completed");
        return result;
      }
      if (documentResolution.status === "resolved") {
        callbacks.onEvent({ type: "document_resolved", runId, visibleMessage: `已定位到《${documentResolution.title ?? documentResolution.documentId}》。`, documentResolution });
      }
      skillPlan = this.skillPlanner.plan(context, routePlan, sessionState, capabilities, documentResolution, memoryHits);
      routePlan.skillPlan = skillPlan;
      routePlan.answerStrategy = skillPlan.answerStrategy;
      routePlan.requiresEvidence = skillPlan.requiresEvidence;
      await tracker.skillPlan(skillPlan, renderSkillPlanMessage(skillPlan));

      executionResult = await this.executeIfNeeded(context, routePlan, tracker, context.userId);
      ({ skillResults, observation, evidencePack } = await this.executeSkillsIfNeeded(context, skillPlan, tracker));
      evidencePack = evidencePack ? await this.documents.expandEvidencePack({ ...evidencePack, memoryHits, retrievalSources: [...(evidencePack.retrievalSources ?? []), "memory_items"] }) : undefined;

      const guardAnswer = guardedNoEvidenceAnswer(skillPlan, observation);
      if (guardAnswer) {
        finalAnswer = guardAnswer;
        await tracker.observation(observation, "没有找到足够证据，停止生成。");
        await tracker.answerDelta(finalAnswer);
      } else {
        await tracker.observation(observation, "证据足够，开始生成回答。");
        await tracker.stepStarted("context", "正在整理证据和上下文。");
        const generationInput = this.prepareGenerationInput(context, routePlan, executionResult, evidencePack, skillPlan, skillResults, observation, memoryHits);
        await tracker.stepCompleted("context", "上下文已整理完成。", {
          hasEvidence: Boolean(evidencePack),
          evidenceCount: evidencePack?.items.length ?? 0,
          hasExecutionResult: Boolean(executionResult),
          skillResultCount: skillResults.length
        });

        await tracker.metadata({ routePlan, evidencePack, executionResult, skillPlan, skillResults, observation, memoryHits });
        await tracker.stepStarted("generation", "正在生成最终回答。");
        let usedFallback = false;
        try {
          for await (const chunk of this.generateAnswerStreamFromPrepared(generationInput)) {
            finalAnswer += chunk;
            await tracker.answerDelta(chunk);
          }
          await tracker.stepCompleted("generation", "回答生成完成。", { answerLength: finalAnswer.length });
        } catch (error) {
          if (!isTimeoutError(error)) {
            throw error;
          }
          usedFallback = true;
          completedWithFallback = true;
          finalAnswer = renderGenerationFallback(error, evidencePack);
          await tracker.answerDelta(finalAnswer);
          await tracker.stepCompleted("generation", "生成模型超时，已返回降级结果。", {
            fallback: true,
            answerLength: finalAnswer.length,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        if (usedFallback) {
          await tracker.metadata({ fallback: true }, "已返回降级结果。");
        }
      }

      this.insertAssistantMessage(context.sessionId, finalAnswer);
      const result = { answer: finalAnswer, routePlan, evidencePack, executionResult, skillPlan, skillResults, observation, memoryHits };
      await tracker.done(result, completedWithFallback ? "completed_with_fallback" : "completed");
      return result;
    } catch (error) {
      await tracker.error(error);
      throw error;
    }
  }

  async writeDocument(input: StoredDocumentInput): Promise<ExecutionResult> {
    const result = await this.documents.writeDocument(input);
    await this.memory.createDocumentAnchorMemory({
      projectId: result.document.projectId,
      documentId: result.document.id,
      title: result.document.title,
      source: result.document.source,
      contentSample: result.document.content.slice(0, 1600)
    });
    return {
      status: "success",
      capabilityId: "workflow.ingest_text_database",
      message: "文档已写入 SQLite、LanceDB，并创建 document_anchor memory。",
      output: { documentId: result.document.id, title: result.document.title, chunkCount: result.chunkCount }
    };
  }

  private insertUserMessage(context: RequestContext): void {
    this.sqlite.insertMessage({ id: randomUUID(), sessionId: context.sessionId, role: "user", content: context.message, createdAt: context.createdAt });
  }

  private insertAssistantMessage(sessionId: string, answer: string): void {
    this.sqlite.insertMessage({ id: randomUUID(), sessionId, role: "assistant", content: answer, createdAt: new Date().toISOString() });
  }

  private async executeSkillsIfNeeded(
    context: RequestContext,
    skillPlan: SkillPlan,
    tracker?: RunTracker
  ): Promise<{ skillResults: SkillExecutionResult[]; observation: SkillObservation; evidencePack?: EvidencePack }> {
    const skillResults: SkillExecutionResult[] = [];
    for (const call of skillPlan.calls) {
      await tracker?.skillStarted(call);
      const result = await this.skillExecutor.execute(call, context);
      skillResults.push(result);
      if (result.status === "failed") {
        await tracker?.skillFailed(result);
      } else {
        await tracker?.skillCompleted(result);
      }
    }
    const observation = observeSkillResults(skillPlan, skillResults);
    const evidencePack = mergeEvidencePacks(skillResults);
    return { skillResults, observation, evidencePack };
  }

  private async executeIfNeeded(context: RequestContext, routePlan: RoutePlan, tracker?: RunTracker, userId?: string): Promise<ExecutionResult | undefined> {
    if (!routePlan.needsWorkflow && routePlan.taskType !== "workflow") {
      return undefined;
    }

    const wechatUrl = stringParam(routePlan.extractedParams.url) || extractWeChatArticleUrl(context.message);
    if (wechatUrl && routePlan.candidateCapabilities.includes("workflow.ingest_wechat_article")) {
      await tracker?.stepStarted("execution", "正在抓取公众号文章内容。", { capabilityId: "workflow.ingest_wechat_article" });
      const result = await this.ingestWeChatArticle(context, wechatUrl, tracker, userId);
      if (result.status === "failed") {
        await tracker?.stepFailed("execution", "公众号文章写入数据库失败。", result.error ?? result.message, { result });
      } else {
        await tracker?.stepCompleted("execution", "公众号文章已写入知识库。", { result });
      }
      return result;
    }

    if (!routePlan.candidateCapabilities.includes("workflow.ingest_text_database")) {
      return { status: "skipped", message: "没有匹配到可执行的 Workflow。" };
    }

    await tracker?.stepStarted("execution", "正在整理并写入知识库。", { capabilityId: "workflow.ingest_text_database" });
    const parsed = extractWritePayload(context.message);
    const content = stringParam(routePlan.extractedParams.content) || parsed?.content;
    if (!content) {
      const result: ExecutionResult = { status: "failed", capabilityId: "workflow.ingest_text_database", message: "写入数据库缺少 content 参数。", error: "missing content" };
      await tracker?.stepFailed("execution", "写入知识库失败，缺少可写入内容。", result.error, { result });
      return result;
    }

    const result = await this.writeDocumentWithProgress(
      {
        title: stringParam(routePlan.extractedParams.title) || parsed?.title || "未命名资料",
        source: stringParam(routePlan.extractedParams.source) || parsed?.source,
        projectId: context.projectId,
        content,
        metadata: { requestId: context.requestId, sessionId: context.sessionId }
      },
      context.sessionId,
      tracker,
      "workflow.ingest_text_database",
      userId
    );
    await tracker?.stepCompleted("execution", "资料已写入知识库。", { result });
    return result;
  }

  private async ingestWeChatArticle(context: RequestContext, url: string, tracker?: RunTracker, userId?: string): Promise<ExecutionResult> {
    try {
      const article = await this.wechatArticles.fetchArticle(url);
      await tracker?.metadata({ progress: { type: "wechat_article_fetched", url, title: article.title } }, "文章内容已获取，正在写入知识库。");
      const result = await this.writeDocumentWithProgress(
        {
          title: article.title,
          source: article.url,
          projectId: context.projectId,
          content: article.content,
          metadata: {
            requestId: context.requestId,
            sessionId: context.sessionId,
            workflow: "workflow.ingest_wechat_article",
            author: article.author,
            publishTime: article.publishTime,
            markdownFile: article.markdownFile,
            infoFile: article.infoFile,
            wespyInfo: article.rawInfo
          }
        },
        context.sessionId,
        tracker,
        "workflow.ingest_wechat_article",
        userId
      );

      return {
        ...result,
        capabilityId: "workflow.ingest_wechat_article",
        message: "公众号文章已通过 WeSpy 获取，并写入 SQLite 与 LanceDB。",
        output: { ...result.output, source: article.url, author: article.author, publishTime: article.publishTime }
      };
    } catch (error) {
      return { status: "failed", capabilityId: "workflow.ingest_wechat_article", message: "公众号文章写入数据库失败。", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async writeDocumentWithProgress(
    input: StoredDocumentInput,
    sessionId: string,
    tracker?: RunTracker,
    capabilityId = "workflow.ingest_text_database",
    userId?: string
  ): Promise<ExecutionResult> {
    const result = await this.documents.writeDocument(input, async (event) => {
      await tracker?.metadata({ progress: event }, documentProgressMessage(event));
    });
    this.sqlite.upsertSessionState({
      sessionId,
      currentDocumentId: result.document.id,
      currentDocumentTitle: result.document.title,
      currentDocumentSource: result.document.source
    });
    await this.memory.createDocumentAnchorMemory({
      userId,
      projectId: result.document.projectId,
      sessionId,
      documentId: result.document.id,
      title: result.document.title,
      source: result.document.source,
      contentSample: result.document.content.slice(0, 1600)
    });
    return {
      status: "success",
      capabilityId,
      message: "文档已写入 SQLite 与 LanceDB。",
      output: { documentId: result.document.id, title: result.document.title, chunkCount: result.chunkCount }
    };
  }

  private async generateAnswer(
    context: RequestContext,
    routePlan: RoutePlan,
    executionResult?: ExecutionResult,
    evidencePack?: EvidencePack,
    skillPlan?: SkillPlan,
    skillResults?: SkillExecutionResult[],
    observation?: SkillObservation,
    memoryHits: MemoryHit[] = []
  ): Promise<string> {
    const generationInput = this.prepareGenerationInput(context, routePlan, executionResult, evidencePack, skillPlan, skillResults, observation, memoryHits);
    if (generationInput.kind === "static") {
      return generationInput.answer;
    }
    return this.ai.chat({ model: this.config.ai.chatModel, temperature: 0.3, messages: buildFinalMessages(generationInput.history, generationInput.prompt) });
  }

  private prepareGenerationInput(
    context: RequestContext,
    routePlan: RoutePlan,
    executionResult?: ExecutionResult,
    evidencePack?: EvidencePack,
    skillPlan?: SkillPlan,
    skillResults?: SkillExecutionResult[],
    observation?: SkillObservation,
    memoryHits: MemoryHit[] = []
  ): GenerationInput {
    if (executionResult?.capabilityId === "workflow.ingest_text_database" || executionResult?.capabilityId === "workflow.ingest_wechat_article") {
      return { kind: "static", answer: this.renderWorkflowAnswer(executionResult) };
    }

    if (!this.ai.canChat(this.config.ai.chatModel)) {
      return {
        kind: "static",
        answer: evidencePack ? renderEvidenceFallback(evidencePack.items) : "云端生成模型未配置。请在 .env 中设置 AI_API_KEY 和 AI_CHAT_MODEL。"
      };
    }

    const history = this.sqlite.listSessionMessages(context.sessionId, 8);
    const answerStrategy = skillPlan?.answerStrategy ?? routePlan.answerStrategy ?? "direct";
    const prompt = buildFinalPrompt({
      request: context,
      routePlan,
      evidencePack,
      executionResult,
      skillPlan,
      skillResults,
      observation,
      answerStrategy,
      constraints: defaultConstraints(answerStrategy),
      memoryHits
    });
    return { kind: "model", history, prompt };
  }

  private async *generateAnswerStreamFromPrepared(generationInput: GenerationInput): AsyncGenerator<string> {
    if (generationInput.kind === "static") {
      yield generationInput.answer;
      return;
    }
    for await (const chunk of this.ai.streamChat({ model: this.config.ai.chatModel, temperature: 0.3, messages: buildFinalMessages(generationInput.history, generationInput.prompt) })) {
      yield chunk;
    }
  }

  private renderWorkflowAnswer(executionResult: ExecutionResult): string {
    if (executionResult.status === "success") {
      const title = executionResult.output?.title ? `，标题：${String(executionResult.output.title)}` : "";
      return `已写入数据库${title}。文档 ID：${String(executionResult.output?.documentId)}，切片数：${String(executionResult.output?.chunkCount)}。`;
    }
    return `写入数据库失败：${executionResult.error ?? executionResult.message}`;
  }
}

type GenerationInput =
  | { kind: "static"; answer: string }
  | { kind: "model"; history: Array<{ role: "user" | "assistant"; content: string }>; prompt: string };


export function isTimeoutError(error: unknown): boolean {
  if (error instanceof AiTimeoutError) {
    return true;
  }
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.includes("This operation was aborted");
  }
  return false;
}

function renderGenerationFallback(error: unknown, evidencePack?: EvidencePack): string {
  if (!evidencePack?.items.length) {
    return "最终生成模型响应超时，请稍后重试或缩短问题。";
  }

  const items = evidencePack.items.slice(0, 5).map((item, index) => {
    const excerpt = item.content.length > 500 ? `${item.content.slice(0, 500)}…` : item.content;
    return [
      `${index + 1}. ${item.title}`,
      `- source: ${item.source ?? "local-db"}`,
      `- chunkIndex: ${item.chunkIndex ?? "unknown"}`,
      `- 摘要: ${excerpt}`
    ].join("\n");
  });
  const detail = error instanceof AiTimeoutError ? `（${error.phase} 超时 ${error.timeoutMs}ms）` : "";
  return [`最终生成模型超时${detail}。已先返回本次检索到的资料摘要：`, ...items].join("\n\n");
}

function buildFinalMessages(history: Array<{ role: "user" | "assistant"; content: string }>, prompt: string) {
  return [
    { role: "system" as const, content: "你是 AI Orchestrator 的最终生成模型。你不重新决定系统路径，只基于给定任务包回答。" },
    ...history,
    { role: "user" as const, content: prompt }
  ];
}

function createRequestContext(input: { message: string; sessionId?: string; userId?: string; projectId?: string }, defaultProjectId: string): RequestContext {
  return { requestId: randomUUID(), sessionId: input.sessionId || randomUUID(), userId: input.userId, projectId: input.projectId || defaultProjectId, message: input.message, createdAt: new Date().toISOString() };
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function renderRouteMessage(routePlan: RoutePlan): string {
  if (routePlan.needsWorkflow || routePlan.taskType === "workflow") {
    if (routePlan.candidateCapabilities.includes("workflow.ingest_wechat_article")) return "判断完成：需要抓取公众号文章并写入知识库。";
    return "判断完成：需要执行资料写入流程。";
  }
  if (routePlan.needsRag || routePlan.needsSkill) return "判断完成：需要调用资料 Skill 获取证据后回答。";
  return "判断完成：这是普通对话，将直接生成回答。";
}

function renderSkillPlanMessage(skillPlan: SkillPlan): string {
  if (skillPlan.calls.length === 0) return skillPlan.answerStrategy === "workflow" ? "该请求将由工作流处理。" : "无需调用资料 Skill，可以直接回答。";
  return "我需要先从已保存资料里查找相关内容。";
}

function guardedNoEvidenceAnswer(skillPlan: SkillPlan, observation: SkillObservation): string | undefined {
  if (skillPlan.requiresEvidence && !observation.enoughToAnswer) {
    return skillPlan.answerStrategy === "citation" ? "我没有找到可引用的原文段落，不能提供原文引用。" : "我没有从已保存资料中找到足够证据，不能可靠回答。你可以指定文档、重新入库，或换一个更明确的问题。";
  }
  return undefined;
}

function mergeEvidencePacks(skillResults: SkillExecutionResult[]): EvidencePack | undefined {
  const seen = new Set<string>();
  const items: EvidenceItem[] = [];
  const skillIds: string[] = [];
  const queries: string[] = [];
  for (const result of skillResults) {
    if (!result.evidencePack) continue;
    skillIds.push(result.skillId);
    queries.push(result.evidencePack.query);
    for (const item of result.evidencePack.items) {
      const key = item.chunkId || `${item.documentId}:${item.chunkIndex ?? item.content.slice(0, 32)}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    }
  }
  if (skillResults.length === 0) return undefined;
  return { query: [...new Set(queries)].join(" | "), skillId: [...new Set(skillIds)].join(","), items };
}

function renderAmbiguousDocumentAnswer(candidates: Array<{ documentId: string; title: string; source?: string; reason: string }>): string {
  const lines = candidates.slice(0, 5).map((candidate, index) => `${index + 1}. 《${candidate.title}》 documentId=${candidate.documentId}${candidate.source ? ` source=${candidate.source}` : ""} (${candidate.reason})`);
  return [`找到多篇候选文档，需要你指定要分析哪一篇：`, ...lines].join("\n");
}

function documentProgressMessage(event: DocumentWriteProgressEvent): string {
  switch (event.type) {
    case "document_created": return "文档记录已创建。";
    case "chunks_created": return `已完成切片，共 ${event.chunkCount} 段。`;
    case "embedding_started": return "正在生成向量表示。";
    case "embedding_progress": return `向量生成进度：${event.completed}/${event.total}。`;
    case "vectors_written": return `向量已写入，共 ${event.vectorCount} 条。`;
  }
}

function renderEvidenceFallback(items: Array<{ title: string; content: string; source?: string }>): string {
  if (items.length === 0) return "没有从数据库中检索到相关资料。";
  return items.map((item, index) => `证据 ${index + 1}｜${item.title}${item.source ? `｜${item.source}` : ""}\n${item.content}`).join("\n\n");
}
