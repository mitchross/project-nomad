import { test } from '@japa/runner'
import {
  normalizeBase,
  probeNativeOllama,
  probeOpenAICompatible,
  resolveRemoteConfigLock,
  REMOTE_CONFIG_LOCK_MESSAGES,
} from '../../app/services/llm/remote_ollama_config.js'

/**
 * The Settings Remote Ollama flow: Save & Test (configureRemote) and the
 * later connection status (remoteStatus) share these probes, so they can
 * never disagree about what a valid Ollama backend is; the lock rules keep
 * deployment-owned configuration (Kubernetes, LLM_* env) from being silently
 * "overridden" by a KV save that provider resolution would never honor.
 */

function fakeFetch(routes: Record<string, boolean>) {
  const calls: string[] = []
  const impl = async (url: string, _init: { signal: AbortSignal }) => {
    calls.push(url)
    for (const [suffix, ok] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return { ok }
    }
    throw new Error(`connect ECONNREFUSED (${url})`)
  }
  return { impl, calls }
}

test.group('remote Ollama probes', () => {
  test('native probe hits /api/version and reflects its answer', async ({ assert }) => {
    const up = fakeFetch({ '/api/version': true })
    assert.isTrue(await probeNativeOllama('http://remote:11434/', 1000, up.impl))
    assert.deepEqual(up.calls, ['http://remote:11434/api/version'])

    const down = fakeFetch({ '/api/version': false })
    assert.isFalse(await probeNativeOllama('http://remote:11434', 1000, down.impl))

    const unreachable = fakeFetch({})
    assert.isFalse(await probeNativeOllama('http://remote:11434', 1000, unreachable.impl))
  })

  test('an OpenAI-compatible-only server fails the native probe but passes the compat probe', async ({
    assert,
  }) => {
    // vLLM / LM Studio / llama.cpp shape: /v1/models answers, /api/version does not.
    const routes = fakeFetch({ '/v1/models': true })
    assert.isFalse(await probeNativeOllama('http://vllm:8000', 1000, routes.impl))
    assert.isTrue(await probeOpenAICompatible('http://vllm:8000', 1000, routes.impl))
  })

  test('normalizeBase trims whitespace and trailing slashes', ({ assert }) => {
    assert.equal(normalizeBase('  http://host:11434///  '), 'http://host:11434')
  })
})

test.group('remote config lock', () => {
  test('Docker appliance with no env backend is unlocked', ({ assert }) => {
    assert.isNull(
      resolveRemoteConfigLock({ kubernetesMode: false })
    )
    assert.isNull(
      resolveRemoteConfigLock({ kubernetesMode: false, llmProvider: 'ollama' })
    )
  })

  test('Kubernetes always locks, regardless of env vars', ({ assert }) => {
    assert.equal(resolveRemoteConfigLock({ kubernetesMode: true }), 'kubernetes')
    assert.equal(
      resolveRemoteConfigLock({ kubernetesMode: true, llmHost: 'http://ollama:11434' }),
      'kubernetes'
    )
  })

  test('env-configured backend selection locks the Settings flow', ({ assert }) => {
    assert.equal(
      resolveRemoteConfigLock({ kubernetesMode: false, llmProvider: 'openai' }),
      'env'
    )
    assert.equal(
      resolveRemoteConfigLock({ kubernetesMode: false, llmHost: 'http://vllm:8000/v1' }),
      'env'
    )
    assert.equal(
      resolveRemoteConfigLock({ kubernetesMode: false, ollamaHost: 'http://remote:11434' }),
      'env'
    )
  })

  test('every lock state has an actionable message naming the env-var alternative', ({
    assert,
  }) => {
    for (const message of Object.values(REMOTE_CONFIG_LOCK_MESSAGES)) {
      assert.include(message, 'LLM_PROVIDER')
    }
  })
})
