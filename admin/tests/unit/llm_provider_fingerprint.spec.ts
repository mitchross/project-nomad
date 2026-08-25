import { test } from '@japa/runner'
import {
  computeConfigFingerprint,
  createLLMProvider,
  ensureFreshProvider,
  resetLLMProvider,
} from '../../app/services/llm/provider_factory.js'

/**
 * The LLM provider is a per-process singleton, and NOMAD runs two processes
 * (HTTP server + queue worker), so provider reconfiguration is detected via a
 * configuration fingerprint rather than an in-process reset (which could never
 * reach the other process). These tests pin the fingerprint semantics and the
 * singleton behavior; the KV-driven rebuild path is exercised by the
 * fingerprint input tests since resolveConfigFingerprint() feeds the same
 * pure function.
 */
test.group('LLM provider config fingerprint', (group) => {
  group.each.teardown(() => {
    resetLLMProvider()
  })

  test('fingerprint changes when any selecting input changes', ({ assert }) => {
    const base = {
      providerType: 'ollama',
      host: 'http://ollama:11434',
      apiKey: '',
      kvRemoteUrl: '',
    }
    const fp = computeConfigFingerprint(base)

    assert.notEqual(fp, computeConfigFingerprint({ ...base, providerType: 'openai' }))
    assert.notEqual(fp, computeConfigFingerprint({ ...base, host: 'http://other:11434' }))
    assert.notEqual(fp, computeConfigFingerprint({ ...base, apiKey: 'sk-something' }))
    assert.notEqual(
      fp,
      computeConfigFingerprint({ ...base, kvRemoteUrl: 'http://192.168.1.50:11434' })
    )

    // Stable for identical input — the "no rebuild" case.
    assert.equal(fp, computeConfigFingerprint({ ...base }))
  })

  test('rotating the API key changes the fingerprint without exposing the secret', ({ assert }) => {
    const base = {
      providerType: 'openai',
      host: 'http://vllm:8000/v1',
      kvRemoteUrl: '',
    }
    const secretA = 'sk-super-secret-value-a'
    const secretB = 'sk-super-secret-value-b'
    const fpA = computeConfigFingerprint({ ...base, apiKey: secretA })
    const fpB = computeConfigFingerprint({ ...base, apiKey: secretB })

    assert.notEqual(fpA, fpB)
    assert.notInclude(fpA, secretA)
    assert.notInclude(fpB, secretB)
  })

  test('createLLMProvider returns a stable singleton until reset', ({ assert }) => {
    const first = createLLMProvider()
    const second = createLLMProvider()
    assert.strictEqual(first, second)

    resetLLMProvider()
    const third = createLLMProvider()
    assert.notStrictEqual(first, third)
  })

  test('ensureFreshProvider rebuilds a sync-created provider once, then holds it stable', async ({
    assert,
  }) => {
    // A provider built via the synchronous path has no fingerprint stamp, so
    // the first ensureFreshProvider() must rebuild-and-stamp; after that,
    // unchanged configuration must keep the same instance.
    const syncBuilt = createLLMProvider()
    const stamped = await ensureFreshProvider()
    assert.notStrictEqual(syncBuilt, stamped)

    const again = await ensureFreshProvider()
    assert.strictEqual(stamped, again)
  })
})
