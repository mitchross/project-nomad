import logger from '@adonisjs/core/services/logger'
import type { Availability } from './types.js'

/**
 * Cached, best-effort health probes for env-configured integrations
 * (Kubernetes/BYO endpoints). Docker-managed services don't use these —
 * their availability derives from container state, which the appliance
 * already tracks.
 *
 * Design constraints (review-agreed):
 * - NEVER probed inline on a request path. `getCachedAvailability()` returns
 *   instantly ('configured' when no result exists yet) and kicks a
 *   background refresh; the next call reads the cached verdict.
 * - Only cluster-internal API URLs are probed. Browser-facing URLs may be
 *   internet-external or LAN-only — probing them from the server is a
 *   hang/SSRF hazard, so they stay 'configured'.
 * - Short timeout, result cached with a TTL; probe failures are verdicts
 *   ('unhealthy'), not exceptions.
 */

const PROBE_TIMEOUT_MS = 1500
const CACHE_TTL_MS = 30_000

type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean }>

interface CacheEntry {
  verdict: Availability
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<void>>()

/** Test hook: clear cached verdicts and in-flight markers. */
export function resetProbeCache() {
  cache.clear()
  inflight.clear()
}

async function probeUrl(url: string, fetchImpl: FetchLike): Promise<Availability> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return response.ok ? 'reachable' : 'unhealthy'
  } catch {
    return 'unhealthy'
  }
}

/** The health endpoint for a given API base URL, per service protocol. */
export function healthUrlFor(serviceName: string, apiUrl: string): string {
  const base = apiUrl.trim().replace(/\/+$/, '')
  // Ollama-native answers /api/version; OpenAI-compatible bases (".../v1")
  // answer /models. Qdrant and Kiwix answer their root.
  if (/\/v1$/.test(base)) return `${base}/models`
  if (serviceName === 'nomad_ollama') return `${base}/api/version`
  return `${base}/`
}

/**
 * Instant cached verdict for an API endpoint. Returns 'configured' until a
 * background probe (kicked here, deduplicated) produces a real verdict, then
 * 'reachable'/'unhealthy' for CACHE_TTL_MS before re-probing.
 */
export function getCachedAvailability(
  serviceName: string,
  apiUrl: string,
  fetchImpl: FetchLike = fetch
): Availability {
  const key = `${serviceName}|${apiUrl}`
  const now = Date.now()
  const entry = cache.get(key)
  if (entry && entry.expiresAt > now) {
    return entry.verdict
  }

  if (!inflight.has(key)) {
    const refresh = probeUrl(healthUrlFor(serviceName, apiUrl), fetchImpl)
      .then((verdict) => {
        cache.set(key, { verdict, expiresAt: Date.now() + CACHE_TTL_MS })
      })
      .catch((err) => {
        logger.debug(`[ServiceIntegration] probe ${key} failed unexpectedly: ${err}`)
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, refresh)
  }

  // Stale entry (if any) is better than nothing while the refresh runs.
  return entry ? entry.verdict : 'configured'
}

/** Await the in-flight refresh for a key — test hook for determinism. */
export async function awaitProbe(serviceName: string, apiUrl: string): Promise<void> {
  await inflight.get(`${serviceName}|${apiUrl}`)
}
