/**
 * Shared protocol probes and config-lock rules for the Settings "Remote Ollama"
 * flow. Save-time validation and the status check must use the same probe, or
 * Save & Test and the status indicator disagree about what counts as valid.
 *
 * The Settings field belongs to the Docker appliance. Where env config already
 * owns provider selection — always so on Kubernetes/BYO — a saved KV URL could
 * never win resolution, so the save is refused rather than reporting a success
 * that isn't real. Precedence itself (env → KV → container) is unchanged.
 */

type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }>

/** True when the URL answers Ollama's native /api/version. */
export async function probeNativeOllama(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${normalizeBase(baseUrl)}/api/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

/** True when the URL answers an OpenAI-compatible /v1/models. */
export async function probeOpenAICompatible(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${normalizeBase(baseUrl)}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

export function normalizeBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export type RemoteConfigLock = 'kubernetes' | 'env' | null

/**
 * Who owns AI backend selection: 'kubernetes' (configured declaratively, so the
 * Settings mutation is refused regardless of env vars), 'env' (an LLM_PROVIDER
 * or LLM_HOST/OLLAMA_HOST setting outranks the KV URL, so a save could never
 * take effect), or null (the Docker appliance owns it — Settings works).
 */
export function resolveRemoteConfigLock(input: {
  kubernetesMode: boolean
  llmProvider?: string
  llmHost?: string
  ollamaHost?: string
}): RemoteConfigLock {
  if (input.kubernetesMode) return 'kubernetes'
  if (input.llmProvider === 'openai' || input.llmHost || input.ollamaHost) return 'env'
  return null
}

export const REMOTE_CONFIG_LOCK_MESSAGES: Record<Exclude<RemoteConfigLock, null>, string> = {
  kubernetes:
    'On Kubernetes, the AI backend is configured through deployment environment variables (LLM_PROVIDER / LLM_HOST / OLLAMA_HOST — e.g. the Kustomize ollama or external-llm component), not through this Settings field.',
  env:
    'The AI backend is already selected by deployment environment variables (LLM_PROVIDER / LLM_HOST / OLLAMA_HOST), which take precedence over this Settings field. Change or unset those variables to manage the backend here.',
}

/** Backend protocols a KV-configured remote can speak. */
export type RemoteProtocol = 'ollama' | 'openai'

export function isRemoteProtocol(value: unknown): value is RemoteProtocol {
  return value === 'ollama' || value === 'openai'
}

/**
 * Validate a remote backend by probing the protocol it CLAIMS to speak, and
 * report a mismatch when the other protocol answers instead. Save & Test,
 * connection status, and provider selection then agree by construction.
 */
export async function validateRemoteBackend(
  baseUrl: string,
  protocol: RemoteProtocol,
  timeoutMs = 5000,
  fetchImpl: FetchLike = fetch
): Promise<{ ok: true } | { ok: false; message: string }> {
  const wantsNative = protocol === 'ollama'
  const claimed = wantsNative
    ? await probeNativeOllama(baseUrl, timeoutMs, fetchImpl)
    : await probeOpenAICompatible(baseUrl, timeoutMs, fetchImpl)

  if (claimed) return { ok: true }

  // The claimed protocol didn't answer — check the other one so the error can
  // name the actual fix instead of a generic "could not connect".
  const other = wantsNative
    ? await probeOpenAICompatible(baseUrl, timeoutMs, fetchImpl)
    : await probeNativeOllama(baseUrl, timeoutMs, fetchImpl)

  if (other) {
    return {
      ok: false,
      message: wantsNative
        ? 'This server answered an OpenAI-compatible request but not Ollama\'s native API. Select "OpenAI-compatible" as the backend type (vLLM, llama.cpp, LM Studio, ...).'
        : 'This server answered Ollama\'s native API but not an OpenAI-compatible request. Select "Ollama" as the backend type.',
    }
  }

  return {
    ok: false,
    message: wantsNative
      ? `Could not reach an Ollama server at ${baseUrl}. Make sure it is running, reachable, and started with OLLAMA_HOST=0.0.0.0.`
      : `Could not reach an OpenAI-compatible server at ${baseUrl}. Check the URL (it usually ends in /v1) and that the server is running.`,
  }
}
