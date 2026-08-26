import { createHash } from 'node:crypto'

/**
 * Embedding collection identity (PR 4 of the Kubernetes/BYO sequence).
 *
 * A Qdrant collection is only meaningful together with the embedding
 * configuration that produced its vectors. Qdrant itself validates just the
 * vector SIZE, so two genuinely incompatible configurations at the same
 * dimension — nomic-embed-text vs bge, or a change of task prefix — are
 * accepted silently and mixed into one vector space. Nothing errors; retrieval
 * quality simply degrades, which is the worst possible failure mode.
 *
 * The fingerprint captures everything that materially defines the vector
 * space. Credentials are never part of it: rotating an API key does not change
 * the embeddings.
 */

export interface EmbeddingIdentity {
  /** 'ollama' | 'openai' — different servers, different implementations. */
  providerKind: string
  /**
   * Endpoint identity, normalized (scheme + host + port + path, no
   * credentials, no trailing slash). Empty when NOMAD's managed local
   * container serves embeddings — its identity is stable by definition.
   */
  endpoint: string
  model: string
  dimensions: number
  documentPrefix: string
  queryPrefix: string
}

/**
 * Upstream's shipped defaults. A collection created by any stock NOMAD before
 * fingerprinting existed has exactly this identity, which is what makes silent
 * adoption safe for the overwhelmingly common case.
 */
export const LEGACY_DEFAULT_IDENTITY: Omit<EmbeddingIdentity, 'endpoint' | 'providerKind'> = {
  model: 'nomic-embed-text:v1.5',
  dimensions: 768,
  documentPrefix: 'search_document: ',
  queryPrefix: 'search_query: ',
}

/**
 * Normalize an endpoint for identity purposes: strip credentials, default
 * ports, and trailing slashes so cosmetic URL differences don't read as a
 * different vector space. Returns '' for empty input (managed container).
 */
export function normalizeEndpoint(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return ''
  // Only parse as a URL when it actually carries an http(s) scheme. `new URL`
  // happily reads a bare "host:11434" as scheme "host:", which would produce a
  // nonsense identity — the conservative fallback below is correct for those.
  if (!/^https?:\/\//i.test(raw.trim())) {
    return raw.trim().replace(/\/+$/, '').toLowerCase()
  }
  try {
    const url = new URL(raw.trim())
    url.username = ''
    url.password = ''
    url.hash = ''
    url.search = ''
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host}${path}`.toLowerCase()
  } catch {
    // Not a URL (host:port, or a name) — normalize conservatively.
    return raw.trim().replace(/\/+$/, '').toLowerCase()
  }
}

/**
 * Stable fingerprint of an embedding identity. Prefixes are included verbatim
 * (including trailing spaces, which are semantically significant to nomic) and
 * hashed, so the stored value stays short and opaque.
 */
export function computeEmbeddingFingerprint(identity: EmbeddingIdentity): string {
  const canonical = JSON.stringify({
    p: identity.providerKind,
    e: normalizeEndpoint(identity.endpoint),
    m: identity.model,
    d: identity.dimensions,
    dp: identity.documentPrefix,
    qp: identity.queryPrefix,
  })
  return `v1:${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`
}

/** True when this identity matches upstream's shipped defaults. */
export function isLegacyDefaultIdentity(identity: EmbeddingIdentity): boolean {
  return (
    identity.model === LEGACY_DEFAULT_IDENTITY.model &&
    identity.dimensions === LEGACY_DEFAULT_IDENTITY.dimensions &&
    identity.documentPrefix === LEGACY_DEFAULT_IDENTITY.documentPrefix &&
    identity.queryPrefix === LEGACY_DEFAULT_IDENTITY.queryPrefix
  )
}

/**
 * Raised when a collection's embedding identity does not match the running
 * configuration. Deliberately fatal for the operation: continuing would either
 * error inside Qdrant (dimension change) or silently poison retrieval quality
 * (same dimension, different model/prefix).
 */
export class EmbeddingIdentityMismatchError extends Error {
  readonly collectionName: string
  readonly reason: 'dimensions' | 'identity'

  constructor(collectionName: string, reason: 'dimensions' | 'identity', message: string) {
    super(message)
    this.name = 'EmbeddingIdentityMismatchError'
    this.collectionName = collectionName
    this.reason = reason
  }
}

export function describeDimensionMismatch(
  collectionName: string,
  actual: number,
  configured: number
): string {
  return (
    `Knowledge base collection "${collectionName}" stores ${actual}-dimensional vectors, ` +
    `but the configured embedding model produces ${configured}. Writing or searching would fail. ` +
    `Set EMBEDDING_DIMENSIONS back to ${actual} (and restore the matching EMBEDDING_MODEL), ` +
    `or reindex the knowledge base with the new model to rebuild the collection.`
  )
}

export function describeIdentityMismatch(collectionName: string): string {
  return (
    `Knowledge base collection "${collectionName}" was built with a different embedding ` +
    `configuration (model, endpoint, or search prefixes) than the one now configured. ` +
    `The vectors are the same size, so Qdrant would accept them — but they belong to a ` +
    `different embedding space, which silently degrades retrieval quality. ` +
    `Restore the previous embedding settings, or reindex the knowledge base to rebuild it ` +
    `with the current configuration. Existing data is left untouched until you choose.`
  )
}
