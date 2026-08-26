import { test } from '@japa/runner'
import { resolveIntegration, type ResolutionContext } from '../../app/services/service_integration/resolver.js'
import { parseKiwixContentMode } from '../../app/services/service_integration/capability_rules.js'
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
    kvRemoteManagedByNomad: null,
    dockerStatusFor: () => undefined,
    availabilityFor: () => 'configured',
    kiwixContentMode: 'shared',
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
    // Bundled-dedicated DEFAULT; an operator can override it explicitly
    // (see the model-ownership group below).
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
    // The API URL is a cluster-internal Service name. Offering it as a launch
    // link would render a button no browser can follow.
    assert.equal(integration.endpoints.apiUrl, 'http://kiwix:8080')
    assert.isUndefined(integration.endpoints.browserUrl)
    assert.isFalse(integration.capabilities.canOpen)
    for (const cap of WORKLOAD_CAPS) assert.isFalse(integration.capabilities[cap], cap)
  })

  test('K8s Kiwix with an ingress hostname: browse and API addresses stay distinct', ({
    assert,
  }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.KIWIX, installed: true }),
      ctx({
        runtimeContext: 'kubernetes',
        envValue: (name) =>
          name === 'KIWIX_URL'
            ? 'http://kiwix:8080'
            : name === 'KIWIX_BROWSER_URL'
              ? 'https://kiwix.example.com'
              : undefined,
        availabilityFor: () => 'reachable',
      })
    )
    assert.equal(integration.endpoints.apiUrl, 'http://kiwix:8080')
    assert.equal(integration.endpoints.browserUrl, 'https://kiwix.example.com')
    assert.isTrue(integration.capabilities.canOpen)
    // Still NOMAD's library — an ingress doesn't change who writes the content.
    assert.isTrue(integration.capabilities.canManageContent)
  })

  test('KIWIX_CONTENT_MODE=external: linked to, never written to', ({ assert }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.KIWIX, installed: true }),
      ctx({
        runtimeContext: 'kubernetes',
        envValue: (name) =>
          name === 'KIWIX_URL'
            ? 'http://kiwix:8080'
            : name === 'KIWIX_BROWSER_URL'
              ? 'https://someone-elses-kiwix.example.com'
              : undefined,
        availabilityFor: () => 'reachable',
        kiwixContentMode: 'external',
      })
    )
    assert.equal(integration.contentOwner, 'external')
    assert.isFalse(integration.capabilities.canManageContent)
    // Still reachable and still linkable — external means "not ours to write".
    assert.isTrue(integration.capabilities.canOpen)
    assert.equal(integration.availability, 'reachable')
  })

  test('a Kiwix absent from the deployment owns no content in either mode', ({ assert }) => {
    for (const mode of ['shared', 'external'] as const) {
      const integration = resolveIntegration(
        row({ service_name: SERVICE_NAMES.KIWIX, installed: true }),
        ctx({ runtimeContext: 'kubernetes', envValue: () => undefined, kiwixContentMode: mode })
      )
      assert.equal(integration.provisioner, 'none', mode)
      assert.equal(integration.contentOwner, 'none', mode)
      assert.isFalse(integration.capabilities.canManageContent, mode)
    }
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

/**
 * Explicit model-ownership answers (PR 3). Before this, ownership for a
 * bundled Kubernetes Ollama was a documented ASSUMPTION; the operator can now
 * state it, and the answer always wins over the defaults.
 */
test.group('ServiceIntegration model ownership', () => {
  test('an explicit hands-off answer disables model management on a bundled K8s Ollama', ({
    assert,
  }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.OLLAMA, installed: true }),
      ctx({
        runtimeContext: 'kubernetes',
        envValue: (name) => (name === 'LLM_HOST' ? 'http://shared-ollama:11434' : undefined),
        kvRemoteManagedByNomad: false,
      })
    )
    assert.equal(integration.modelOwner, 'external')
    assert.isFalse(integration.capabilities.canManageModels)
  })

  test('an explicit opt-in enables model management on a Docker-mode remote Ollama', ({
    assert,
  }) => {
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.OLLAMA, installed: true }),
      ctx({
        kvRemoteOllamaUrl: 'http://my-own-box:11434',
        kvRemoteManagedByNomad: true,
        dockerStatusFor: () => 'running',
      })
    )
    assert.equal(integration.modelOwner, 'nomad')
    assert.isTrue(integration.capabilities.canManageModels)
  })

  test('with no explicit answer the documented defaults still apply', ({ assert }) => {
    // Docker + Settings remote → conservatively external.
    const dockerRemote = resolveIntegration(
      row({ service_name: SERVICE_NAMES.OLLAMA, installed: true }),
      ctx({ kvRemoteOllamaUrl: 'http://box:11434', dockerStatusFor: () => 'running' })
    )
    assert.equal(dockerRemote.modelOwner, 'external')

    // K8s bundled component → assumed NOMAD-dedicated.
    const k8sBundled = resolveIntegration(
      row({ service_name: SERVICE_NAMES.OLLAMA, installed: true }),
      ctx({
        runtimeContext: 'kubernetes',
        envValue: (name) => (name === 'LLM_HOST' ? 'http://ollama:11434' : undefined),
      })
    )
    assert.equal(k8sBundled.modelOwner, 'nomad')
  })

  test('the ownership answer does not apply to a purely local managed container', ({ assert }) => {
    // No remote backend configured: the local container is ours regardless.
    const integration = resolveIntegration(
      row({ service_name: SERVICE_NAMES.OLLAMA, installed: true }),
      ctx({ kvRemoteManagedByNomad: false, dockerStatusFor: () => 'running' })
    )
    assert.equal(integration.modelOwner, 'nomad')
    assert.isTrue(integration.capabilities.canManageModels)
  })
})

test.group('Kiwix content mode parsing', () => {
  test('unset and unrecognised values mean shared — the topology NOMAD ships', ({ assert }) => {
    assert.equal(parseKiwixContentMode(undefined), 'shared')
    assert.equal(parseKiwixContentMode(null), 'shared')
    assert.equal(parseKiwixContentMode(''), 'shared')
    assert.equal(parseKiwixContentMode('nonsense'), 'shared')
  })

  test('external is recognised regardless of case or padding', ({ assert }) => {
    assert.equal(parseKiwixContentMode('external'), 'external')
    assert.equal(parseKiwixContentMode('  External '), 'external')
    assert.equal(parseKiwixContentMode('EXTERNAL'), 'external')
  })
})
