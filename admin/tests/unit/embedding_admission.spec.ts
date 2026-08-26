import { test } from '@japa/runner'
import { OllamaService } from '../../app/services/ollama_service.js'

/**
 * Every dispatch site must ask the same question before touching the knowledge
 * base. The ZIM download path already did; direct uploads did not, so a file
 * uploaded with no backend configured was accepted with 202 and then failed
 * with an UnrecoverableError it could never recover from.
 */
function fakeDocker(ollamaUrl: string | null) {
  return { getServiceURL: async () => ollamaUrl } as any
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {}
  for (const k of ['EMBEDDING_HOST', 'LLM_HOST', 'OLLAMA_HOST']) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

test.group('embedding backend admission', () => {
  test('a dedicated embedding host is enough on its own', async ({ assert }) => {
    await withEnv({ EMBEDDING_HOST: 'http://embed:8000/v1' }, async () => {
      assert.isTrue(await OllamaService.isEmbeddingBackendConfigured(fakeDocker(null)))
    })
  })

  test('an env-configured LLM backend counts — no local container needed', async ({ assert }) => {
    await withEnv({ LLM_HOST: 'http://vllm:8000/v1' }, async () => {
      assert.isTrue(await OllamaService.isEmbeddingBackendConfigured(fakeDocker(null)))
    })
    await withEnv({ OLLAMA_HOST: 'http://ollama.svc:11434' }, async () => {
      assert.isTrue(await OllamaService.isEmbeddingBackendConfigured(fakeDocker(null)))
    })
  })

  test('Docker mode falls back to a discovered local container', async ({ assert }) => {
    await withEnv({}, async () => {
      assert.isTrue(
        await OllamaService.isEmbeddingBackendConfigured(fakeDocker('http://nomad_ollama:11434'))
      )
    })
  })

  test('nothing configured and nothing discovered means no backend', async ({ assert }) => {
    await withEnv({}, async () => {
      assert.isFalse(await OllamaService.isEmbeddingBackendConfigured(fakeDocker(null)))
    })
  })
})
