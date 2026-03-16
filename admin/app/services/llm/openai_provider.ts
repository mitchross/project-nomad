/**
 * OpenAI-compatible LLM provider.
 *
 * Works with any server implementing the OpenAI API (llama-cpp, vLLM, LiteLLM, etc.).
 * Uses fetch() — no extra npm dependency needed.
 */

import logger from '@adonisjs/core/services/logger'
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  EmbeddingResult,
  ModelInfo,
} from './llm_provider.js'

export interface OpenAIProviderConfig {
  baseURL: string // e.g., http://llama-cpp:8080/v1
  apiKey?: string
}

export class OpenAIProvider implements LLMProvider {
  readonly providerName = 'openai'
  private baseURL: string
  private apiKey: string

  constructor(config: OpenAIProviderConfig) {
    // Strip trailing slash
    this.baseURL = config.baseURL.replace(/\/+$/, '')
    this.apiKey = config.apiKey || 'unused'
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.options?.temperature,
        max_tokens: request.options?.num_predict,
        stream: false,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenAI API error ${response.status}: ${text}`)
    }

    const data = await response.json() as any
    return {
      message: {
        role: data.choices[0].message.role,
        content: data.choices[0].message.content,
      },
      done: true,
    }
  }

  async chatStream(request: ChatRequest): Promise<AsyncIterable<ChatStreamChunk>> {
    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.options?.temperature,
        max_tokens: request.options?.num_predict,
        stream: true,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenAI API error ${response.status}: ${text}`)
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()

    return {
      [Symbol.asyncIterator]() {
        let buffer = ''
        return {
          async next(): Promise<IteratorResult<ChatStreamChunk>> {
            while (true) {
              // Process any complete lines in buffer
              const lineEnd = buffer.indexOf('\n')
              if (lineEnd !== -1) {
                const line = buffer.slice(0, lineEnd).trim()
                buffer = buffer.slice(lineEnd + 1)

                if (line === 'data: [DONE]') {
                  return { done: true, value: undefined as any }
                }

                if (line.startsWith('data: ')) {
                  try {
                    const json = JSON.parse(line.slice(6))
                    const delta = json.choices?.[0]?.delta
                    const finishReason = json.choices?.[0]?.finish_reason

                    if (delta?.content || finishReason === 'stop') {
                      return {
                        done: false,
                        value: {
                          message: {
                            role: delta?.role || 'assistant',
                            content: delta?.content || '',
                          },
                          done: finishReason === 'stop',
                        },
                      }
                    }
                  } catch {
                    // Skip malformed JSON lines
                  }
                }
                continue
              }

              // Read more data
              const { done, value } = await reader.read()
              if (done) {
                return { done: true, value: undefined as any }
              }
              buffer += decoder.decode(value, { stream: true })
            }
          },
        }
      },
    }
  }

  async embed(model: string, input: string[]): Promise<EmbeddingResult> {
    const response = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model,
        input,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenAI embeddings API error ${response.status}: ${text}`)
    }

    const data = await response.json() as any
    return {
      embeddings: data.data.map((d: any) => d.embedding),
    }
  }

  async listModels(includeEmbeddings = false): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseURL}/models`, {
        headers: this.headers(),
      })

      if (!response.ok) {
        logger.warn(`[OpenAIProvider] Failed to list models: ${response.status}`)
        return []
      }

      const data = await response.json() as any
      const models = data.data.map((m: any) => ({
        name: m.id,
        size: 0,
        modified_at: m.created ? new Date(m.created * 1000).toISOString() : undefined,
      }))

      if (includeEmbeddings) {
        return models
      }
      return models.filter((m: ModelInfo) => !m.name.includes('embed'))
    } catch (error) {
      logger.error(`[OpenAIProvider] Failed to list models: ${error instanceof Error ? error.message : error}`)
      return []
    }
  }

  supportsModelManagement(): boolean {
    return false
  }

  async checkModelHasThinking(_modelName: string): Promise<boolean> {
    // OpenAI-compatible servers don't expose capability metadata
    // Default to false — can be overridden via env config in the future
    return false
  }
}
