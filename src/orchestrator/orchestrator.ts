import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import type {
  ChatResponse,
  ChatStreamCallbacks,
  ConversationContextPack,
  ConversationSession,
  DocumentWriteProgressEvent,
  ExecutionResult,
  EvidenceItem,
  EvidencePack,
  MemoryHit,
  ReasoningCandidate,
  RequestContext,
  RoutePlan,
  SessionRequirementMemory,
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
import { formatUserFacingError, RunTracker } from "./runTracker.js";
import { SkillPlanner } from "./skillPlanner.js";
import { SkillExecutor } from "./skillExecutor.js";
import { observeSkillResults } from "./skillObserver.js";
import { loadCapabilities } from "./registry.js";
import { MemoryService } from "../services/memoryService.js";
import { ConversationService } from "../services/conversationService.js";
import { ContextCompressor } from "../services/contextCompressor.js";
import { CollectedContentWorkflow } from "../services/collectedContentWorkflow.js";
import { ParallelRetriever } from "./parallelRetriever.js";
import { DocumentResolver } from "./documentResolver.js";
import { ParallelReasoner } from "./parallelReasoner.js";
import { SessionRequirementMemoryService } from "../services/sessionRequirementMemoryService.js";

export class Orchestrator {
  private readonly router: Router;
  private readonly wechatArticles: WeChatArticleWorkflow;
  private readonly skillPlanner = new SkillPlanner();
  private readonly skillExecutor: SkillExecutor;
  private readonly parallelRetriever: ParallelRetriever;
  private readonly documentResolver: DocumentResolver;
  private readonly parallelReasoner: ParallelReasoner;
  private readonly conversationService: ConversationService;
  private readonly contextCompressor: ContextCompressor;
  private readonly collectedContentWorkflow: CollectedContentWorkflow;
  private readonly sessionRequirementMemory: SessionRequirementMemoryService;

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
    this.parallelReasoner = new ParallelReasoner(ai, config);
    this.conversationService = new ConversationService(sqlite);
    this.contextCompressor = new ContextCompressor(ai, config, sqlite, this.conversationService);
    this.collectedContentWorkflow = new CollectedContentWorkflow(sqlite, documents, memory);
    this.sessionRequirementMemory = new SessionRequirementMemoryService(ai, config, sqlite);
  }

  async chat(input: { message: string; sessionId?: string; userId?: string; projectId?: string }): Promise<ChatResponse> {
    const context = createRequestContext(input, this.config.defaultProjectId);
    const conversation = this.conversationService.ensureConversationSession({ sessionId: input.sessionId, userId: input.userId, projectId: context.projectId, firstMessage: input.message });
    const shouldGenerateTitle = shouldGenerateConversationTitle(conversation, input.message);
    context.sessionId = conversation.id;
    const userMessage = this.conversationService.appendMessage({ sessionId: context.sessionId, role: "user", content: context.message, createdAt: context.createdAt });
    let sessionRequirementMemory: SessionRequirementMemory | undefined = await this.sessionRequirementMemory.refineBeforeAnswer({
      sessionId: context.sessionId,
      projectId: context.projectId,
      userId: context.userId,
      userMessage: context.message,
      userMessageId: userMessage.id
    });

    const sessionState = this.sqlite.getSessionState(context.sessionId);
    const routePlan = await this.router.route(context);
    this.sqlite.insertRouteLog(context, routePlan);
    const hints = await this.parallelRetriever.searchHints(context, routePlan);
    const memoryHits = hints.memoryHits;
    const documentResolution = this.documentResolver.resolve({ context, routePlan, sessionState, memoryHits, documentCandidates: hints.documentCandidates });
    routePlan.documentResolution = documentResolution;
    if (documentResolution.status === "ambiguous") {
      const answer = renderAmbiguousDocumentAnswer(documentResolution.candidates);
      const assistantMessage = this.conversationService.appendMessage({ sessionId: context.sessionId, role: "assistant", content: answer });
      sessionRequirementMemory = await this.refineSessionRequirementAfterAnswer({ context, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id, answer, current: sessionRequirementMemory });
      await this.updateConversationTitleAfterFirstTurn({ sessionId: context.sessionId, question: context.message, answer, enabled: shouldGenerateTitle });
      return { answer, routePlan, memoryHits, conversation: this.sqlite.getConversationSession(context.sessionId) ?? conversation, sessionRequirementMemory };
    }
    const skillPlan = this.skillPlanner.plan(context, routePlan, sessionState, loadCapabilities(), documentResolution, memoryHits);
    routePlan.skillPlan = skillPlan;
    routePlan.answerStrategy = skillPlan.answerStrategy;
    routePlan.requiresEvidence = skillPlan.requiresEvidence;

    const executionResult = await this.executeIfNeeded(context, routePlan, undefined, context.userId);
    let { skillResults, observation, evidencePack } = await this.executeSkillsIfNeeded(context, skillPlan);
    evidencePack = evidencePack ? await this.documents.expandEvidencePack({ ...evidencePack, memoryHits, retrievalSources: [...(evidencePack.retrievalSources ?? []), "memory_items"] }) : undefined;
    const guardAnswer = guardedNoEvidenceAnswer(skillPlan, observation);
    const generation = guardAnswer ? undefined : await this.generateAnswer(context, routePlan, executionResult, evidencePack, skillPlan, skillResults, observation, memoryHits, sessionRequirementMemory);
    const answer = guardAnswer ?? generation?.answer ?? "";
    const conversationContext = generation?.conversationContext;

    const assistantMessage = this.conversationService.appendMessage({ sessionId: context.sessionId, role: "assistant", content: answer, contentType: executionResult ? "workflow_result" : "markdown" });
    sessionRequirementMemory = await this.refineSessionRequirementAfterAnswer({ context, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id, answer, current: sessionRequirementMemory });
    await this.updateConversationTitleAfterFirstTurn({ sessionId: context.sessionId, question: context.message, answer, enabled: shouldGenerateTitle });
    return { answer, routePlan, evidencePack, executionResult, skillPlan, skillResults, observation, memoryHits, conversation: this.sqlite.getConversationSession(context.sessionId) ?? conversation, conversationContext, sessionRequirementMemory, reasoningCandidates: generation?.reasoningCandidates };
  }

  async chatStream(
    input: { message: string; sessionId?: string; userId?: string; projectId?: string },
    callbacks: ChatStreamCallbacks
  ): Promise<ChatResponse> {
    const context = createRequestContext(input, this.config.defaultProjectId);
    const conversation = this.conversationService.ensureConversationSession({ sessionId: input.sessionId, userId: input.userId, projectId: context.projectId, firstMessage: input.message });
    const shouldGenerateTitle = shouldGenerateConversationTitle(conversation, input.message);
    context.sessionId = conversation.id;
    const userMessage = this.conversationService.appendMessage({ sessionId: context.sessionId, role: "user", content: context.message, createdAt: context.createdAt });

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
    let conversationContext: ConversationContextPack | undefined;
    let sessionRequirementMemory: SessionRequirementMemory | undefined;
    let reasoningCandidates: ReasoningCandidate[] | undefined;
    let assistantMessageId: string | undefined;

    const ensureAssistantMessage = (contentType: "markdown" | "workflow_result" | "error" = "markdown"): string => {
      if (assistantMessageId) {
        return assistantMessageId;
      }
      const message = this.conversationService.appendMessage({
        sessionId: context.sessionId,
        runId,
        role: "assistant",
        content: "",
        contentType,
        metadata: { status: "streaming", runId }
      });
      assistantMessageId = message.id;
      return assistantMessageId;
    };

    const persistAssistantMessage = (
      content: string,
      status: "streaming" | "completed" | "completed_with_fallback" | "failed",
      contentType: "markdown" | "workflow_result" | "error" = "markdown",
      metadata: Record<string, unknown> = {}
    ): void => {
      const messageId = ensureAssistantMessage(contentType);
      this.conversationService.updateMessage({
        id: messageId,
        content,
        contentType,
        metadata: { status, runId, ...metadata }
      });
    };

    try {
      callbacks.onEvent({ type: "conversation_created", runId, visibleMessage: "对话会话已就绪。", conversation });
      await tracker.runStarted("已收到问题，正在判断处理方式。");
      await tracker.stepCompleted("intake", "问题已进入 Orchestrator。", {
        requestId: context.requestId,
        sessionId: context.sessionId,
        projectId: context.projectId
      });

      sessionRequirementMemory = await this.sessionRequirementMemory.refineBeforeAnswer({
        sessionId: context.sessionId,
        projectId: context.projectId,
        userId: context.userId,
        userMessage: context.message,
        userMessageId: userMessage.id
      });
      await tracker.metadata({ sessionRequirementMemory }, "本轮用户需求 memory 已更新。");

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
        persistAssistantMessage(finalAnswer, "completed");
        await tracker.answerDelta(finalAnswer);
        sessionRequirementMemory = await this.refineSessionRequirementAfterAnswer({ context, userMessageId: userMessage.id, assistantMessageId, answer: finalAnswer, current: sessionRequirementMemory });
        await this.updateConversationTitleAfterFirstTurn({ sessionId: context.sessionId, question: context.message, answer: finalAnswer, enabled: shouldGenerateTitle });
        const updatedConversation = this.sqlite.getConversationSession(context.sessionId) ?? conversation;
        callbacks.onEvent({ type: "conversation_updated", runId, visibleMessage: "对话已更新。", conversation: updatedConversation });
        const result = { answer: finalAnswer, routePlan, evidencePack, executionResult, skillPlan, skillResults, observation, memoryHits, conversation: updatedConversation, conversationContext, sessionRequirementMemory, reasoningCandidates };
        await tracker.done(result, "completed");
        return result;
      }
      if (documentResolution.status === "resolved") {
        callbacks.onEvent({ type: "document_resolved", runId, visibleMessage: `已定位到《${documentResolution.title ?? documentResolution.documentId}》。`, documentResolution });
      }
      skillPlan = this.skillPlanner.plan(context, routePlan, sessionState, loadCapabilities(), documentResolution, memoryHits);
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
        persistAssistantMessage(finalAnswer, "completed");
        await tracker.answerDelta(finalAnswer);
      } else {
        await tracker.observation(observation, "证据足够，开始生成回答。");
        await tracker.stepStarted("context", "正在整理证据和上下文。");
        callbacks.onEvent({ type: "context_compression_started", runId, visibleMessage: "正在压缩历史对话上下文。", sessionId: context.sessionId });
        const generationInput = await this.prepareGenerationInput(context, routePlan, executionResult, evidencePack, skillPlan, skillResults, observation, memoryHits, sessionRequirementMemory);
        conversationContext = generationInput.conversationContext;
        reasoningCandidates = generationInput.reasoningCandidates;
        if (conversationContext) callbacks.onEvent({ type: "context_compression_completed", runId, visibleMessage: "对话上下文已整理。", conversationContext });
        await tracker.stepCompleted("context", "上下文已整理完成。", {
          hasEvidence: Boolean(evidencePack),
          evidenceCount: evidencePack?.items.length ?? 0,
          hasExecutionResult: Boolean(executionResult),
          skillResultCount: skillResults.length,
          reasoningCandidateCount: reasoningCandidates?.length ?? 0
        });

        await tracker.metadata({ routePlan, evidencePack, executionResult, skillPlan, skillResults, observation, memoryHits, sessionRequirementMemory, reasoningCandidates });
        await tracker.stepStarted("generation", "正在生成最终回答。");
        let usedFallback = false;
        try {
          for await (const chunk of this.generateAnswerStreamFromPrepared(generationInput)) {
            finalAnswer += chunk;
            persistAssistantMessage(finalAnswer, "streaming", executionResult ? "workflow_result" : "markdown");
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
          persistAssistantMessage(finalAnswer, "completed_with_fallback", executionResult ? "workflow_result" : "markdown", {
            fallback: true
          });
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

      persistAssistantMessage(finalAnswer, completedWithFallback ? "completed_with_fallback" : "completed", executionResult ? "workflow_result" : "markdown");
      sessionRequirementMemory = await this.refineSessionRequirementAfterAnswer({ context, userMessageId: userMessage.id, assistantMessageId, answer: finalAnswer, current: sessionRequirementMemory });
      await this.updateConversationTitleAfterFirstTurn({ sessionId: context.sessionId, question: context.message, answer: finalAnswer, enabled: shouldGenerateTitle });
      const updatedConversation = this.sqlite.getConversationSession(context.sessionId) ?? conversation;
      callbacks.onEvent({ type: "conversation_updated", runId, visibleMessage: "对话已更新。", conversation: updatedConversation });
      const result = { answer: finalAnswer, routePlan, evidencePack, executionResult, skillPlan, skillResults, observation, memoryHits, conversation: updatedConversation, conversationContext, sessionRequirementMemory, reasoningCandidates };
      await tracker.done(result, completedWithFallback ? "completed_with_fallback" : "completed");
      return result;
    } catch (error) {
      persistAssistantMessage(finalAnswer || formatUserFacingError(error), "failed", "error", {
        error: error instanceof Error ? error.message : String(error)
      });
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
      output: { documentId: result.document.id, title: result.document.title, tags: result.document.tags, chunkCount: result.chunkCount }
    };
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

    if (!routePlan.candidateCapabilities.includes("workflow.ingest_collected_content") && !routePlan.candidateCapabilities.includes("workflow.ingest_text_database")) {
      return { status: "skipped", message: "没有匹配到可执行的 Workflow。" };
    }

    await tracker?.stepStarted("execution", "正在整理采集内容并写入知识库。", { capabilityId: "workflow.ingest_collected_content" });
    const parsed = extractWritePayload(context.message);
    const content = stringParam(routePlan.extractedParams.content) || parsed?.content;
    if (!content) {
      const result: ExecutionResult = { status: "failed", capabilityId: "workflow.ingest_collected_content", message: "采集信息入库缺少 content 参数。", error: "missing content" };
      await tracker?.stepFailed("execution", "写入知识库失败，缺少可写入内容。", result.error, { result });
      return result;
    }

    const result = await this.collectedContentWorkflow.ingest({
      userId,
      sessionId: context.sessionId,
      projectId: context.projectId,
      kind: (stringParam(routePlan.extractedParams.kind) as "manual_text") || "manual_text",
      title: stringParam(routePlan.extractedParams.title) || parsed?.title || "未命名资料",
      source: stringParam(routePlan.extractedParams.source) || parsed?.source,
      content,
      metadata: { requestId: context.requestId, sessionId: context.sessionId, workflow: "workflow.ingest_collected_content" },
      onProgress: async (event) => {
        if (event.type === "collected_item_created") {
          await tracker?.event({ type: "collected_item_created", runId: trackerRunId(tracker), visibleMessage: "采集记录已创建。", collectedItem: event.item });
          await tracker?.metadata({ progress: event, collectedItem: event.item }, "采集记录已创建。");
        } else if (event.type === "collected_item_completed") {
          await tracker?.event({ type: "collected_item_completed", runId: trackerRunId(tracker), visibleMessage: "采集内容注册完成。", collectedItem: event.item });
          await tracker?.metadata({ progress: event, collectedItem: event.item }, "采集内容注册完成。");
        } else if (event.type === "collected_item_failed") {
          await tracker?.metadata({ progress: event, collectedItem: event.item }, "采集内容注册失败。");
        } else {
          await tracker?.metadata({ progress: event }, documentProgressMessage(event as DocumentWriteProgressEvent));
        }
      }
    });
    await tracker?.stepCompleted("execution", "采集资料已写入知识库。", { result });
    return result;
  }

  private async ingestWeChatArticle(context: RequestContext, url: string, tracker?: RunTracker, userId?: string): Promise<ExecutionResult> {
    try {
      const article = await this.wechatArticles.fetchArticle(url);
      await tracker?.metadata({ progress: { type: "wechat_article_fetched", url, title: article.title } }, "文章内容已获取，正在写入知识库。");
      const result = await this.collectedContentWorkflow.ingest({
        userId,
        sessionId: context.sessionId,
        projectId: context.projectId,
        kind: "wechat_article",
        title: article.title,
        source: article.url,
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
        },
        onProgress: async (event) => {
          if (event.type === "collected_item_created" || event.type === "collected_item_completed" || event.type === "collected_item_failed") {
            if (event.type === "collected_item_created") await tracker?.event({ type: "collected_item_created", runId: trackerRunId(tracker), visibleMessage: "采集记录已创建。", collectedItem: event.item });
            if (event.type === "collected_item_completed") await tracker?.event({ type: "collected_item_completed", runId: trackerRunId(tracker), visibleMessage: "采集内容注册完成。", collectedItem: event.item });
            await tracker?.metadata({ progress: event, collectedItem: event.item }, event.type === "collected_item_created" ? "采集记录已创建。" : "采集内容注册完成。");
          } else {
            await tracker?.metadata({ progress: event }, documentProgressMessage(event as DocumentWriteProgressEvent));
          }
        }
      });
      return {
        ...result,
        capabilityId: "workflow.ingest_wechat_article",
        message: "公众号文章已通过 WeSpy 获取，并复用采集内容链路写入 SQLite 与 LanceDB。",
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
      await tracker?.metadata({ progress: event }, documentProgressMessage(event as DocumentWriteProgressEvent));
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
      output: { documentId: result.document.id, title: result.document.title, tags: result.document.tags, chunkCount: result.chunkCount }
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
    memoryHits: MemoryHit[] = [],
    sessionRequirementMemory?: SessionRequirementMemory
  ): Promise<{ answer: string; conversationContext?: ConversationContextPack; reasoningCandidates?: ReasoningCandidate[] }> {
    const generationInput = await this.prepareGenerationInput(context, routePlan, executionResult, evidencePack, skillPlan, skillResults, observation, memoryHits, sessionRequirementMemory);
    if (generationInput.kind === "static") {
      return { answer: generationInput.answer, conversationContext: generationInput.conversationContext, reasoningCandidates: generationInput.reasoningCandidates };
    }
    return {
      answer: await this.ai.chat({ model: this.config.ai.chatModel, temperature: 0.3, messages: buildFinalMessages(generationInput.prompt) }),
      conversationContext: generationInput.conversationContext,
      reasoningCandidates: generationInput.reasoningCandidates
    };
  }

  private async prepareGenerationInput(
    context: RequestContext,
    routePlan: RoutePlan,
    executionResult?: ExecutionResult,
    evidencePack?: EvidencePack,
    skillPlan?: SkillPlan,
    skillResults?: SkillExecutionResult[],
    observation?: SkillObservation,
    memoryHits: MemoryHit[] = [],
    sessionRequirementMemory?: SessionRequirementMemory
  ): Promise<GenerationInput> {
    const conversationContext = await this.contextCompressor.buildContextPack({ sessionId: context.sessionId, projectId: context.projectId, userId: context.userId });
    if (executionResult?.capabilityId === "workflow.ingest_text_database" || executionResult?.capabilityId === "workflow.ingest_wechat_article" || executionResult?.capabilityId === "workflow.ingest_collected_content") {
      return { kind: "static", answer: this.renderWorkflowAnswer(executionResult), conversationContext };
    }

    if (!this.ai.canChat(this.config.ai.chatModel)) {
      return {
        kind: "static",
        answer: evidencePack ? renderEvidenceFallback(evidencePack.items) : "云端生成模型未配置。请在 .env 中设置 AI_API_KEY 和 AI_CHAT_MODEL。",
        conversationContext
      };
    }

    const answerStrategy = skillPlan?.answerStrategy ?? routePlan.answerStrategy ?? "direct";
    const finalContext = {
      request: context,
      routePlan,
      evidencePack,
      executionResult,
      skillPlan,
      skillResults,
      observation,
      answerStrategy,
      constraints: defaultConstraints(answerStrategy),
      memoryHits,
      conversationContext,
      sessionRequirementMemory
    };
    const reasoningCandidates = await this.parallelReasoner.generateCandidates(finalContext);
    const prompt = buildFinalPrompt({ ...finalContext, reasoningCandidates });
    return { kind: "model", prompt, conversationContext, reasoningCandidates };
  }

  private async *generateAnswerStreamFromPrepared(generationInput: GenerationInput): AsyncGenerator<string> {
    if (generationInput.kind === "static") {
      yield generationInput.answer;
      return;
    }
    for await (const chunk of this.ai.streamChat({ model: this.config.ai.chatModel, temperature: 0.3, messages: buildFinalMessages(generationInput.prompt) })) {
      yield chunk;
    }
  }

  private async refineSessionRequirementAfterAnswer(params: {
    context: RequestContext;
    userMessageId: string;
    assistantMessageId?: string;
    answer: string;
    current?: SessionRequirementMemory;
  }): Promise<SessionRequirementMemory | undefined> {
    return await this.sessionRequirementMemory.refineAfterAnswer({
      sessionId: params.context.sessionId,
      projectId: params.context.projectId,
      userId: params.context.userId,
      userMessage: params.context.message,
      userMessageId: params.userMessageId,
      assistantAnswer: params.answer,
      assistantMessageId: params.assistantMessageId
    }) ?? params.current;
  }

  private async updateConversationTitleAfterFirstTurn(params: {
    sessionId: string;
    question: string;
    answer: string;
    enabled: boolean;
  }): Promise<void> {
    if (!params.enabled) {
      return;
    }

    const title = await this.generateConversationTitle(params.question, params.answer);
    if (!title) {
      return;
    }
    this.conversationService.updateSessionTitle(params.sessionId, title);
  }

  private async generateConversationTitle(question: string, answer: string): Promise<string | undefined> {
    const model = this.config.ai.compressorModel || this.config.ai.routerModel || this.config.ai.chatModel;
    if (!this.ai.canChat(model)) {
      return undefined;
    }

    try {
      const raw = await this.ai.chat({
        model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "你是对话标题生成器。根据用户第一轮问题和助手回答，推理出一个中文对话主题标题。只输出标题本身，不要解释，不要加引号。标题要具体、短、可读，8 到 18 个汉字优先。"
          },
          {
            role: "user",
            content: `用户问题：\n${question.slice(0, 1200)}\n\n助手回答：\n${answer.slice(0, 2400)}`
          }
        ]
      });
      return normalizeGeneratedTitle(raw);
    } catch {
      return undefined;
    }
  }

  private renderWorkflowAnswer(executionResult: ExecutionResult): string {
    if (executionResult.status === "success") {
      const title = executionResult.output?.title ? `，标题：${String(executionResult.output.title)}` : "";
      const tags = Array.isArray(executionResult.output?.tags) && executionResult.output.tags.length > 0 ? `，标签：${executionResult.output.tags.map(String).join("、")}` : "";
      return `已写入数据库${title}${tags}。文档 ID：${String(executionResult.output?.documentId)}，切片数：${String(executionResult.output?.chunkCount)}。`;
    }
    return `写入数据库失败：${executionResult.error ?? executionResult.message}`;
  }
}

type GenerationInput =
  | { kind: "static"; answer: string; conversationContext?: ConversationContextPack; reasoningCandidates?: ReasoningCandidate[] }
  | { kind: "model"; prompt: string; conversationContext?: ConversationContextPack; reasoningCandidates?: ReasoningCandidate[] };


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

function buildFinalMessages(prompt: string) {
  return [
    { role: "system" as const, content: "你是 AI Orchestrator 的最终生成模型。你不重新决定系统路径，只基于给定任务包回答。" },
    { role: "user" as const, content: prompt }
  ];
}

function createRequestContext(input: { message: string; sessionId?: string; userId?: string; projectId?: string }, defaultProjectId: string): RequestContext {
  return { requestId: randomUUID(), sessionId: input.sessionId || randomUUID(), userId: input.userId, projectId: input.projectId || defaultProjectId, message: input.message, createdAt: new Date().toISOString() };
}

function shouldGenerateConversationTitle(conversation: ConversationSession, firstMessage: string): boolean {
  if (conversation.messageCount !== 0) {
    return false;
  }
  const title = conversation.title.trim();
  return /^新对话$|^未命名对话$/.test(title) || title === firstMessage.replace(/\s+/g, " ").trim().slice(0, 30);
}

function normalizeGeneratedTitle(value: string): string | undefined {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return undefined;
  }

  const title = firstLine
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/^标题[:：]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。.!！?？]+$/u, "");
  if (!title || title.length < 2) {
    return undefined;
  }
  return title.slice(0, 30);
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

function trackerRunId(tracker?: RunTracker): string {
  return String((tracker as unknown as { runId?: string })?.runId ?? "");
}

function documentProgressMessage(event: DocumentWriteProgressEvent): string {
  switch (event.type) {
    case "document_created": return "文档记录已创建。";
    case "document_updated": return "文档记录已更新。";
    case "tags_generated": return event.tags.length > 0 ? `已生成标签：${event.tags.map((tag) => tag.name).join("、")}。` : "未生成有效标签。";
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
