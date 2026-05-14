import type { AppConfig } from "../config/env.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

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
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

interface ChatResponse {
  choices: Array<{ message: { content: string } }>;
}
