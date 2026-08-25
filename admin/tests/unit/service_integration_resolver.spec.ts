import { test } from '@japa/runner'
import { resolveIntegration, type ResolutionContext } from '../../app/services/service_integration/resolver.js'
import type { ServiceRowLike } from '../../app/services/service_integration/types.js'
import { SERVICE_NAMES } from '../../constants/service_names.js'

/**
 * Table-driven descriptor resolution across every deployment shape the
 * architecture handoff names. The PR 1 parity contract is asserted
 * throughout: workload capabilities are all-true only for Docker-managed
 * services in the Docker runtime, and all-false on Kubernetes — matching the
 * guard behavior that preceded descriptors.
 */

function row(overrides: Partial<ServiceRowLike> & { service_name: string }): ServiceRowLike {
  return {
    installed: false,
    is_custom: false,
    is_deprecated: false,
    ui_location: null,
    custom_url: null,
    ...overrides,
  }
}

function ctx(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    runtimeContext: 'docker',
    envValue: () => undefined,
    llmProviderType: 'ollama',
    kvRemoteOllamaUrl: null,
    dockerStatusFor: () => undefined,
    availabilityFor: () => 'configured',
    ...overrides,
  }
}

const WORKLOAD_CAPS = [
  'canInstall',
  'canUninstall',
  'canStartStop',
  'canRestart',
  'canUpdateWorkload',
  'canViewLogs',
  'canViewStats',
] as const

test.group('ServiceIntegration resolution', () => {
  test('Docker-managed installed app: full workload capabilities, availability from container state', ({ assert }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.KIWIX, installed: true, ui_location: '8090' }),
      ctx({ dockerStatusFor: () => 'running' })
    )
    assert.equal(integration.provisioner, 'nomad-docker')
    assert.equal(integration.availability, 'reachable')
    for (const cap of WORKLOAD_CAPS) assert.isTrue(integration.capabilities[cap], cap)
    assert.equal(integration.contentOwner, 'nomad')
    assert.isTrue(integration.capabilities.canManageContent)
  })

  test('Docker not-installed app: still installable (upstream appliance), availability disabled', ({ assert }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.CYBERCHEF }),
      ctx()
    )
    assert.equal(integration.provisioner, 'nomad-docker')
    assert.equal(integration.availability, 'disabled')
    assert.isTrue(integration.capabilities.canInstall)
  })

  test('Docker installed but exited container: unhealthy, not running', ({ assert }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.FLATNOTES, installed: true }),
      ctx({ dockerStatusFor: () => 'exited' })
    )
    assert.equal(integration.availability, 'unhealthy')
  })

  test('Docker Ollama with Settings remote URL: local workload stays managed, models external', ({ assert }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.OLLAMA, installed: true, ui_location: '/chat' }),
      ctx({ kvRemoteOllamaUrl: 'http://192.168.1.50:11434', dockerStatusFor: () => 'running' })
    )
    // The provisioner describes the LOCAL container — still NOMAD's.
    assert.equal(integration.provisioner, 'nomad-docker')
    assert.isTrue(integration.capabilities.canStartStop)
    // But the AI endpoint and model ownership follow the remote config
    // (consistent with the PR 0 no-eviction rule).
    assert.equal(integration.endpoints.apiUrl, 'http://192.168.1.50:11434')
    assert.equal(integration.modelOwner, 'external')
    assert.isFalse(integration.capabilities.canManageModels)
  })

  test('Docker Ollama fully local: NOMAD owns models', ({ assert }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.OLLAMA, installed: true, ui_location: '/chat' }),
      ctx({ dockerStatusFor: () => 'running' })
    )
    assert.equal(integration.modelOwner, 'nomad')
    assert.isTrue(integration.capabilities.canManageModels)
    assert.equal(integration.endpoints.browserUrl, '/chat')
  })

  test('K8s bundled Ollama (LLM_HOST, ollama provider): gitops workload, NOMAD-owned models', ({ assert }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.OLLAMA, installed: true }),
      ctx({
        runtimeContext: 'kubernetes',
        envValue: (name) => (name === 'LLM_HOST' ? 'http://ollama:11434' : undefined),
        availabilityFor: () => 'reachable',
      })
    )
    assert.equal(integration.provisioner, 'gitops')
    assert.equal(integration.availability, 'reachable')
    assert.equal(integration.endpoints.apiUrl, 'http://ollama:11434')
    for (const cap of WORKLOAD_CAPS) assert.isFalse(integration.capabilities[cap], cap)
    // Bundled-dedicated assumption (documented; PR 3 adds the explicit flag).
    assert.equal(integration.modelOwner, 'nomad')
    assert.isTrue(integration.capabilities.canManageModels)
  })

  test('K8s external vLLM (openai provider): no workload caps, no model management', ({ assert }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.OLLAMA, installed: true }),
      ctx({
        runtimeContext: 'kubernetes',
        llmProviderType: 'openai',
        envValue: (name) => (name === 'LLM_HOST' ? 'http://vllm:8000/v1' : undefined),
        availabilityFor: () => 'reachable',
      })
    )
    assert.equal(integration.provisioner, 'gitops')
    assert.equal(integration.modelOwner, 'external')
    assert.isFalse(integration.capabilities.canManageModels)
  })

  test('K8s Kiwix: gitops workload, NOMAD-owned shared content, management URL', ({ assert }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.KIWIX, installed: true }),
      ctx({
        runtimeContext: 'kubernetes',
        envValue: (name) => (name === 'KIWIX_URL' ? 'http://kiwix:8080' : undefined),
        availabilityFor: () => 'reachable',
      })
    )
    assert.equal(integration.contentOwner, 'nomad')
    assert.isTrue(integration.capabilities.canManageContent)
    assert.equal(integration.endpoints.managementUrl, '/settings/zim/remote-explorer')
    for (const cap of WORKLOAD_CAPS) assert.isFalse(integration.capabilities[cap], cap)
  })

  test('K8s browser-link companion (Kolibri Gen2): configured, open-only, never probed', ({ assert }) => {
    let probed = false
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.KOLIBRI_GEN2, installed: true }),
      ctx({
        runtimeContext: 'kubernetes',
        envValue: (name) => (name === 'KOLIBRI_URL' ? 'https://kolibri.example.com' : undefined),
        availabilityFor: () => {
          probed = true
          return 'reachable'
        },
      })
    )
    assert.equal(integration.availability, 'configured')
    assert.isFalse(probed, 'browser-facing URLs must not be server-probed')
    assert.equal(integration.endpoints.browserUrl, 'https://kolibri.example.com')
    assert.isTrue(integration.capabilities.canOpen)
    for (const cap of WORKLOAD_CAPS) assert.isFalse(integration.capabilities[cap], cap)
  })

  test('K8s unmapped catalog app (Supply Depot) and stale Docker-era rows: none/disabled', ({ assert }) => {
    for (const name of ['nomad_stirling_pdf', SERVICE_NAMES.CYBERCHEF]) {
      const integration = resolveIntegration(
        row({ service_name: name, installed: name !== 'nomad_stirling_pdf' }),
        ctx({ runtimeContext: 'kubernetes', envValue: () => undefined })
      )
      assert.equal(integration.provisioner, 'none', name)
      assert.equal(integration.availability, 'disabled', name)
      for (const cap of WORKLOAD_CAPS) assert.isFalse(integration.capabilities[cap], `${name}.${cap}`)
    }
  })

  test('custom_url only overrides the launch link (upstream semantic)', ({ assert }) => {
    const integration = resolveIntegration(
      row({
        service_name: SERVICE_NAMES.FLATNOTES,
        installed: true,
        ui_location: '8200',
        custom_url: 'https://notes.example.com',
      }),
      ctx({ dockerStatusFor: () => 'running' })
    )
    assert.equal(integration.endpoints.browserUrl, 'https://notes.example.com')
    assert.isTrue(integration.capabilities.canOpen)
    assert.isTrue(integration.capabilities.canStartStop)
  })
})
