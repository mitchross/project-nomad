/**
 * Ollama LLM provider.
 *
 * Wraps the existing Ollama SDK usage. Docker-based service discovery is
 * contained here — if LLM_HOST is set, it's used directly; otherwise
 * falls back to Docker discovery.
 */

import { Ollama } from 'ollama'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import { SERVICE_NAMES } from '../../../constants/service_names.js'
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  EmbeddingResult,
  ModelInfo,
} from './llm_provider.js'

export class OllamaProvider implements LLMProvider {
  readonly providerName = 'ollama'
  private ollama: Ollama | null = null
  private initPromise: Promise<void> | null = null

  private async _initialize() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const host = env.get('LLM_HOST') || env.get('OLLAMA_HOST')
        if (host) {
          this.ollama = new Ollama({ host })
          return
        }

        // Fall back to Docker discovery
        const dockerService = new (await import('../docker_service.js')).DockerService()
        const url = await dockerService.getServiceURL(SERVICE_NAMES.OLLAMA)
        if (!url) {
          throw new Error('Ollama service is not installed or running.')
        }
        this.ollama = new Ollama({ host: url })
      })()
    }
    return this.initPromise
  }

  private async _ensureClient(): Promise<Ollama> {
    if (!this.ollama) {
      await this._initialize()
    }
    if (!this.ollama) {
      throw new Error('Ollama client is not initialized.')
    }
    return this.ollama
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const client = await this._ensureClient()
    const result = await client.chat({
      model: request.model,
      messages: request.messages,
      stream: false,
      think: request.think as any,
      options: request.options,
    })
    return {
      message: {
        role: result.message.role,
        content: result.message.content,
      },
      done: true,
    }
  }

  async chatStream(request: ChatRequest): Promise<AsyncIterable<ChatStreamChunk>> {
    const client = await this._ensureClient()
    const stream = await client.chat({
      model: request.model,
      messages: request.messages,
      stream: true,
      think: request.think as any,
      options: request.options,
    })
    // The Ollama SDK returns an AbortableAsyncIterator which is already AsyncIterable
    return stream as any
  }

  async embed(model: string, input: string[]): Promise<EmbeddingResult> {
    const client = await this._ensureClient()
    const result = await client.embed({
      model,
      input,
    })
    return {
      embeddings: result.embeddings,
    }
  }

  async listModels(includeEmbeddings = false): Promise<ModelInfo[]> {
    const client = await this._ensureClient()
    const response = await client.list()
    const models = response.models.map((m) => ({
      name: m.name,
      size: m.size,
      modified_at: m.modified_at?.toString(),
    }))
    if (includeEmbeddings) {
      return models
    }
    return models.filter((m) => !m.name.includes('embed'))
  }

  supportsModelManagement(): boolean {
    return true
  }

  async pullModel(model: string, progressCallback?: (percent: number) => void): Promise<{ success: boolean; message: string }> {
    try {
      const client = await this._ensureClient()

      // Check if already installed
      const models = await this.listModels(true)
      if (models.some((m) => m.name === model)) {
        logger.info(`[OllamaProvider] Model "${model}" is already installed.`)
        return { success: true, message: 'Model is already installed.' }
      }

      const downloadStream = await client.pull({ model, stream: true })
      for await (const chunk of downloadStream) {
        if (chunk.completed && chunk.total) {
          const percent = parseFloat(((chunk.completed / chunk.total) * 100).toFixed(2))
          if (progressCallback) {
            progressCallback(percent)
          }
        }
      }

      logger.info(`[OllamaProvider] Model "${model}" downloaded successfully.`)
      return { success: true, message: 'Model downloaded successfully.' }
    } catch (error) {
      logger.error(`[OllamaProvider] Failed to download model "${model}": ${error instanceof Error ? error.message : error}`)
      return { success: false, message: 'Failed to download model.' }
    }
  }

  async deleteModel(model: string): Promise<void> {
    const client = await this._ensureClient()
    await client.delete({ model })
  }

  async checkModelHasThinking(modelName: string): Promise<boolean> {
    try {
      const client = await this._ensureClient()
      const modelInfo = await client.show({ model: modelName })
      return modelInfo.capabilities.includes('thinking')
    } catch {
      return false
    }
  }
}
