import type { AppConfig } from "../config/env.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class AiTimeoutError extends Error {
  constructor(
    public readonly phase: "connect" | "first_token" | "idle" | "total" | "request",
    public readonly timeoutMs: number
  ) {
    super(`AI ${phase} timed out after ${timeoutMs}ms`);
    this.name = "AiTimeoutError";
  }
}

export class OpenAiCompatibleClient {
  constructor(private readonly config: AppConfig["ai"]) {}

  hasApiKey(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  canEmbed(): boolean {
    return this.hasApiKey() && this.config.embeddingModel.trim().length > 0;
  }

  canChat(model = this.config.chatModel): boolean {
    return this.hasApiKey() && model.trim().length > 0;
  }

  async embed(input: string): Promise<number[]> {
    if (!this.canEmbed()) {
      throw new Error("Embedding service is not configured. Set AI_API_KEY and AI_EMBEDDING_MODEL in .env.");
    }

    const json = await this.post<EmbeddingResponse>("/embeddings", {
      model: this.config.embeddingModel,
      input
    });

    const vector = json.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("Embedding service returned an empty vector.");
    }

    if (this.config.embeddingDim > 0 && vector.length !== this.config.embeddingDim) {
      throw new Error(`Embedding dimension mismatch: expected ${this.config.embeddingDim}, got ${vector.length}.`);
    }

    return vector;
  }

  async chat(params: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    jsonMode?: boolean;
  }): Promise<string> {
    const model = params.model ?? this.config.chatModel;
    if (!this.canChat(model)) {
      throw new Error("Chat service is not configured. Set AI_API_KEY and AI_CHAT_MODEL/AI_ROUTER_MODEL in .env.");
    }

    const json = await this.post<ChatResponse>("/chat/completions", {
      model,
      messages: params.messages,
      temperature: params.temperature ?? 0.2,
      ...(params.jsonMode ? { response_format: { type: "json_object" } } : {})
    });

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Chat service returned an empty response.");
    }
    return content;
  }

  async *streamChat(params: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
  }): AsyncGenerator<string> {
    const model = params.model ?? this.config.chatModel;
    if (!this.canChat(model)) {
      throw new Error("Chat service is not configured. Set AI_API_KEY and AI_CHAT_MODEL/AI_ROUTER_MODEL in .env.");
    }

    const controller = new AbortController();
    let abortPhase: AiTimeoutError["phase"] | undefined;
    let abortTimeoutMs = 0;
    let connectTimeout: NodeJS.Timeout | undefined;
    let firstTokenTimeout: NodeJS.Timeout | undefined;
    let idleTimeout: NodeJS.Timeout | undefined;
    let totalTimeout: NodeJS.Timeout | undefined;

    const abortAfter = (phase: AiTimeoutError["phase"], timeoutMs: number) => {
      if (timeoutMs <= 0 || controller.signal.aborted) {
        return undefined;
      }
      const timer = setTimeout(() => {
        if (controller.signal.aborted) {
          return;
        }
        abortPhase = phase;
        abortTimeoutMs = timeoutMs;
        controller.abort();
      }, timeoutMs);
      timer.unref?.();
      return timer;
    };

    const clearTimer = (timer: NodeJS.Timeout | undefined) => {
      if (timer) {
        clearTimeout(timer);
      }
    };

    const resetIdleTimeout = () => {
      clearTimer(idleTimeout);
      idleTimeout = abortAfter("idle", this.config.streamIdleTimeoutMs);
    };

    try {
      connectTimeout = abortAfter("connect", this.config.streamConnectTimeoutMs);
      totalTimeout = abortAfter("total", this.config.streamTotalTimeoutMs);

      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: params.messages,
          temperature: params.temperature ?? 0.2,
          stream: true
        }),
        signal: controller.signal
      });
      clearTimer(connectTimeout);
      connectTimeout = undefined;

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`AI stream request failed with ${response.status}: ${detail}`);
      }

      if (!response.body) {
        throw new Error("AI stream response has no body.");
      }

      firstTokenTimeout = abortAfter("first_token", this.config.streamFirstTokenTimeoutMs);
      resetIdleTimeout();

      const decoder = new TextDecoder();
      let buffer = "";
      let hasFirstToken = false;
      for await (const chunk of response.body) {
        resetIdleTimeout();
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const content = parseStreamLine(line);
          if (content) {
            if (!hasFirstToken) {
              hasFirstToken = true;
              clearTimer(firstTokenTimeout);
              firstTokenTimeout = undefined;
            }
            resetIdleTimeout();
            yield content;
          }
        }
      }

      buffer += decoder.decode();
      for (const line of buffer.split(/\r?\n/)) {
        const content = parseStreamLine(line);
        if (content) {
          if (!hasFirstToken) {
            hasFirstToken = true;
            clearTimer(firstTokenTimeout);
            firstTokenTimeout = undefined;
          }
          resetIdleTimeout();
          yield content;
        }
      }
    } catch (error) {
      if (error instanceof AiTimeoutError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new AiTimeoutError(abortPhase ?? "request", abortTimeoutMs || this.config.requestTimeoutMs);
      }
      throw error;
    } finally {
      clearTimer(connectTimeout);
      clearTimer(firstTokenTimeout);
      clearTimer(idleTimeout);
      clearTimer(totalTimeout);
    }
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    timeout.unref?.();

    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`AI request failed with ${response.status}: ${detail}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (isAbortError(error)) {
        throw new AiTimeoutError("request", this.config.requestTimeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError" || error instanceof Error && error.name === "AbortError";
}

function parseStreamLine(line: string): string | undefined {
  if (!line.startsWith("data:")) {
    return undefined;
  }

  const data = line.slice("data:".length).trim();
  if (!data || data === "[DONE]") {
    return undefined;
  }

  const json = JSON.parse(data) as ChatStreamResponse;
  return json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

interface ChatResponse {
  choices: Array<{ message: { content: string } }>;
}

interface ChatStreamResponse {
  choices: Array<{
    delta?: { content?: string };
    message?: { content?: string };
  }>;
}
