import { test } from '@japa/runner'
import {
  computeEmbeddingFingerprint,
  describeDimensionMismatch,
  describeIdentityMismatch,
  EmbeddingIdentityMismatchError,
  isLegacyDefaultIdentity,
  LEGACY_DEFAULT_IDENTITY,
  normalizeEndpoint,
  type EmbeddingIdentity,
} from '../../app/services/rag/embedding_fingerprint.js'

/**
 * Embedding collection identity. Qdrant validates only vector SIZE, so the
 * dangerous case is a same-dimension change of model/endpoint/prefix: writes
 * are accepted and two incompatible vector spaces mix silently. These tests
 * pin exactly which changes must be detected.
 */

function identity(overrides: Partial<EmbeddingIdentity> = {}): EmbeddingIdentity {
  return {
    providerKind: 'ollama',
    endpoint: '',
    model: 'nomic-embed-text:v1.5',
    dimensions: 768,
    documentPrefix: 'search_document: ',
    queryPrefix: 'search_query: ',
    ...overrides,
  }
}

test.group('embedding fingerprint', () => {
  test('identical configuration produces a stable fingerprint', ({ assert }) => {
    assert.equal(computeEmbeddingFingerprint(identity()), computeEmbeddingFingerprint(identity()))
  })

  test('the silent-corruption case is detected: same dimensions, different model', ({ assert }) => {
    // bge-base is also 768-dimensional, so Qdrant would accept these vectors
    // into a nomic collection without complaint.
    const nomic = computeEmbeddingFingerprint(identity())
    const bge = computeEmbeddingFingerprint(identity({ model: 'bge-base-en-v1.5' }))
    assert.notEqual(nomic, bge)
  })

  test('changing a search prefix changes the identity', ({ assert }) => {
    const base = computeEmbeddingFingerprint(identity())
    assert.notEqual(base, computeEmbeddingFingerprint(identity({ documentPrefix: 'passage: ' })))
    assert.notEqual(base, computeEmbeddingFingerprint(identity({ queryPrefix: 'query: ' })))
    // Trailing whitespace is semantically significant to nomic — not cosmetic.
    assert.notEqual(base, computeEmbeddingFingerprint(identity({ documentPrefix: 'search_document:' })))
  })

  test('dimensions and provider kind participate in the identity', ({ assert }) => {
    const base = computeEmbeddingFingerprint(identity())
    assert.notEqual(base, computeEmbeddingFingerprint(identity({ dimensions: 1024 })))
    assert.notEqual(base, computeEmbeddingFingerprint(identity({ providerKind: 'openai' })))
  })

  test('a different embedding endpoint is a different identity', ({ assert }) => {
    const a = computeEmbeddingFingerprint(identity({ endpoint: 'http://tei-a:80/v1' }))
    const b = computeEmbeddingFingerprint(identity({ endpoint: 'http://tei-b:80/v1' }))
    assert.notEqual(a, b)
  })

  test('cosmetic endpoint differences do NOT change the identity', ({ assert }) => {
    const plain = computeEmbeddingFingerprint(identity({ endpoint: 'http://tei:80/v1' }))
    const trailing = computeEmbeddingFingerprint(identity({ endpoint: 'http://tei:80/v1/' }))
    const cased = computeEmbeddingFingerprint(identity({ endpoint: 'HTTP://TEI:80/v1' }))
    assert.equal(plain, trailing)
    assert.equal(plain, cased)
  })

  test('credentials never affect the identity and never appear in it', ({ assert }) => {
    const clean = computeEmbeddingFingerprint(identity({ endpoint: 'http://tei:80/v1' }))
    const withCreds = computeEmbeddingFingerprint(
      identity({ endpoint: 'http://user:sup3rsecret@tei:80/v1' })
    )
    assert.equal(clean, withCreds)
    assert.notInclude(withCreds, 'sup3rsecret')
  })
})

test.group('endpoint normalization', () => {
  test('strips credentials, query, fragment and trailing slashes', ({ assert }) => {
    assert.equal(
      normalizeEndpoint('https://u:p@Host:8443/v1/?x=1#frag'),
      'https://host:8443/v1'
    )
  })

  test('empty input (managed container) normalizes to empty', ({ assert }) => {
    assert.equal(normalizeEndpoint(''), '')
    assert.equal(normalizeEndpoint(null), '')
    assert.equal(normalizeEndpoint(undefined), '')
  })

  test('non-URL values are normalized conservatively rather than thrown away', ({ assert }) => {
    assert.equal(normalizeEndpoint('  Ollama-Host:11434/  '), 'ollama-host:11434')
  })
})

test.group('legacy identity adoption', () => {
  test('upstream defaults are recognized as the legacy identity', ({ assert }) => {
    assert.isTrue(isLegacyDefaultIdentity(identity()))
    assert.equal(identity().model, LEGACY_DEFAULT_IDENTITY.model)
  })

  test('any material deviation is not the legacy identity', ({ assert }) => {
    assert.isFalse(isLegacyDefaultIdentity(identity({ model: 'bge-base-en-v1.5' })))
    assert.isFalse(isLegacyDefaultIdentity(identity({ dimensions: 1024 })))
    assert.isFalse(isLegacyDefaultIdentity(identity({ queryPrefix: 'query: ' })))
  })
})

test.group('mismatch reporting', () => {
  test('dimension mismatch names both sizes and both remedies', ({ assert }) => {
    const message = describeDimensionMismatch('nomad_knowledge_base', 768, 1024)
    assert.include(message, '768')
    assert.include(message, '1024')
    assert.match(message, /reindex/i)
  })

  test('identity mismatch explains the silent-degradation risk and preserves data', ({ assert }) => {
    const message = describeIdentityMismatch('nomad_knowledge_base')
    assert.match(message, /retrieval quality/i)
    assert.match(message, /untouched/i)
  })

  test('the error carries a machine-readable reason for callers', ({ assert }) => {
    const error = new EmbeddingIdentityMismatchError('c', 'dimensions', 'msg')
    assert.equal(error.reason, 'dimensions')
    assert.equal(error.collectionName, 'c')
    assert.instanceOf(error, Error)
  })
})
