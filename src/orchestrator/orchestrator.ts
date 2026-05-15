import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import type {
  ChatResponse,
  ChatStreamCallbacks,
  DocumentWriteProgressEvent,
  ExecutionResult,
  EvidencePack,
  RequestContext,
  RoutePlan,
  StoredDocumentInput
} from "../types.js";
import { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import { buildFinalPrompt, defaultConstraints } from "./contextBuilder.js";
import { extractQueryPayload, extractWritePayload, Router } from "./router.js";
import { DocumentService } from "../services/documentService.js";
import { extractWeChatArticleUrl, WeChatArticleWorkflow } from "../services/weChatArticleWorkflow.js";
import { RunTracker } from "./runTracker.js";

export class Orchestrator {
  private readonly router: Router;
  private readonly wechatArticles: WeChatArticleWorkflow;

  constructor(
    private readonly config: AppConfig,
    private readonly sqlite: SqliteStore,
    private readonly documents: DocumentService,
    private readonly ai: OpenAiCompatibleClient
  ) {
    this.router = new Router(ai, config.ai.routerModel);
    this.wechatArticles = new WeChatArticleWorkflow(config.wespy);
  }

  async chat(input: { message: string; sessionId?: string; userId?: string; projectId?: string }): Promise<ChatResponse> {
    const context = createRequestContext(input, this.config.defaultProjectId);
    this.sqlite.insertMessage({
      id: randomUUID(),
      sessionId: context.sessionId,
      role: "user",
      content: context.message,
      createdAt: context.createdAt
    });

    const routePlan = await this.router.route(context);
    this.sqlite.insertRouteLog(context, routePlan);

    const executionResult = await this.executeIfNeeded(context, routePlan);
    const evidencePack = await this.retrieveIfNeeded(context, routePlan, executionResult);
    const answer = await this.generateAnswer(context, routePlan, executionResult, evidencePack);

    this.sqlite.insertMessage({
      id: randomUUID(),
      sessionId: context.sessionId,
      role: "assistant",
      content: answer,
      createdAt: new Date().toISOString()
    });

    return {
      answer,
      routePlan,
      evidencePack,
      executionResult
    };
  }

  async chatStream(
    input: { message: string; sessionId?: string; userId?: string; projectId?: string },
    callbacks: ChatStreamCallbacks
  ): Promise<ChatResponse> {
    const context = createRequestContext(input, this.config.defaultProjectId);
    this.sqlite.insertMessage({
      id: randomUUID(),
      sessionId: context.sessionId,
      role: "user",
      content: context.message,
      createdAt: context.createdAt
    });

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
    let executionResult: ExecutionResult | undefined;
    let evidencePack: EvidencePack | undefined;
    let finalAnswer = "";

    try {
      await tracker.runStarted("已收到问题，正在判断处理方式。");
      await tracker.stepCompleted("intake", "问题已进入 Orchestrator。", {
        requestId: context.requestId,
        sessionId: context.sessionId,
        projectId: context.projectId
      });

      await tracker.stepStarted("router", "正在判断这是普通对话、资料查询还是工作流任务。");
      routePlan = await this.router.route(context);
      this.sqlite.insertRouteLog(context, routePlan);
      await tracker.stepCompleted("router", renderRouteMessage(routePlan), { routePlan });

      executionResult = await this.executeIfNeeded(context, routePlan, tracker);
      evidencePack = await this.retrieveIfNeeded(context, routePlan, executionResult, tracker);

      await tracker.stepStarted("context", "正在整理证据和上下文。");
      const generationInput = this.prepareGenerationInput(context, routePlan, executionResult, evidencePack);
      await tracker.stepCompleted("context", "上下文已整理完成。", {
        hasEvidence: Boolean(evidencePack),
        evidenceCount: evidencePack?.items.length ?? 0,
        hasExecutionResult: Boolean(executionResult)
      });

      await tracker.metadata({ routePlan, evidencePack, executionResult });

      await tracker.stepStarted("generation", "正在生成最终回答。");
      for await (const chunk of this.generateAnswerStreamFromPrepared(generationInput)) {
        finalAnswer += chunk;
        await tracker.answerDelta(chunk);
      }
      await tracker.stepCompleted("generation", "回答生成完成。", { answerLength: finalAnswer.length });

      this.sqlite.insertMessage({
        id: randomUUID(),
        sessionId: context.sessionId,
        role: "assistant",
        content: finalAnswer,
        createdAt: new Date().toISOString()
      });

      const result = {
        answer: finalAnswer,
        routePlan,
        evidencePack,
        executionResult
      };
      await tracker.done(result);
      return result;
    } catch (error) {
      await tracker.error(error);
      throw error;
    }
  }

  async writeDocument(input: StoredDocumentInput): Promise<ExecutionResult> {
    const result = await this.documents.writeDocument(input);
    return {
      status: "success",
      capabilityId: "workflow.ingest_text_database",
      message: "文档已写入 SQLite 与 LanceDB。",
      output: {
        documentId: result.document.id,
        title: result.document.title,
        chunkCount: result.chunkCount
      }
    };
  }

  private async executeIfNeeded(
    context: RequestContext,
    routePlan: RoutePlan,
    tracker?: RunTracker
  ): Promise<ExecutionResult | undefined> {
    if (!routePlan.needsWorkflow && routePlan.taskType !== "workflow") {
      return undefined;
    }

    const wechatUrl = stringParam(routePlan.extractedParams.url) || extractWeChatArticleUrl(context.message);
    if (wechatUrl && routePlan.candidateCapabilities.includes("workflow.ingest_wechat_article")) {
      await tracker?.stepStarted("execution", "正在抓取公众号文章内容。", { capabilityId: "workflow.ingest_wechat_article" });
      const result = await this.ingestWeChatArticle(context, wechatUrl, tracker);
      if (result.status === "failed") {
        await tracker?.stepFailed("execution", "公众号文章写入数据库失败。", result.error ?? result.message, { result });
      } else {
        await tracker?.stepCompleted("execution", "公众号文章已写入知识库。", { result });
      }
      return result;
    }

    if (!routePlan.candidateCapabilities.includes("workflow.ingest_text_database")) {
      return {
        status: "skipped",
        message: "没有匹配到可执行的 Workflow。"
      };
    }

    await tracker?.stepStarted("execution", "正在整理并写入知识库。", { capabilityId: "workflow.ingest_text_database" });
    const parsed = extractWritePayload(context.message);
    const content = stringParam(routePlan.extractedParams.content) || parsed?.content;
    if (!content) {
      const result: ExecutionResult = {
        status: "failed",
        capabilityId: "workflow.ingest_text_database",
        message: "写入数据库缺少 content 参数。",
        error: "missing content"
      };
      await tracker?.stepFailed("execution", "写入知识库失败，缺少可写入内容。", result.error, { result });
      return result;
    }

    const result = await this.writeDocumentWithProgress(
      {
        title: stringParam(routePlan.extractedParams.title) || parsed?.title || "未命名资料",
        source: stringParam(routePlan.extractedParams.source) || parsed?.source,
        projectId: context.projectId,
        content,
        metadata: {
          requestId: context.requestId,
          sessionId: context.sessionId
        }
      },
      tracker
    );
    await tracker?.stepCompleted("execution", "资料已写入知识库。", { result });
    return result;
  }

  private async ingestWeChatArticle(context: RequestContext, url: string, tracker?: RunTracker): Promise<ExecutionResult> {
    try {
      const article = await this.wechatArticles.fetchArticle(url);
      await tracker?.metadata(
        { progress: { type: "wechat_article_fetched", url, title: article.title } },
        "文章内容已获取，正在写入知识库。"
      );
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
        tracker,
        "workflow.ingest_wechat_article"
      );

      return {
        ...result,
        capabilityId: "workflow.ingest_wechat_article",
        message: "公众号文章已通过 WeSpy 获取，并写入 SQLite 与 LanceDB。",
        output: {
          ...result.output,
          source: article.url,
          author: article.author,
          publishTime: article.publishTime
        }
      };
    } catch (error) {
      return {
        status: "failed",
        capabilityId: "workflow.ingest_wechat_article",
        message: "公众号文章写入数据库失败。",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async writeDocumentWithProgress(
    input: StoredDocumentInput,
    tracker?: RunTracker,
    capabilityId = "workflow.ingest_text_database"
  ): Promise<ExecutionResult> {
    const result = await this.documents.writeDocument(input, async (event) => {
      await tracker?.metadata({ progress: event }, documentProgressMessage(event));
    });
    return {
      status: "success",
      capabilityId,
      message: "文档已写入 SQLite 与 LanceDB。",
      output: {
        documentId: result.document.id,
        title: result.document.title,
        chunkCount: result.chunkCount
      }
    };
  }

  private async retrieveIfNeeded(
    context: RequestContext,
    routePlan: RoutePlan,
    executionResult?: ExecutionResult,
    tracker?: RunTracker
  ) {
    if (!routePlan.needsRag || executionResult?.capabilityId?.startsWith("workflow.ingest_")) {
      return undefined;
    }

    const query =
      stringParam(routePlan.extractedParams.query) ||
      routePlan.searchQueries[0] ||
      extractQueryPayload(context.message) ||
      context.message;

    await tracker?.stepStarted("retrieval", "正在检索资料库。", { query, skillId: selectRetrievalSkill(routePlan) });
    const evidencePack = await this.documents.search({
      query,
      projectId: context.projectId,
      limit: 6,
      skillId: selectRetrievalSkill(routePlan)
    });
    const count = evidencePack.items.length;
    await tracker?.stepCompleted("retrieval", count > 0 ? `已找到 ${count} 条相关资料。` : "没有找到足够相关资料。", {
      query,
      count,
      skillId: evidencePack.skillId
    });
    return evidencePack;
  }

  private async generateAnswer(
    context: RequestContext,
    routePlan: RoutePlan,
    executionResult?: ExecutionResult,
    evidencePack?: EvidencePack
  ): Promise<string> {
    const generationInput = this.prepareGenerationInput(context, routePlan, executionResult, evidencePack);
    if (generationInput.kind === "static") {
      return generationInput.answer;
    }

    return this.ai.chat({
      model: this.config.ai.chatModel,
      temperature: 0.3,
      messages: buildFinalMessages(generationInput.history, generationInput.prompt)
    });
  }

  private prepareGenerationInput(
    context: RequestContext,
    routePlan: RoutePlan,
    executionResult?: ExecutionResult,
    evidencePack?: EvidencePack
  ): GenerationInput {
    if (
      executionResult?.capabilityId === "workflow.ingest_text_database" ||
      executionResult?.capabilityId === "workflow.ingest_wechat_article"
    ) {
      return { kind: "static", answer: this.renderWorkflowAnswer(executionResult) };
    }

    if (!this.ai.canChat(this.config.ai.chatModel)) {
      return {
        kind: "static",
        answer: evidencePack
          ? renderEvidenceFallback(evidencePack.items)
          : "云端生成模型未配置。请在 .env 中设置 AI_API_KEY 和 AI_CHAT_MODEL。"
      };
    }

    const history = this.sqlite.listSessionMessages(context.sessionId, 8);
    const prompt = buildFinalPrompt({
      request: context,
      routePlan,
      evidencePack,
      executionResult,
      constraints: defaultConstraints()
    });
    return { kind: "model", history, prompt };
  }

  private async *generateAnswerStreamFromPrepared(generationInput: GenerationInput): AsyncGenerator<string> {
    if (generationInput.kind === "static") {
      yield generationInput.answer;
      return;
    }

    for await (const chunk of this.ai.streamChat({
      model: this.config.ai.chatModel,
      temperature: 0.3,
      messages: buildFinalMessages(generationInput.history, generationInput.prompt)
    })) {
      yield chunk;
    }
  }

  private renderWorkflowAnswer(executionResult: ExecutionResult): string {
    if (executionResult.status === "success") {
      const title = executionResult.output?.title ? `，标题：${String(executionResult.output.title)}` : "";
      return `已写入数据库${title}。文档 ID：${String(executionResult.output?.documentId)}，切片数：${String(
        executionResult.output?.chunkCount
      )}。`;
    }
    return `写入数据库失败：${executionResult.error ?? executionResult.message}`;
  }
}

type GenerationInput =
  | { kind: "static"; answer: string }
  | { kind: "model"; history: Array<{ role: "user" | "assistant"; content: string }>; prompt: string };

function buildFinalMessages(history: Array<{ role: "user" | "assistant"; content: string }>, prompt: string) {
  return [
    {
      role: "system" as const,
      content: "你是 AI Orchestrator 的最终生成模型。你不重新决定系统路径，只基于给定任务包回答。"
    },
    ...history,
    { role: "user" as const, content: prompt }
  ];
}

function createRequestContext(
  input: { message: string; sessionId?: string; userId?: string; projectId?: string },
  defaultProjectId: string
): RequestContext {
  return {
    requestId: randomUUID(),
    sessionId: input.sessionId || randomUUID(),
    userId: input.userId,
    projectId: input.projectId || defaultProjectId,
    message: input.message,
    createdAt: new Date().toISOString()
  };
}

function selectRetrievalSkill(routePlan: RoutePlan): string {
  if (routePlan.candidateCapabilities.includes("skill.sqlite_query")) {
    return "skill.sqlite_query";
  }
  return "skill.lancedb_query";
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function renderRouteMessage(routePlan: RoutePlan): string {
  if (routePlan.needsWorkflow || routePlan.taskType === "workflow") {
    if (routePlan.candidateCapabilities.includes("workflow.ingest_wechat_article")) {
      return "判断完成：需要抓取公众号文章并写入知识库。";
    }
    return "判断完成：需要执行资料写入流程。";
  }
  if (routePlan.needsRag) {
    return "判断完成：需要检索资料库后回答。";
  }
  return "判断完成：这是普通对话，将直接生成回答。";
}

function documentProgressMessage(event: DocumentWriteProgressEvent): string {
  switch (event.type) {
    case "document_created":
      return "文档记录已创建。";
    case "chunks_created":
      return `已完成切片，共 ${event.chunkCount} 段。`;
    case "embedding_started":
      return "正在生成向量表示。";
    case "embedding_progress":
      return `向量生成进度：${event.completed}/${event.total}。`;
    case "vectors_written":
      return `向量已写入，共 ${event.vectorCount} 条。`;
  }
}

function renderEvidenceFallback(items: Array<{ title: string; content: string; source?: string }>): string {
  if (items.length === 0) {
    return "没有从数据库中检索到相关资料。";
  }

  return items
    .map((item, index) => `证据 ${index + 1}｜${item.title}${item.source ? `｜${item.source}` : ""}\n${item.content}`)
    .join("\n\n");
}
