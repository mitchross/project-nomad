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

/**
 * The backend actually in effect, and where its configuration came from.
 * `source` drives ownership decisions elsewhere (a managed local container is
 * ours to mutate; an env- or Settings-configured remote is not, unless the
 * operator says so explicitly).
 */
export interface EffectiveLLMConfig {
  providerType: 'ollama' | 'openai'
  /** Empty for the Ollama path when the local container is discovered. */
  host: string
  apiKey: string
  source: 'env' | 'settings' | 'managed-container'
}

/**
 * Configuration precedence — deliberately unchanged by protocol selection:
 *   1. deployment environment (LLM_PROVIDER / LLM_HOST / OLLAMA_HOST)
 *   2. Settings-configured remote (KV: protocol + URL + optional key)
 *   3. NOMAD's managed Docker container (discovery)
 *
 * Declarative/GitOps configuration always outranks the Settings field, which
 * is why the Settings flow refuses to save while env config is present.
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

/** Fingerprint of an effective config (post-precedence). */
export function fingerprintConfig(config: EffectiveLLMConfig): string {
  return computeConfigFingerprint({
    providerType: config.providerType,
    host: config.host,
    apiKey: config.apiKey === 'unused' ? '' : config.apiKey,
    kvRemoteUrl: config.source,
  })
}

/**
 * Gather the live configuration from env AND Settings, applying precedence.
 * Async because Settings live in the database.
 */
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
 * Gather the live configuration and fingerprint it. The KV remote URL is
 * included for the Ollama path because OllamaProvider resolves it at
 * _initialize() time; a runtime change through Settings must produce a
 * different fingerprint.
 */
export async function resolveConfigFingerprint(): Promise<string> {
  return fingerprintConfig(await resolveEffectiveConfig())
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
  const config = await resolveEffectiveConfig()
  const fingerprint = fingerprintConfig(config)
  if (!_instance || _fingerprint !== fingerprint) {
    if (_instance) {
      logger.info('[LLMFactory] LLM configuration changed — rebuilding provider')
    }
    // Built from the EFFECTIVE config, so a Settings-selected protocol
    // (e.g. OpenAI-compatible) produces the matching provider — the
    // synchronous path can only see env.
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
