import { test } from '@japa/runner'
import {
  awaitProbe,
  getCachedAvailability,
  healthUrlFor,
  resetProbeCache,
} from '../../app/services/service_integration/health_probes.js'

/**
 * Probe contract: never blocks the caller (returns 'configured' until a
 * background probe lands), caches verdicts, and picks the right health
 * endpoint per protocol.
 */
test.group('service integration health probes', (group) => {
  group.each.setup(() => {
    resetProbeCache()
    return () => resetProbeCache()
  })

  test('healthUrlFor picks the protocol-appropriate endpoint', ({ assert }) => {
    assert.equal(healthUrlFor('nomad_ollama', 'http://ollama:11434/'), 'http://ollama:11434/api/version')
    assert.equal(healthUrlFor('nomad_ollama', 'http://vllm:8000/v1'), 'http://vllm:8000/v1/models')
    assert.equal(healthUrlFor('nomad_qdrant', 'http://qdrant:6333'), 'http://qdrant:6333/')
  })

  test('first call returns configured, probe result lands in cache', async ({ assert }) => {
    const fetchOk = async () => ({ ok: true })
    const first = getCachedAvailability('nomad_qdrant', 'http://qdrant:6333', fetchOk)
    assert.equal(first, 'configured')

    await awaitProbe('nomad_qdrant', 'http://qdrant:6333')
    const second = getCachedAvailability('nomad_qdrant', 'http://qdrant:6333', fetchOk)
    assert.equal(second, 'reachable')
  })

  test('failed and non-ok probes report unhealthy, not exceptions', async ({ assert }) => {
    const fetchDown = async () => {
      throw new Error('ECONNREFUSED')
    }
    getCachedAvailability('nomad_ollama', 'http://down:11434', fetchDown)
    await awaitProbe('nomad_ollama', 'http://down:11434')
    assert.equal(getCachedAvailability('nomad_ollama', 'http://down:11434', fetchDown), 'unhealthy')

    const fetch500 = async () => ({ ok: false })
    getCachedAvailability('nomad_kiwix_server', 'http://kiwix:8080', fetch500)
    await awaitProbe('nomad_kiwix_server', 'http://kiwix:8080')
    assert.equal(
      getCachedAvailability('nomad_kiwix_server', 'http://kiwix:8080', fetch500),
      'unhealthy'
    )
  })

  test('concurrent callers share one in-flight probe', async ({ assert }) => {
    let calls = 0
    const fetchCounting = async () => {
      calls++
      return { ok: true }
    }
    getCachedAvailability('nomad_qdrant', 'http://q:6333', fetchCounting)
    getCachedAvailability('nomad_qdrant', 'http://q:6333', fetchCounting)
    getCachedAvailability('nomad_qdrant', 'http://q:6333', fetchCounting)
    await awaitProbe('nomad_qdrant', 'http://q:6333')
    assert.equal(calls, 1)
  })
})
