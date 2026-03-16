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

const NOMAD_MODELS_API_PATH = '/api/v1/ollama/models'
const MODELS_CACHE_FILE = path.join(process.cwd(), 'storage', 'ollama-models-cache.json')
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

@inject()
export class OllamaService {
  private _provider: LLMProvider | null = null

  constructor() { }

  /** Lazily creates the LLM provider singleton */
  public get provider(): LLMProvider {
    if (!this._provider) {
      this._provider = createLLMProvider()
    }
    return this._provider
  }

  /**
   * Downloads a model with progress tracking. Only works with providers that
   * support model management (Ollama). For OpenAI-compatible providers, returns
   * a message indicating that model management is not supported.
   */
  async downloadModel(model: string, progressCallback?: (percent: number) => void): Promise<{ success: boolean; message: string }> {
    if (!this.provider.supportsModelManagement() || !this.provider.pullModel) {
      return { success: false, message: 'Model management is not supported by the current LLM provider.' }
    }

    const wrappedCallback = progressCallback
      ? (percent: number) => {
        this.broadcastDownloadProgress(model, percent)
        progressCallback(percent)
      }
      : (percent: number) => {
        this.broadcastDownloadProgress(model, percent)
      }

    return this.provider.pullModel(model, wrappedCallback)
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
   * Embed text using the LLM provider. Convenience wrapper for the provider's
   * embed method, used by RagService.
   */
  public async embed(model: string, input: string[]) {
    return await this.provider.embed(model, input)
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
      if (!models) {
        // If we fail to get models from the API, return the fallback recommended models
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
        if (cachedModels) {
          logger.info('[OllamaService] Using cached available models data')
          return this.sortModels(cachedModels, sort)
        }
      } else {
        logger.info('[OllamaService] Force refresh requested, bypassing cache')
      }

      logger.info('[OllamaService] Fetching fresh available models from API')

      const baseUrl = env.get('NOMAD_API_URL') || NOMAD_API_DEFAULT_BASE_URL
      const fullUrl = new URL(NOMAD_MODELS_API_PATH, baseUrl).toString()

      const response = await axios.get(fullUrl)
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
