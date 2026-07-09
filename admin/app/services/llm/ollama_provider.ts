/**
 * Ollama LLM provider.
 *
 * Wraps the existing Ollama SDK usage. Docker-based service discovery is
 * contained here — if LLM_HOST is set, it's used directly; otherwise
 * falls back to Docker discovery.
 */

import { Ollama } from 'ollama'
import axios from 'axios'
import logger from '@adonisjs/core/services/logger'
import env from '#start/env'
import { SERVICE_NAMES } from '../../../constants/service_names.js'
import { EMBEDDING_MODEL_NAME } from '../../../constants/ollama.js'
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
  // Raw base URL (no trailing slash) for the Ollama-native endpoints the SDK
  // doesn't wrap (/api/ps, /api/generate). Captured during _initialize().
  private resolvedHost: string | null = null

  private async _initialize() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const host = env.get('LLM_HOST') || env.get('OLLAMA_HOST')
        if (host) {
          this.resolvedHost = host.replace(/\/+$/, '')
          this.ollama = new Ollama({ host })
          return
        }

        // Fall back to Docker discovery
        const dockerService = new (await import('../docker_service.js')).DockerService()
        const url = await dockerService.getServiceURL(SERVICE_NAMES.OLLAMA)
        if (!url) {
          throw new Error('Ollama service is not installed or running.')
        }
        this.resolvedHost = url.replace(/\/+$/, '')
        this.ollama = new Ollama({ host: url })
      })().catch((err) => {
        // Reset so the next call retries instead of returning the failed promise forever
        this.initPromise = null
        throw err
      })
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
        thinking: result.message.thinking ?? undefined,
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

    // Map Ollama SDK ChatResponse chunks to our ChatStreamChunk interface.
    // Ollama surfaces reasoning natively on message.thinking — pass it through
    // so the chat UI's Reasoning panel works for thinking models.
    async function* mapChunks(): AsyncIterable<ChatStreamChunk> {
      for await (const chunk of stream) {
        yield {
          message: {
            role: chunk.message?.role,
            content: chunk.message?.content,
            thinking: chunk.message?.thinking ?? undefined,
          },
          done: chunk.done,
        }
      }
    }

    return mapChunks()
  }

  async embed(model: string, input: string[]): Promise<EmbeddingResult> {
    const client = await this._ensureClient()
    // num_ctx: some installs ship nomic-embed-text with a 2048-token modelfile
    // default; 8192 matches its RoPE-extrapolated max so dense chunks embed
    // whole instead of being silently truncated server-side. truncate: server-
    // side net for anything that still overshoots (#881).
    const result = await client.embed({
      model,
      input,
      truncate: true,
      options: { num_ctx: 8192 },
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

  supportsNativeBenchmark(): boolean {
    return true
  }

  async pullModel(
    model: string,
    progressCallback?: (percent: number, bytes?: { downloadedBytes?: number; totalBytes?: number }) => void,
    abortSignal?: AbortSignal,
    _jobId?: string
  ): Promise<{ success: boolean; message: string; retryable?: boolean }> {
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
        if (abortSignal?.aborted) {
          logger.info(`[OllamaProvider] Download of "${model}" aborted by signal.`)
          // retryable: false — a user-initiated cancel must not be retried by BullMQ
          return { success: false, message: 'Download cancelled', retryable: false }
        }
        if (chunk.completed && chunk.total) {
          const percent = parseFloat(((chunk.completed / chunk.total) * 100).toFixed(2))
          if (progressCallback) {
            progressCallback(percent, { downloadedBytes: chunk.completed, totalBytes: chunk.total })
          }
        }
      }

      logger.info(`[OllamaProvider] Model "${model}" downloaded successfully.`)
      return { success: true, message: 'Model downloaded successfully.' }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(`[OllamaProvider] Failed to download model "${model}": ${errorMessage}`)

      // A model that needs a newer Ollama (412) can never succeed by retrying —
      // classify it non-retryable and give the user the actionable next step.
      const isVersionMismatch = errorMessage.includes('newer version of Ollama')
      const userMessage = isVersionMismatch
        ? 'This model requires a newer version of Ollama. Please update AI Assistant from the Apps page.'
        : `Failed to download model: ${errorMessage}`
      return { success: false, message: userMessage, retryable: !isVersionMismatch }
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

  /**
   * True if Ollama is currently running an embedding model with non-zero VRAM
   * (GPU-offloaded). Returns false if CPU-only, not loaded, or /api/ps is
   * unreachable — fail closed so callers over-pace rather than risk CPU
   * saturation. Only the Ollama-native /api/ps endpoint exposes placement info.
   */
  async isEmbeddingGpuAccelerated(): Promise<boolean> {
    try {
      await this._ensureClient()
      if (!this.resolvedHost) return false
      const response = await axios.get(`${this.resolvedHost}/api/ps`, { timeout: 5000 })
      const models: Array<{ name?: string; size_vram?: number }> = response.data?.models ?? []
      return models.some(
        (m) => m.name?.toLowerCase().includes('embed') && (m.size_vram ?? 0) > 0
      )
    } catch (err: any) {
      logger.warn(
        `[OllamaProvider] Could not check embedding placement via /api/ps: ${err?.message ?? err}`
      )
      return false
    }
  }

  /**
   * Fire `keep_alive: 0` against every loaded model except the embedding model
   * and `targetModel`. Best-effort: /api/ps + parallel unload hints; network or
   * Ollama errors are swallowed and logged. Returns the models that were sent
   * the unload hint. `keep_alive: 0` is a post-completion hint, so in-flight
   * inference is never interrupted.
   */
  async unloadAllChatModelsExcept(targetModel: string | null): Promise<string[]> {
    let loadedModels: string[] = []
    try {
      await this._ensureClient()
      if (!this.resolvedHost) return []
      const response = await axios.get(`${this.resolvedHost}/api/ps`, { timeout: 5000 })
      loadedModels = (response.data?.models ?? [])
        .map((m: { name?: string }) => m.name)
        .filter((name: unknown): name is string => typeof name === 'string')
    } catch (err: any) {
      logger.warn(
        `[OllamaProvider] unloadAllChatModelsExcept: /api/ps unreachable, skipping unload sweep: ${err?.message ?? err}`
      )
      return []
    }

    const toUnload = loadedModels.filter(
      (name) => name !== EMBEDDING_MODEL_NAME && name !== targetModel
    )

    await Promise.all(
      toUnload.map(async (modelName) => {
        try {
          await axios.post(
            `${this.resolvedHost}/api/generate`,
            { model: modelName, prompt: '', keep_alive: 0 },
            { timeout: 10000 }
          )
        } catch (err: any) {
          logger.warn(
            `[OllamaProvider] Failed to send unload hint for ${modelName}: ${err?.message ?? err}`
          )
        }
      })
    )

    if (toUnload.length > 0) {
      logger.info(
        `[OllamaProvider] Sent unload hint for ${toUnload.length} chat model(s): ${toUnload.join(', ')}`
      )
    }
    return toUnload
  }
}
