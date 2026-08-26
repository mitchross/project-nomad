// Common interface over LLM backends (Ollama, OpenAI-compatible). Implementations
// own the transport; consumers depend only on this.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  think?: boolean | string
  // Whether the target model supports thinking. Lets OpenAI-compatible providers tell
  // "capable but disabled" (send reasoning_effort:'none') apart from "not capable"
  // (send nothing). (upstream v1.34)
  thinkingCapable?: boolean
  // Aborts the upstream request when the client disconnects, so an abandoned generation
  // doesn't keep decoding server-side and block the backend's parallel slot (#1065).
  signal?: AbortSignal
  options?: {
    temperature?: number
    num_ctx?: number
    num_predict?: number
  }
}

export interface ChatResponse {
  message: {
    role: string
    content: string
    /** Reasoning-model output (native `thinking` field or parsed <think> tags) */
    thinking?: string
  }
  done: boolean
}

export interface ChatStreamChunk {
  message?: {
    role?: string
    content?: string
    /** Reasoning-model output (native `thinking` field or parsed <think> tags) */
    thinking?: string
  }
  done?: boolean
}

export interface EmbeddingResult {
  embeddings: number[][]
}

export interface ModelInfo {
  name: string
  size: number
  modified_at?: string
  details?: Record<string, unknown>
}

export interface LLMProvider {
  /** Non-streaming chat completion */
  chat(request: ChatRequest): Promise<ChatResponse>

  /** Streaming chat completion — returns an async iterable of chunks */
  chatStream(request: ChatRequest): Promise<AsyncIterable<ChatStreamChunk>>

  /** Generate embeddings for one or more inputs */
  embed(model: string, input: string[]): Promise<EmbeddingResult>

  /** List models available on the backend */
  listModels(includeEmbeddings?: boolean): Promise<ModelInfo[]>

  /** Whether this provider supports model pull/delete operations */
  supportsModelManagement(): boolean

  /**
   * Whether the Ollama-native /api/generate benchmark path (precise token counts
   * and timings) is available. OpenAI-compat falls back to wall-clock estimation.
   */
  supportsNativeBenchmark(): boolean

  /**
   * Pull/download a model (Ollama only). `jobId` is opaque — logging only.
   * TODO: wire abortSignal + bytes through OllamaProvider; accepted today so
   * callers compile, but the implementation may ignore them.
   */
  pullModel?(
    model: string,
    progressCallback?: (percent: number, bytes?: { downloadedBytes?: number; totalBytes?: number }) => void,
    abortSignal?: AbortSignal,
    jobId?: string
  ): Promise<{ success: boolean; message: string; retryable?: boolean }>

  /** Delete a model (Ollama only) */
  deleteModel?(model: string): Promise<void>

  /** Check if a model supports "thinking" capability */
  checkModelHasThinking?(modelName: string): Promise<boolean>

  /**
   * Whether the embedding model is GPU-offloaded — Ollama-only, used to pace
   * CPU-bound ingestion. Omit when placement is unknowable; callers read
   * "not implemented" as "don't pace".
   */
  isEmbeddingGpuAccelerated?(): Promise<boolean>

  /**
   * Unload every chat model except the embedding model and `targetModel` — the
   * "one chat model resident in VRAM" invariant. Ollama-only; OpenAI-compat
   * backends manage their own memory. Returns the models sent an unload hint.
   */
  unloadAllChatModelsExcept?(targetModel: string | null): Promise<string[]>

  /** Provider identifier */
  readonly providerName: string
}
