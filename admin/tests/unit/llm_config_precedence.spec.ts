import { test } from '@japa/runner'
import {
  fingerprintConfig,
  resolveConfigFrom,
} from '../../app/services/llm/provider_factory.js'
import {
  isRemoteProtocol,
  validateRemoteBackend,
} from '../../app/services/llm/remote_ollama_config.js'

/**
 * Backend configuration precedence and protocol handling.
 *
 * Precedence is a product decision, not an implementation detail: declarative
 * deployment config (env/Kustomize/GitOps) must always outrank the Settings
 * field, which is why the Settings flow refuses to save while env config is
 * present rather than silently losing to it.
 */
test.group('LLM config precedence', () => {
  test('env configuration outranks Settings', ({ assert }) => {
    const config = resolveConfigFrom({
      envProviderType: 'openai',
      envHost: 'http://vllm:8000/v1',
      envApiKey: 'sk-env',
      kvProtocol: 'ollama',
      kvHost: 'http://settings-box:11434',
    })
    assert.equal(config.source, 'env')
    assert.equal(config.providerType, 'openai')
    assert.equal(config.host, 'http://vllm:8000/v1')
  })

  test('an env Ollama host wins even with the default provider type', ({ assert }) => {
    const config = resolveConfigFrom({
      envProviderType: 'ollama',
      envHost: 'http://remote:11434',
      kvHost: 'http://settings-box:11434',
    })
    assert.equal(config.source, 'env')
    assert.equal(config.host, 'http://remote:11434')
  })

  test('Settings config applies when no env host is set — including OpenAI protocol', ({
    assert,
  }) => {
    const config = resolveConfigFrom({
      envProviderType: 'ollama',
      envHost: '',
      kvProtocol: 'openai',
      kvHost: 'http://lmstudio:1234/v1',
      kvApiKey: 'sk-local',
    })
    assert.equal(config.source, 'settings')
    // The regression this closes: a Settings-selected OpenAI backend used to
    // be driven through the Ollama client and fail on every /api/* call.
    assert.equal(config.providerType, 'openai')
    assert.equal(config.apiKey, 'sk-local')
  })

  test('a Settings URL with no stored protocol resolves as Ollama (legacy installs)', ({
    assert,
  }) => {
    const config = resolveConfigFrom({ kvHost: 'http://192.168.1.50:11434' })
    assert.equal(config.providerType, 'ollama')
    assert.equal(config.source, 'settings')
  })

  test('no env and no Settings falls back to the managed container', ({ assert }) => {
    const config = resolveConfigFrom({})
    assert.equal(config.source, 'managed-container')
    assert.equal(config.host, '')
    assert.equal(config.providerType, 'ollama')
  })

  test('fingerprints distinguish protocol, host, key and source without leaking secrets', ({
    assert,
  }) => {
    const base = resolveConfigFrom({ kvHost: 'http://box:11434', kvProtocol: 'ollama' })
    const asOpenAI = resolveConfigFrom({ kvHost: 'http://box:11434', kvProtocol: 'openai' })
    const withKey = resolveConfigFrom({
      kvHost: 'http://box:11434',
      kvProtocol: 'openai',
      kvApiKey: 'sk-secret-value',
    })

    assert.notEqual(fingerprintConfig(base), fingerprintConfig(asOpenAI))
    assert.notEqual(fingerprintConfig(asOpenAI), fingerprintConfig(withKey))
    assert.notInclude(fingerprintConfig(withKey), 'sk-secret-value')
  })
})

test.group('remote backend protocol validation', () => {
  function fakeFetch(routes: Record<string, boolean>) {
    return async (url: string, _init: { signal: AbortSignal }) => {
      for (const [suffix, ok] of Object.entries(routes)) {
        if (url.endsWith(suffix)) return { ok }
      }
      throw new Error('ECONNREFUSED')
    }
  }

  test('accepts a server that speaks the selected protocol', async ({ assert }) => {
    const ollama = await validateRemoteBackend(
      'http://box:11434',
      'ollama',
      50,
      fakeFetch({ '/api/version': true })
    )
    assert.isTrue(ollama.ok)

    const openai = await validateRemoteBackend(
      'http://vllm:8000/v1',
      'openai',
      50,
      fakeFetch({ '/v1/models': true })
    )
    assert.isTrue(openai.ok)
  })

  test('a protocol mismatch names the type to select instead of failing generically', async ({
    assert,
  }) => {
    // vLLM selected as "Ollama"
    const asOllama = await validateRemoteBackend(
      'http://vllm:8000',
      'ollama',
      50,
      fakeFetch({ '/v1/models': true })
    )
    assert.isFalse(asOllama.ok)
    assert.match((asOllama as { message: string }).message, /OpenAI-compatible/i)

    // Ollama selected as "OpenAI-compatible"
    const asOpenAI = await validateRemoteBackend(
      'http://box:11434',
      'openai',
      50,
      fakeFetch({ '/api/version': true })
    )
    assert.isFalse(asOpenAI.ok)
    assert.match((asOpenAI as { message: string }).message, /Ollama/i)
  })

  test('an unreachable server reports a connection problem, not a mismatch', async ({ assert }) => {
    const result = await validateRemoteBackend('http://nope:11434', 'ollama', 50, fakeFetch({}))
    assert.isFalse(result.ok)
    assert.match((result as { message: string }).message, /could not reach/i)
  })

  test('isRemoteProtocol guards stored/user input', ({ assert }) => {
    assert.isTrue(isRemoteProtocol('ollama'))
    assert.isTrue(isRemoteProtocol('openai'))
    assert.isFalse(isRemoteProtocol('vllm'))
    assert.isFalse(isRemoteProtocol(null))
  })
})
