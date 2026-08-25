/**
 * Shared protocol probes and configuration-lock rules for the Settings
 * "Remote Ollama" flow (OllamaController.configureRemote / remoteStatus).
 *
 * Both the save-time validation and the later connection-status check MUST use
 * the same probe, or Save & Test and the status indicator can disagree about
 * what counts as a valid Ollama backend (Codex finding P1.3 follow-up).
 *
 * The lock rules keep the boundary honest: the Settings field belongs to the
 * Docker/Compose appliance. When deployment configuration (LLM_PROVIDER /
 * LLM_HOST / OLLAMA_HOST) already owns provider selection — always the case
 * for Kubernetes/BYO — the KV URL would be saved but never win provider
 * resolution, so the save must be refused with an actionable message rather
 * than reporting a success that isn't real. Provider precedence itself
 * (env → KV → managed container) is deliberately unchanged.
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
 * Who owns AI backend selection for this deployment?
 *
 * - 'kubernetes': Kubernetes/BYO deployments configure AI declaratively
 *   (env/Kustomize) until the provider/integration UI lands; the Settings
 *   mutation is refused there regardless of env vars.
 * - 'env': LLM_PROVIDER=openai or an LLM_HOST/OLLAMA_HOST env host outranks
 *   the KV URL in provider resolution, so a Settings save could never take
 *   effect and must be refused.
 * - null: the Docker/Compose appliance owns selection — Settings flow works.
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
