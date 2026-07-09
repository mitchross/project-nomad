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
    if (!data.choices?.length || !data.choices[0].message) {
      throw new Error('Unexpected response format from OpenAI API: no choices returned')
    }

    // Reasoning models on OpenAI-compatible backends surface reasoning either in
    // a dedicated field (vLLM: reasoning_content; some servers: thinking) or
    // inline as <think>…</think> in the content. Separate it out so reasoning
    // never leaks into the visible reply — or into chat titles/suggestions,
    // which are generated through this non-streaming path.
    const message = data.choices[0].message
    const nativeThinking: string = message.reasoning_content ?? message.thinking ?? ''
    let content: string = message.content ?? ''
    let parsedThinking = ''
    content = content.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner) => {
      parsedThinking += inner
      return ''
    })
    const thinking = nativeThinking + parsedThinking

    return {
      message: {
        role: message.role,
        content,
        thinking: thinking.length > 0 ? thinking : undefined,
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

    if (!response.body) {
      throw new Error('Stream response body is empty')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    // Returns how many trailing chars of `text` could be the start of `tag`
    function partialTagSuffix(tag: string, text: string): number {
      for (let len = Math.min(tag.length - 1, text.length); len >= 1; len--) {
        if (text.endsWith(tag.slice(0, len))) return len
      }
      return 0
    }

    async function* normalize(): AsyncGenerator<ChatStreamChunk> {
      // Stateful parser for <think>...</think> tags that may be split across
      // chunks. Reasoning models on OpenAI-compatible backends surface
      // reasoning either in a dedicated delta field (vLLM: reasoning_content;
      // some servers: thinking) or inline in delta.content — separate it out
      // so reasoning renders in the UI's Reasoning panel instead of leaking
      // into the visible reply.
      let lineBuffer = ''
      let tagBuffer = ''
      let inThink = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        lineBuffer += decoder.decode(value, { stream: true })

        let lineEnd: number
        while ((lineEnd = lineBuffer.indexOf('\n')) !== -1) {
          const line = lineBuffer.slice(0, lineEnd).trim()
          lineBuffer = lineBuffer.slice(lineEnd + 1)

          if (line === 'data: [DONE]') return
          if (!line.startsWith('data: ')) continue

          let delta: any
          let finishReason: string | null | undefined
          try {
            const json = JSON.parse(line.slice(6))
            delta = json.choices?.[0]?.delta
            finishReason = json.choices?.[0]?.finish_reason
          } catch {
            continue // Skip malformed JSON lines
          }

          const nativeThinking: string = delta?.reasoning_content ?? delta?.thinking ?? ''
          const rawContent: string = delta?.content ?? ''

          // Parse <think> tags out of the content stream
          tagBuffer += rawContent
          let parsedContent = ''
          let parsedThinking = ''

          while (tagBuffer.length > 0) {
            if (inThink) {
              const closeIdx = tagBuffer.indexOf('</think>')
              if (closeIdx !== -1) {
                parsedThinking += tagBuffer.slice(0, closeIdx)
                tagBuffer = tagBuffer.slice(closeIdx + 8)
                inThink = false
              } else {
                const hold = partialTagSuffix('</think>', tagBuffer)
                parsedThinking += tagBuffer.slice(0, tagBuffer.length - hold)
                tagBuffer = tagBuffer.slice(tagBuffer.length - hold)
                break
              }
            } else {
              const openIdx = tagBuffer.indexOf('<think>')
              if (openIdx !== -1) {
                parsedContent += tagBuffer.slice(0, openIdx)
                tagBuffer = tagBuffer.slice(openIdx + 7)
                inThink = true
              } else {
                const hold = partialTagSuffix('<think>', tagBuffer)
                parsedContent += tagBuffer.slice(0, tagBuffer.length - hold)
                tagBuffer = tagBuffer.slice(tagBuffer.length - hold)
                break
              }
            }
          }

          const isDone = finishReason !== null && finishReason !== undefined
          if (parsedContent || nativeThinking || parsedThinking || isDone) {
            yield {
              message: {
                role: delta?.role || 'assistant',
                content: parsedContent,
                thinking: nativeThinking + parsedThinking || undefined,
              },
              done: isDone,
            }
          }
        }
      }
    }

    return normalize()
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
        logger.warn(`[OpenAIProvider] Failed to list models from ${this.baseURL}/models: ${response.status}`)
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

  supportsNativeBenchmark(): boolean {
    return false
  }

  async checkModelHasThinking(_modelName: string): Promise<boolean> {
    // OpenAI-compatible servers don't expose capability metadata
    // Default to false — can be overridden via env config in the future
    return false
  }
}
