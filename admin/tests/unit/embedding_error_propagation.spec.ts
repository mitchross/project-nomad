import { test } from '@japa/runner'
import { RagService } from '../../app/services/rag_service.js'
import { EmbeddingIdentityMismatchError } from '../../app/services/rag/embedding_fingerprint.js'

test.group('embedding identity error propagation', () => {
  test('embedAndStoreText preserves identity mismatches for the queue worker', async ({ assert }) => {
    const mismatch = new EmbeddingIdentityMismatchError(
      'nomad_knowledge_base',
      'identity',
      'restore the previous embedding settings'
    )
    const service = Object.create(RagService.prototype) as any
    service._ensureCollection = async () => {
      throw mismatch
    }

    await assert.rejects(
      () => service.embedAndStoreText('content'),
      'restore the previous embedding settings'
    )
  })
})
