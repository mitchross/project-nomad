/**
 * LLM Provider abstraction layer.
 *
 * Defines a common interface for interacting with LLM backends (Ollama, OpenAI-compatible, etc.).
 * Implementations handle the transport details; consumers only depend on this interface.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  think?: boolean | string
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
   * Whether this provider supports the Ollama-native /api/generate benchmark path,
   * which returns precise token counts and timing metrics.
   * OpenAI-compatible providers fall back to wall-clock estimation.
   */
  supportsNativeBenchmark(): boolean

  /**
   * Pull/download a model (Ollama only).
   *
   * progressCallback receives percent (0-100) and an optional bytes object with
   * downloadedBytes/totalBytes. abortSignal allows cancellation. jobId is opaque
   * to the provider — passed through for logging only.
   *
   * TODO: actually wire abort + bytes through OllamaProvider (upstream commits
   * 6c33a96 + c8cb79a). For now, the extra params are accepted to keep callers
   * compiling but the OllamaProvider implementation may ignore them.
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
   * Whether the embedding model is currently GPU-offloaded (non-zero VRAM).
   * Ollama-only signal used to pace CPU-bound ingestion. Providers that can't
   * report placement (OpenAI-compatible backends) should omit this — callers
   * treat "not implemented" as "don't pace".
   */
  isEmbeddingGpuAccelerated?(): Promise<boolean>

  /**
   * Unload every loaded chat model except the embedding model and `targetModel`,
   * enforcing the "at most one chat model resident in VRAM" invariant. Ollama-only;
   * OpenAI-compatible backends manage their own memory and should omit this.
   * Returns the names of the models that were sent an unload hint.
   */
  unloadAllChatModelsExcept?(targetModel: string | null): Promise<string[]>

  /** Provider identifier */
  readonly providerName: string
}
