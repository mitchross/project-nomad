import { test } from '@japa/runner'
import { unlink, writeFile } from 'node:fs/promises'
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

  test('processAndEmbedFile preserves the mismatch through file orchestration', async ({ assert }) => {
    const filePath = `/tmp/project-nomad-embedding-propagation-${process.pid}.txt`
    const mismatch = new EmbeddingIdentityMismatchError(
      'nomad_knowledge_base',
      'dimensions',
      'stores 768-dimensional vectors, but the configured model produces 384'
    )
    const service = Object.create(RagService.prototype) as any
    service.embedAndStoreText = async () => {
      throw mismatch
    }

    await writeFile(filePath, 'content')
    try {
      await assert.rejects(
        () => service.processAndEmbedFile(filePath),
        'stores 768-dimensional vectors, but the configured model produces 384'
      )
    } finally {
      await unlink(filePath)
    }
  })
})
