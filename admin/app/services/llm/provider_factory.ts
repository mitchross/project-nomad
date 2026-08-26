// Builds the LLM provider from LLM_PROVIDER / LLM_HOST / LLM_API_KEY (see
// .env.example).
//
// The provider is a per-process singleton and NOMAD runs two processes (HTTP
// server + queue worker, see install/entrypoint.sh), so an in-process reset
// can't invalidate the other one. The singleton instead carries a fingerprint
// of its config; ensureFreshProvider() recomputes it and rebuilds on change,
// making resolution self-correcting without distributed invalidation.

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

/**
 * The backend in effect and where its config came from. `source` drives
 * ownership: a managed local container is ours to mutate, a remote is not
 * unless the operator says so.
 */
export interface EffectiveLLMConfig {
  providerType: 'ollama' | 'openai'
  /** Empty for the Ollama path when the local container is discovered. */
  host: string
  apiKey: string
  source: 'env' | 'settings' | 'managed-container'
}

/**
 * Precedence: env (LLM_PROVIDER/LLM_HOST/OLLAMA_HOST) → Settings remote (KV) →
 * managed Docker container. Declarative config always outranks the Settings
 * field, which is why that flow refuses to save while env config is present.
 */
export function resolveConfigFrom(input: {
  envProviderType?: string
  envHost?: string
  envApiKey?: string
  kvProtocol?: string | null
  kvHost?: string | null
  kvApiKey?: string | null
}): EffectiveLLMConfig {
  if (input.envProviderType === 'openai' || input.envHost) {
    return {
      providerType: input.envProviderType === 'openai' ? 'openai' : 'ollama',
      host: input.envHost ?? '',
      apiKey: input.envApiKey || 'unused',
      source: 'env',
    }
  }

  if (input.kvHost) {
    return {
      providerType: input.kvProtocol === 'openai' ? 'openai' : 'ollama',
      host: input.kvHost,
      apiKey: input.kvApiKey || 'unused',
      source: 'settings',
    }
  }

  return { providerType: 'ollama', host: '', apiKey: 'unused', source: 'managed-container' }
}

function buildProviderFrom(config: EffectiveLLMConfig): LLMProvider {
  if (config.providerType === 'openai') {
    if (!config.host) {
      throw new Error('LLM_HOST is required when LLM_PROVIDER=openai')
    }
    logger.info(`[LLMFactory] Creating OpenAI provider → ${config.host} (${config.source})`)
    return new OpenAIProvider({ baseURL: config.host, apiKey: config.apiKey })
  }
  logger.info(
    `[LLMFactory] Creating Ollama provider${config.host ? ` → ${config.host}` : ' (Docker discovery)'} (${config.source})`
  )
  return new OllamaProvider(config.host ? { host: config.host, source: config.source } : undefined)
}

/** Env-only build — the synchronous path cannot read Settings (KV). */
function buildProvider(): LLMProvider {
  return buildProviderFrom(
    resolveConfigFrom({
      envProviderType: env.get('LLM_PROVIDER', 'ollama'),
      envHost: env.get('LLM_HOST') || env.get('OLLAMA_HOST', ''),
      envApiKey: env.get('LLM_API_KEY', ''),
    })
  )
}

/**
 * Fingerprint over exactly the config that selects the provider. The API key
 * contributes a short hash only — rotating it must rebuild the client, but the
 * secret never reaches the fingerprint, logs or errors. Exported for tests.
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

/** Fingerprint of an effective config (post-precedence). */
export function fingerprintConfig(config: EffectiveLLMConfig): string {
  return computeConfigFingerprint({
    providerType: config.providerType,
    host: config.host,
    apiKey: config.apiKey === 'unused' ? '' : config.apiKey,
    kvRemoteUrl: config.source,
  })
}

/** Live config from env and Settings, with precedence applied. */
export async function resolveEffectiveConfig(): Promise<EffectiveLLMConfig> {
  let kvProtocol: string | null = null
  let kvHost: string | null = null
  let kvApiKey: string | null = null
  try {
    const { default: KVStore } = await import('#models/kv_store')
    kvHost = await KVStore.getValue('ai.remoteOllamaUrl')
    // Absent protocol = pre-selection install: those URLs were always Ollama.
    kvProtocol = (await KVStore.getValue('ai.remoteProtocol')) || 'ollama'
    kvApiKey = await KVStore.getValue('ai.remoteApiKey')
  } catch {
    // DB unavailable (early boot, tests without DB) — env-only resolution.
  }

  return resolveConfigFrom({
    envProviderType: env.get('LLM_PROVIDER', 'ollama'),
    envHost: env.get('LLM_HOST') || env.get('OLLAMA_HOST', ''),
    envApiKey: env.get('LLM_API_KEY', ''),
    kvProtocol,
    kvHost,
    kvApiKey,
  })
}

/**
 * Resolve and fingerprint. The KV remote URL counts on the Ollama path too:
 * OllamaProvider resolves it at _initialize(), so a Settings change there must
 * produce a different fingerprint.
 */
export async function resolveConfigFingerprint(): Promise<string> {
  return fingerprintConfig(await resolveEffectiveConfig())
}

/**
 * Sync accessor: cached provider, or one built from env. Blind to runtime KV
 * changes — use ensureFreshProvider() where those are possible.
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
 * Rebuild if the resolved config changed since the provider was built. Cheap
 * to call often — a match costs one env read plus at most one KV read.
 */
export async function ensureFreshProvider(): Promise<LLMProvider> {
  const config = await resolveEffectiveConfig()
  const fingerprint = fingerprintConfig(config)
  if (!_instance || _fingerprint !== fingerprint) {
    if (_instance) {
      logger.info('[LLMFactory] LLM configuration changed — rebuilding provider')
    }
    // Built from the effective config, so a Settings-selected protocol yields
    // the matching provider — the sync path only sees env.
    _instance = buildProviderFrom(config)
    _fingerprint = fingerprint
  }
  return _instance
}

/** Reset the singleton (for testing) */
export function resetLLMProvider() {
  _instance = null
  _fingerprint = null
}
