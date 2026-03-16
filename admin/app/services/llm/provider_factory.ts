/**
 * LLM Provider factory.
 *
 * Creates the appropriate LLM provider based on environment configuration.
 *
 * Environment variables:
 *   LLM_PROVIDER  — 'ollama' | 'openai'  (default: 'ollama')
 *   LLM_HOST      — Base URL for LLM API (required for openai, optional for ollama)
 *   LLM_API_KEY   — API key (default: 'unused', for local servers)
 *   OLLAMA_HOST   — Legacy fallback for Ollama host
 */

import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import type { LLMProvider } from './llm_provider.js'
import { OllamaProvider } from './ollama_provider.js'
import { OpenAIProvider } from './openai_provider.js'

let _instance: LLMProvider | null = null

export function createLLMProvider(): LLMProvider {
  if (_instance) {
    return _instance
  }

  const providerType = env.get('LLM_PROVIDER', 'ollama')
  const host = env.get('LLM_HOST') || env.get('OLLAMA_HOST', '')

  switch (providerType) {
    case 'openai': {
      if (!host) {
        throw new Error('LLM_HOST is required when LLM_PROVIDER=openai')
      }
      const apiKey = env.get('LLM_API_KEY', 'unused')
      logger.info(`[LLMFactory] Creating OpenAI provider → ${host}`)
      _instance = new OpenAIProvider({ baseURL: host, apiKey })
      break
    }
    case 'ollama':
    default: {
      logger.info(`[LLMFactory] Creating Ollama provider${host ? ` → ${host}` : ' (Docker discovery)'}`)
      _instance = new OllamaProvider()
      break
    }
  }

  return _instance
}

/** Reset the singleton (for testing) */
export function resetLLMProvider() {
  _instance = null
}
