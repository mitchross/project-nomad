import { createHash } from 'node:crypto'

// A Qdrant collection only means something alongside the embedding config that
// produced its vectors, but Qdrant validates the vector SIZE alone: swap
// nomic-embed-text for another 768-dim model, or change a task prefix, and the
// incompatible vectors are accepted into the same space. Nothing errors —
// retrieval quality just degrades. The fingerprint below covers everything that
// defines that space. Credentials are excluded: rotating a key doesn't change
// the embeddings.

export interface EmbeddingIdentity {
  /** 'ollama' | 'openai' — different servers, different implementations. */
  providerKind: string
  /**
   * Normalized endpoint (scheme + host + port + path). Empty when the managed
   * local container serves embeddings — its identity is stable by definition.
   */
  endpoint: string
  model: string
  dimensions: number
  documentPrefix: string
  queryPrefix: string
}

// Stock defaults: any collection built before fingerprinting existed has this
// identity, which is what makes silent adoption safe for the common case.
export const LEGACY_DEFAULT_IDENTITY: Omit<EmbeddingIdentity, 'endpoint' | 'providerKind'> = {
  model: 'nomic-embed-text:v1.5',
  dimensions: 768,
  documentPrefix: 'search_document: ',
  queryPrefix: 'search_query: ',
}

/**
 * Strip credentials and trailing slashes so cosmetic URL differences don't read
 * as a different vector space. '' for empty input (managed container).
 */
export function normalizeEndpoint(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return ''
  // Only parse when there's a real http(s) scheme: `new URL` reads a bare
  // "host:11434" as scheme "host:", giving a nonsense identity.
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

// Prefixes are hashed verbatim — trailing spaces are significant to nomic.
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

// Fatal for the operation by design: continuing either errors inside Qdrant
// (dimension change) or silently poisons retrieval (same dimension, new model).
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
