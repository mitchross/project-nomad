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
 *
 * The provider is a per-process singleton, and NOMAD runs more than one
 * process (HTTP server + BullMQ queue worker — see install/entrypoint.sh), so
 * an in-process reset can never invalidate the other process. Instead the
 * singleton carries a fingerprint of the configuration that selects the
 * provider; `ensureFreshProvider()` recomputes it and rebuilds the provider
 * when configuration changed. Long-lived entry points that may execute after a
 * configuration change (queue jobs, the remote-config controller) call it
 * before doing provider work, which makes provider resolution self-correcting
 * across processes without any distributed invalidation.
 */

import { createHash } from 'node:crypto'
import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import type { LLMProvider } from './llm_provider.js'
import { OllamaProvider } from './ollama_provider.js'
import { OpenAIProvider } from './openai_provider.js'

let _instance: LLMProvider | null = null
// null = fingerprint unknown (provider was built via the synchronous path, or
// never built) — the next ensureFreshProvider() rebuilds and stamps it.
let _fingerprint: string | null = null

function buildProvider(): LLMProvider {
  const providerType = env.get('LLM_PROVIDER', 'ollama')
  const host = env.get('LLM_HOST') || env.get('OLLAMA_HOST', '')

  switch (providerType) {
    case 'openai': {
      if (!host) {
        throw new Error('LLM_HOST is required when LLM_PROVIDER=openai')
      }
      const apiKey = env.get('LLM_API_KEY', 'unused')
      logger.info(`[LLMFactory] Creating OpenAI provider → ${host}`)
      return new OpenAIProvider({ baseURL: host, apiKey })
    }
    case 'ollama':
    default: {
      logger.info(`[LLMFactory] Creating Ollama provider${host ? ` → ${host}` : ' (Docker discovery)'}`)
      return new OllamaProvider()
    }
  }
}

/**
 * Pure fingerprint computation over exactly the configuration that selects/
 * parameterizes the provider. The API key contributes only a short hash — its
 * identity matters (rotating it must rebuild the client) but the secret never
 * appears in the fingerprint, logs, or errors. Exported for unit tests.
 */
export function computeConfigFingerprint(input: {
  providerType: string
  host: string
  apiKey: string
  kvRemoteUrl: string
}): string {
  const keyId = input.apiKey
    ? createHash('sha256').update(input.apiKey).digest('hex').slice(0, 12)
    : 'none'
  return [input.providerType, input.host, keyId, input.kvRemoteUrl].join('|')
}

/**
 * Gather the live configuration and fingerprint it. The KV remote URL is
 * included for the Ollama path because OllamaProvider resolves it at
 * _initialize() time; a runtime change through Settings must produce a
 * different fingerprint.
 */
export async function resolveConfigFingerprint(): Promise<string> {
  const providerType = env.get('LLM_PROVIDER', 'ollama')
  const host = env.get('LLM_HOST') || env.get('OLLAMA_HOST', '')
  const apiKey = env.get('LLM_API_KEY', '')

  let kvRemoteUrl = ''
  if (providerType !== 'openai') {
    try {
      const { default: KVStore } = await import('#models/kv_store')
      kvRemoteUrl = (await KVStore.getValue('ai.remoteOllamaUrl')) ?? ''
    } catch {
      // DB unavailable (early boot, tests without DB) — env-only fingerprint.
      kvRemoteUrl = ''
    }
  }

  return computeConfigFingerprint({ providerType, host, apiKey, kvRemoteUrl })
}

/**
 * Synchronous accessor. Returns the cached provider or builds one from env.
 * Cannot observe runtime (KV) configuration changes — entry points that may
 * run after a configuration change should use ensureFreshProvider() instead.
 */
export function createLLMProvider(): LLMProvider {
  if (_instance) {
    return _instance
  }
  _instance = buildProvider()
  _fingerprint = null // unknown until ensureFreshProvider() stamps it
  return _instance
}

/**
 * Rebuild the provider if the resolved configuration changed since it was
 * built (or if it was built without a fingerprint). Safe to call often —
 * a fingerprint match is one env read plus at most one KV read.
 */
export async function ensureFreshProvider(): Promise<LLMProvider> {
  const fingerprint = await resolveConfigFingerprint()
  if (!_instance || _fingerprint !== fingerprint) {
    if (_instance) {
      logger.info('[LLMFactory] LLM configuration changed — rebuilding provider')
    }
    _instance = buildProvider()
    _fingerprint = fingerprint
  }
  return _instance
}

/** Reset the singleton (for testing) */
export function resetLLMProvider() {
  _instance = null
  _fingerprint = null
}
