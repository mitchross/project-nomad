import { inject } from '@adonisjs/core'
import { NomadOllamaModel } from '../../types/ollama.js'
import { FALLBACK_RECOMMENDED_OLLAMA_MODELS } from '../../constants/ollama.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '@adonisjs/core/services/logger'
import axios from 'axios'
import { DownloadModelJob } from '#jobs/download_model_job'
import transmit from '@adonisjs/transmit/services/main'
import Fuse, { IFuseOptions } from 'fuse.js'
import { BROADCAST_CHANNELS } from '../../constants/broadcast.js'
import env from '#start/env'
import { NOMAD_API_DEFAULT_BASE_URL } from '../../constants/misc.js'
import { createLLMProvider } from './llm/provider_factory.js'
import type { LLMProvider, ChatRequest as LLMChatRequest } from './llm/llm_provider.js'
import { SERVICE_NAMES } from '../../constants/service_names.js'
import type { DockerService } from './docker_service.js'

const NOMAD_MODELS_API_PATH = '/api/v1/ollama/models'
const MODELS_CACHE_FILE = path.join(process.cwd(), 'storage', 'ollama-models-cache.json')
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Despite the name, this is a thin facade over LLMProvider — it can serve
 * either Ollama or any OpenAI-compatible backend (e.g. llama-cpp), depending
 * on LLM_PROVIDER. The class name is kept for now to avoid touching every
 * consumer; rename to LLMService if the indirection ever bites.
 *
 * Actual Ollama-vs-OpenAI behavior lives in admin/app/services/llm/*.
 */
@inject()
export class OllamaService {
  constructor() { }

  /**
   * Delegates to the factory's process-wide singleton (no per-instance
   * caching): when the factory rebuilds the provider after a configuration
   * change, every OllamaService instance in this process picks it up on the
   * next access. Entry points that may run after a runtime config change
   * (queue jobs, remote-config save) call ensureFreshProvider() first.
   */
  public get provider(): LLMProvider {
    return createLLMProvider()
  }

  /**
   * Whether ANY embedding backend is configured for this deployment. The single
   * source of truth for "should content be queued for KB embedding?" — used by
   * every dispatch site so the answer can't drift between them.
   *
   * True when any of these deployment shapes is present:
   *  - a dedicated embedding service (EMBEDDING_HOST)
   *  - an env-configured LLM backend: OpenAI-compatible (vLLM/llama.cpp) or a
   *    remote/K8s Ollama (LLM_HOST / OLLAMA_HOST)
   *  - Docker mode: a UI-configured remote Ollama URL or a local Ollama
   *    container (both resolved by getServiceURL)
   */
  public static async isEmbeddingBackendConfigured(dockerService: DockerService): Promise<boolean> {
    if (env.get('EMBEDDING_HOST') || env.get('LLM_HOST') || env.get('OLLAMA_HOST')) {
      return true
    }
    return !!(await dockerService.getServiceURL(SERVICE_NAMES.OLLAMA))
  }

  /**
   * Downloads a model with progress tracking. Only works with providers that
   * support model management (Ollama). For OpenAI-compatible providers, returns
   * a message indicating that model management is not supported.
   */
  async downloadModel(
    model: string,
    progressCallback?: (percent: number, bytes?: { downloadedBytes?: number; totalBytes?: number }) => void,
    abortSignal?: AbortSignal,
    jobId?: string
  ): Promise<{ success: boolean; message: string; retryable?: boolean }> {
    if (!this.provider.supportsModelManagement() || !this.provider.pullModel) {
      return { success: false, message: 'Model management is not supported by the current LLM provider.', retryable: false }
    }

    const wrappedCallback = (percent: number, bytes?: { downloadedBytes?: number; totalBytes?: number }) => {
      this.broadcastDownloadProgress(model, percent)
      if (progressCallback) progressCallback(percent, bytes)
    }

    const result = await this.provider.pullModel(model, wrappedCallback, abortSignal, jobId)
    // Don't broadcast an error for user-initiated cancels — the cancel handler
    // in DownloadService already broadcasts a cancelled state.
    if (!result.success && result.message !== 'Download cancelled') {
      this.broadcastDownloadError(model, result.message)
    }
    return result
  }

  async dispatchModelDownload(modelName: string): Promise<{ success: boolean; message: string }> {
    if (!this.provider.supportsModelManagement()) {
      return { success: false, message: 'Model management is not supported by the current LLM provider.' }
    }

    try {
      logger.info(`[OllamaService] Dispatching model download for ${modelName} via job queue`)

      await DownloadModelJob.dispatch({
        modelName,
      })

      return {
        success: true,
        message:
          'Model download has been queued successfully. It will start shortly after Ollama and Open WebUI are ready (if not already).',
      }
    } catch (error) {
      logger.error(
        `[OllamaService] Failed to dispatch model download for ${modelName}: ${error instanceof Error ? error.message : error}`
      )
      return {
        success: false,
        message: 'Failed to queue model download. Please try again.',
      }
    }
  }

  public async chat(chatRequest: LLMChatRequest) {
    return await this.provider.chat(chatRequest)
  }

  public async chatStream(chatRequest: LLMChatRequest) {
    return await this.provider.chatStream(chatRequest)
  }

  public async checkModelHasThinking(modelName: string): Promise<boolean> {
    if (this.provider.checkModelHasThinking) {
      return this.provider.checkModelHasThinking(modelName)
    }
    return false
  }

  public async deleteModel(modelName: string) {
    if (!this.provider.supportsModelManagement() || !this.provider.deleteModel) {
      throw new Error('Model management is not supported by the current LLM provider.')
    }
    return await this.provider.deleteModel(modelName)
  }

  public async getModels(includeEmbeddings = false) {
    return await this.provider.listModels(includeEmbeddings)
  }

  /**
   * Hard char cap per embed input, applied as a runtime safety net regardless of
   * which backend path runs (dedicated EMBEDDING_HOST, Ollama, or OpenAI-compat).
   * The chunker in RagService caps at MAX_SAFE_TOKENS=1600 (3200 chars at the
   * conservative 2 chars/token estimate), but dense technical content has been
   * observed to slip past on multi-batch ZIM ingestion (#881).
   *
   * 4000 chars ≈ 1000–2000 tokens depending on density, which keeps us comfortably
   * under nomic-embed-text:v1.5's default 2048-token context even on backends that
   * can't be told `truncate:true`/`num_ctx` at request time.
   */
  public static readonly EMBED_MAX_INPUT_CHARS = 4000

  /**
   * Aggressive 2048-safe character cap, applied only on a context-length retry.
   * nomic-embed-text:v1.5 defaults to a 2048-token context, and on a backend we
   * can't widen at request time (OpenAI-compat / older Ollama) 2000 chars stays
   * under 2048 tokens even for the densest content (~1 char/token code/markup),
   * so an oversized chunk gets truncated-and-kept instead of silently dropped
   * from Qdrant — and the embed job stops re-embedding the whole file on the one
   * bad chunk (#881).
   */
  public static readonly EMBED_CONTEXT_SAFE_CHARS = 2000

  /**
   * True if the error is the model rejecting input that exceeds its context window
   * ("input length exceeds the context length"). Matches both the native /api/embed
   * axios error shape and the OpenAI-compat BadRequestError. Drives the
   * truncate-and-retry here and the non-retryable classification in EmbedFileJob (#881).
   */
  public static isContextLengthError(err: unknown): boolean {
    const parts: string[] = []
    if (err instanceof Error && err.message) parts.push(err.message)
    const anyErr = err as any
    const data = anyErr?.response?.data
    if (data) parts.push(typeof data === 'string' ? data : JSON.stringify(data))
    if (anyErr?.error) parts.push(typeof anyErr.error === 'string' ? anyErr.error : JSON.stringify(anyErr.error))
    const haystack = parts.join(' ').toLowerCase()
    return (
      (haystack.includes('context length') && haystack.includes('exceed')) ||
      haystack.includes('input length exceeds') ||
      // vLLM phrasing: "This model's maximum context length is N tokens.
      // However, you requested M tokens..." — no "exceed" anywhere.
      haystack.includes('maximum context length')
    )
  }

  /**
   * Embed text using the configured embedding endpoint.
   *
   * If EMBEDDING_HOST is set, embeddings are routed to a dedicated service
   * (e.g. a separate llama-cpp / vLLM / TEI instance) instead of the main LLM
   * provider — useful when the chat LLM doesn't serve embeddings. Otherwise they
   * go through the active provider (Ollama or OpenAI-compatible).
   *
   * A generous char pre-cap (EMBED_MAX_INPUT_CHARS) plus a context-length
   * truncate-and-retry (EMBED_CONTEXT_SAFE_CHARS) protect BOTH paths from an
   * oversized chunk storming the embed job (#881).
   */
  public async embed(model: string, input: string[]): Promise<{ embeddings: number[][] }> {
    const embeddingHost = env.get('EMBEDDING_HOST')
    const doEmbed = (inp: string[]): Promise<{ embeddings: number[][] }> =>
      embeddingHost
        ? this._embedViaDedicatedHost(embeddingHost, model, inp)
        : this.provider.embed(model, inp)

    const cap = (arr: string[], max: number) => arr.map((s) => (s.length > max ? s.slice(0, max) : s))
    const safeInput = cap(input, OllamaService.EMBED_MAX_INPUT_CHARS)

    try {
      return await doEmbed(safeInput)
    } catch (err) {
      if (!OllamaService.isContextLengthError(err)) throw err
      // One or more chunks exceeded the model's context even after the pre-cap.
      // Retry once, truncated hard enough to fit a 2048-token context at any
      // density, so the chunk is embedded (truncated) rather than dropped and the
      // job doesn't storm.
      const hardCapped = cap(input, OllamaService.EMBED_CONTEXT_SAFE_CHARS)
      const reduced = hardCapped.reduce((n, s, i) => (s.length < safeInput[i].length ? n + 1 : n), 0)
      logger.warn(
        '[OllamaService] embed: context-length overflow; retrying %d/%d inputs hard-capped at %d chars',
        reduced,
        input.length,
        OllamaService.EMBED_CONTEXT_SAFE_CHARS
      )
      return await doEmbed(hardCapped)
    }
  }

  /**
   * Whether the embedding model is currently GPU-offloaded. Ollama-only signal
   * (via /api/ps); used by EmbedFileJob to pace CPU-bound ingestion. Providers
   * that can't report placement (OpenAI-compat backends such as vLLM/llama.cpp)
   * fall through to `false` — those backends manage their own scheduling, so the
   * job simply doesn't pace.
   */
  public async isEmbeddingGpuAccelerated(): Promise<boolean> {
    // Best-effort: a provider misconfig (e.g. LLM_PROVIDER=openai without
    // LLM_HOST makes the factory throw) must not fail the caller — pacing
    // simply defaults to the conservative CPU assumption.
    try {
      if (this.provider.isEmbeddingGpuAccelerated) {
        return await this.provider.isEmbeddingGpuAccelerated()
      }
    } catch (err) {
      logger.warn(
        `[OllamaService] isEmbeddingGpuAccelerated unavailable: ${err instanceof Error ? err.message : err}`
      )
    }
    return false
  }

  /**
   * Enforce the "at most one chat model resident in VRAM" invariant by unloading
   * every loaded chat model except the embedding model and `targetModel`.
   * Ollama-only (via /api/ps + keep_alive:0); returns the model names unloaded.
   * OpenAI-compat providers (vLLM/llama.cpp) manage their own memory, so this is
   * a no-op returning [].
   */
  public async unloadAllChatModelsExcept(targetModel: string | null): Promise<string[]> {
    // Best-effort: unload housekeeping must never fail chat or page-load, even
    // on a provider misconfig (factory throw).
    try {
      if (this.provider.unloadAllChatModelsExcept) {
        return await this.provider.unloadAllChatModelsExcept(targetModel)
      }
    } catch (err) {
      logger.warn(
        `[OllamaService] unloadAllChatModelsExcept unavailable: ${err instanceof Error ? err.message : err}`
      )
    }
    return []
  }

  private async _embedViaDedicatedHost(
    host: string,
    model: string,
    input: string[]
  ): Promise<{ embeddings: number[][] }> {
    const baseURL = host.replace(/\/+$/, '')
    const apiKey = env.get('EMBEDDING_API_KEY', 'unused')
    const response = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Embedding API error ${response.status}: ${text}`)
    }

    const data = await response.json() as any
    return {
      embeddings: data.data.map((d: any) => d.embedding),
    }
  }

  async getAvailableModels(
    { sort, recommendedOnly, query, limit, force }: { sort?: 'pulls' | 'name'; recommendedOnly?: boolean, query: string | null, limit?: number, force?: boolean } = {
      sort: 'pulls',
      recommendedOnly: false,
      query: null,
      limit: 15,
    }
  ): Promise<{ models: NomadOllamaModel[], hasMore: boolean } | null> {
    try {
      const models = await this.retrieveAndRefreshModels(sort, force)
      if (!models || models.length === 0) {
        logger.warn(
          '[OllamaService] Returning fallback recommended models due to failure in fetching available models'
        )
        return {
          models: FALLBACK_RECOMMENDED_OLLAMA_MODELS,
          hasMore: false
        }
      }

      if (!recommendedOnly) {
        const filteredModels = query ? this.fuseSearchModels(models, query) : models
        return {
          models: filteredModels.slice(0, limit || 15),
          hasMore: filteredModels.length > (limit || 15)
        }
      }

      // If recommendedOnly is true, only return the first three models (if sorted by pulls, these will be the top 3)
      const sortedByPulls = sort === 'pulls' ? models : this.sortModels(models, 'pulls')
      const firstThree = sortedByPulls.slice(0, 3)

      // Only return the first tag of each of these models (should be the most lightweight variant)
      const recommendedModels = firstThree.map((model) => {
        return {
          ...model,
          tags: model.tags && model.tags.length > 0 ? [model.tags[0]] : [],
        }
      })

      if (query) {
        const filteredRecommendedModels = this.fuseSearchModels(recommendedModels, query)
        return {
          models: filteredRecommendedModels,
          hasMore: filteredRecommendedModels.length > (limit || 15)
        }
      }

      return {
        models: recommendedModels,
        hasMore: recommendedModels.length > (limit || 15)
      }
    } catch (error) {
      logger.error(
        `[OllamaService] Failed to get available models: ${error instanceof Error ? error.message : error}`
      )
      return null
    }
  }

  private async retrieveAndRefreshModels(
    sort?: 'pulls' | 'name',
    force?: boolean
  ): Promise<NomadOllamaModel[] | null> {
    try {
      if (!force) {
        const cachedModels = await this.readModelsFromCache()
        // An empty cached array (e.g. written from a transient empty upstream
        // response) must not be treated as valid data — fall through to a
        // fresh fetch and, failing that, the fallback list.
        if (cachedModels && cachedModels.length > 0) {
          logger.info('[OllamaService] Using cached available models data')
          return this.sortModels(cachedModels, sort)
        }
      } else {
        logger.info('[OllamaService] Force refresh requested, bypassing cache')
      }

      logger.info('[OllamaService] Fetching fresh available models from API')

      const baseUrl = env.get('NOMAD_API_URL') || NOMAD_API_DEFAULT_BASE_URL
      const fullUrl = new URL(NOMAD_MODELS_API_PATH, baseUrl).toString()

      const response = await axios.get(fullUrl, { timeout: 10000 })
      if (!response.data || !Array.isArray(response.data.models)) {
        logger.warn(
          `[OllamaService] Invalid response format when fetching available models: ${JSON.stringify(response.data)}`
        )
        return null
      }

      const rawModels = response.data.models as NomadOllamaModel[]

      // Filter out tags where cloud is truthy, then remove models with no remaining tags
      const noCloud = rawModels
        .map((model) => ({
          ...model,
          tags: model.tags.filter((tag) => !tag.cloud),
        }))
        .filter((model) => model.tags.length > 0)

      // A successful-but-empty upstream response (0 models, or all filtered out
      // as cloud-only) is a soft failure: return null so the caller serves the
      // fallback list, and don't poison the 24h cache with an empty array.
      if (noCloud.length === 0) {
        logger.warn(
          '[OllamaService] Nomad API returned no usable (non-cloud) models; using fallback'
        )
        return null
      }

      await this.writeModelsToCache(noCloud)
      return this.sortModels(noCloud, sort)
    } catch (error) {
      logger.error(
        `[OllamaService] Failed to retrieve models from Nomad API: ${error instanceof Error ? error.message : error
        }`
      )
      return null
    }
  }

  private async readModelsFromCache(): Promise<NomadOllamaModel[] | null> {
    try {
      const stats = await fs.stat(MODELS_CACHE_FILE)
      const cacheAge = Date.now() - stats.mtimeMs

      if (cacheAge > CACHE_MAX_AGE_MS) {
        logger.info('[OllamaService] Cache is stale, will fetch fresh data')
        return null
      }

      const cacheData = await fs.readFile(MODELS_CACHE_FILE, 'utf-8')
      const models = JSON.parse(cacheData) as NomadOllamaModel[]

      if (!Array.isArray(models)) {
        logger.warn('[OllamaService] Invalid cache format, will fetch fresh data')
        return null
      }

      return models
    } catch (error) {
      // Cache doesn't exist or is invalid
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(
          `[OllamaService] Error reading cache: ${error instanceof Error ? error.message : error}`
        )
      }
      return null
    }
  }

  private async writeModelsToCache(models: NomadOllamaModel[]): Promise<void> {
    try {
      await fs.mkdir(path.dirname(MODELS_CACHE_FILE), { recursive: true })
      await fs.writeFile(MODELS_CACHE_FILE, JSON.stringify(models, null, 2), 'utf-8')
      logger.info('[OllamaService] Successfully cached available models')
    } catch (error) {
      logger.warn(
        `[OllamaService] Failed to write models cache: ${error instanceof Error ? error.message : error}`
      )
    }
  }

  private sortModels(models: NomadOllamaModel[], sort?: 'pulls' | 'name'): NomadOllamaModel[] {
    if (sort === 'pulls') {
      // Sort by estimated pulls (it should be a string like "1.2K", "500", "4M" etc.)
      models.sort((a, b) => {
        const parsePulls = (pulls: string) => {
          const multiplier = pulls.endsWith('K')
            ? 1_000
            : pulls.endsWith('M')
              ? 1_000_000
              : pulls.endsWith('B')
                ? 1_000_000_000
                : 1
          return parseFloat(pulls) * multiplier
        }
        return parsePulls(b.estimated_pulls) - parsePulls(a.estimated_pulls)
      })
    } else if (sort === 'name') {
      models.sort((a, b) => a.name.localeCompare(b.name))
    }

    // Always sort model.tags by the size field in descending order
    // Size is a string like '75GB', '8.5GB', '2GB' etc. Smaller models first
    models.forEach((model) => {
      if (model.tags && Array.isArray(model.tags)) {
        model.tags.sort((a, b) => {
          const parseSize = (size: string) => {
            const multiplier = size.endsWith('KB')
              ? 1 / 1_000
              : size.endsWith('MB')
                ? 1 / 1_000_000
                : size.endsWith('GB')
                  ? 1
                  : size.endsWith('TB')
                    ? 1_000
                    : 0 // Unknown size format
            return parseFloat(size) * multiplier
          }
          return parseSize(a.size) - parseSize(b.size)
        })
      }
    })

    return models
  }

  private broadcastDownloadError(model: string, error: string) {
    transmit.broadcast(BROADCAST_CHANNELS.OLLAMA_MODEL_DOWNLOAD, {
      model,
      percent: -1,
      error,
      timestamp: new Date().toISOString(),
    })
  }

  private broadcastDownloadProgress(model: string, percent: number) {
    transmit.broadcast(BROADCAST_CHANNELS.OLLAMA_MODEL_DOWNLOAD, {
      model,
      percent,
      timestamp: new Date().toISOString(),
    })
    logger.info(`[OllamaService] Download progress for model "${model}": ${percent}%`)
  }

  private fuseSearchModels(models: NomadOllamaModel[], query: string): NomadOllamaModel[] {
    const options: IFuseOptions<NomadOllamaModel> = {
      ignoreDiacritics: true,
      keys: ['name', 'description', 'tags.name'],
      threshold: 0.3, // lower threshold for stricter matching
    }

    const fuse = new Fuse(models, options)

    return fuse.search(query).map(result => result.item)
  }
}
