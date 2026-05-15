import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import { SqliteStore } from "../storage/sqliteStore.js";
import type { ChatResponse, ExecutionResult, RequestContext, RoutePlan, StoredDocumentInput } from "../types.js";
import { OpenAiCompatibleClient } from "../ai/openAiCompatibleClient.js";
import { buildFinalPrompt, defaultConstraints } from "./contextBuilder.js";
import { extractQueryPayload, extractWritePayload, Router } from "./router.js";
import { DocumentService } from "../services/documentService.js";
import { extractWeChatArticleUrl, WeChatArticleWorkflow } from "../services/weChatArticleWorkflow.js";

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

  private async executeIfNeeded(context: RequestContext, routePlan: RoutePlan): Promise<ExecutionResult | undefined> {
    if (!routePlan.needsWorkflow && routePlan.taskType !== "workflow") {
      return undefined;
    }

    const wechatUrl = stringParam(routePlan.extractedParams.url) || extractWeChatArticleUrl(context.message);
    if (wechatUrl && routePlan.candidateCapabilities.includes("workflow.ingest_wechat_article")) {
      return this.ingestWeChatArticle(context, wechatUrl);
    }

    if (!routePlan.candidateCapabilities.includes("workflow.ingest_text_database")) {
      return {
        status: "skipped",
        message: "没有匹配到可执行的 Workflow。"
      };
    }

    const parsed = extractWritePayload(context.message);
    const content = stringParam(routePlan.extractedParams.content) || parsed?.content;
    if (!content) {
      return {
        status: "failed",
        capabilityId: "workflow.ingest_text_database",
        message: "写入数据库缺少 content 参数。",
        error: "missing content"
      };
    }

    return this.writeDocument({
      title: stringParam(routePlan.extractedParams.title) || parsed?.title || "未命名资料",
      source: stringParam(routePlan.extractedParams.source) || parsed?.source,
      projectId: context.projectId,
      content,
      metadata: {
        requestId: context.requestId,
        sessionId: context.sessionId
      }
    });
  }

  private async ingestWeChatArticle(context: RequestContext, url: string): Promise<ExecutionResult> {
    try {
      const article = await this.wechatArticles.fetchArticle(url);
      const result = await this.documents.writeDocument({
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
      });

      return {
        status: "success",
        capabilityId: "workflow.ingest_wechat_article",
        message: "公众号文章已通过 WeSpy 获取，并写入 SQLite 与 LanceDB。",
        output: {
          documentId: result.document.id,
          title: result.document.title,
          source: result.document.source,
          chunkCount: result.chunkCount,
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

  private async retrieveIfNeeded(
    context: RequestContext,
    routePlan: RoutePlan,
    executionResult?: ExecutionResult
  ) {
    if (!routePlan.needsRag || executionResult?.capabilityId?.startsWith("workflow.ingest_")) {
      return undefined;
    }

    const query =
      stringParam(routePlan.extractedParams.query) ||
      routePlan.searchQueries[0] ||
      extractQueryPayload(context.message) ||
      context.message;

    return this.documents.search({
      query,
      projectId: context.projectId,
      limit: 6
    });
  }

  private async generateAnswer(
    context: RequestContext,
    routePlan: RoutePlan,
    executionResult?: ExecutionResult,
    evidencePack?: Awaited<ReturnType<DocumentService["search"]>>
  ): Promise<string> {
    if (
      executionResult?.capabilityId === "workflow.ingest_text_database" ||
      executionResult?.capabilityId === "workflow.ingest_wechat_article"
    ) {
      if (executionResult.status === "success") {
        const title = executionResult.output?.title ? `，标题：${String(executionResult.output.title)}` : "";
        return `已写入数据库${title}。文档 ID：${String(executionResult.output?.documentId)}，切片数：${String(
          executionResult.output?.chunkCount
        )}。`;
      }
      return `写入数据库失败：${executionResult.error ?? executionResult.message}`;
    }

    if (!this.ai.canChat(this.config.ai.chatModel)) {
      if (evidencePack) {
        return renderEvidenceFallback(evidencePack.items);
      }
      return "云端生成模型未配置。请在 .env 中设置 AI_API_KEY 和 AI_CHAT_MODEL。";
    }

    const history = this.sqlite.listSessionMessages(context.sessionId, 8);
    const prompt = buildFinalPrompt({
      request: context,
      routePlan,
      evidencePack,
      executionResult,
      constraints: defaultConstraints()
    });

    return this.ai.chat({
      model: this.config.ai.chatModel,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "你是 AI Orchestrator 的最终生成模型。你不重新决定系统路径，只基于给定任务包回答。"
        },
        ...history,
        { role: "user", content: prompt }
      ]
    });
  }
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

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function renderEvidenceFallback(items: Array<{ title: string; content: string; source?: string }>): string {
  if (items.length === 0) {
    return "没有从数据库中检索到相关资料。";
  }

  return items
    .map((item, index) => `证据 ${index + 1}｜${item.title}${item.source ? `｜${item.source}` : ""}\n${item.content}`)
    .join("\n\n");
}
