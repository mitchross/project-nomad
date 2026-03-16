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
  }
  done: boolean
}

export interface ChatStreamChunk {
  message?: {
    role?: string
    content?: string
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

  /** Pull/download a model (Ollama only) */
  pullModel?(model: string, progressCallback?: (percent: number) => void): Promise<{ success: boolean; message: string }>

  /** Delete a model (Ollama only) */
  deleteModel?(model: string): Promise<void>

  /** Check if a model supports "thinking" capability */
  checkModelHasThinking?(modelName: string): Promise<boolean>

  /** Provider identifier */
  readonly providerName: string
}
