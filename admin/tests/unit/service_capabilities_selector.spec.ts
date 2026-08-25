import { test } from '@japa/runner'
import {
  can,
  capabilitiesOf,
  hasNoWorkloadControls,
  isExternallyProvisioned,
  provisionerNotice,
} from '../../inertia/lib/service_capabilities.js'
import type { ServiceIntegration } from '../../app/services/service_integration/types.js'

/**
 * The frontend capability selector. Pages read actions through this so they
 * never grow their own runtime conditionals — and so the fallback rule (no
 * descriptor ⇒ permissive) is asserted in exactly one place.
 */

function integration(overrides: Partial<ServiceIntegration> = {}): ServiceIntegration {
  return {
    serviceName: 'nomad_kiwix_server',
    runtimeContext: 'kubernetes',
    provisioner: 'gitops',
    availability: 'reachable',
    endpoints: {},
    capabilities: {
      canInstall: false,
      canUninstall: false,
      canStartStop: false,
      canRestart: false,
      canUpdateWorkload: false,
      canViewLogs: false,
      canViewStats: false,
      canManageModels: false,
      canManageContent: true,
      canOpen: true,
    },
    ...overrides,
  }
}

test.group('frontend service capability selector', () => {
  test('missing descriptor falls back to permissive (upstream Docker behavior)', ({ assert }) => {
    const caps = capabilitiesOf({})
    for (const value of Object.values(caps)) assert.isTrue(value)
    assert.isTrue(can({}, 'canUninstall'))
  })

  test('descriptor capabilities are read verbatim', ({ assert }) => {
    const service = { integration: integration() }
    assert.isFalse(can(service, 'canStartStop'))
    assert.isFalse(can(service, 'canViewLogs'))
    assert.isTrue(can(service, 'canManageContent'))
    assert.isTrue(can(service, 'canOpen'))
  })

  test('GitOps/external services are flagged as externally provisioned', ({ assert }) => {
    assert.isTrue(isExternallyProvisioned({ integration: integration({ provisioner: 'gitops' }) }))
    assert.isTrue(isExternallyProvisioned({ integration: integration({ provisioner: 'external' }) }))
    assert.isFalse(
      isExternallyProvisioned({ integration: integration({ provisioner: 'nomad-docker' }) })
    )
    // No descriptor: treated as the Docker appliance, not external.
    assert.isFalse(isExternallyProvisioned({}))
  })

  test('hasNoWorkloadControls detects a fully hands-off service', ({ assert }) => {
    assert.isTrue(hasNoWorkloadControls({ integration: integration() }))
    assert.isFalse(
      hasNoWorkloadControls({
        integration: integration({
          capabilities: { ...integration().capabilities, canViewLogs: true },
        }),
      })
    )
    assert.isFalse(hasNoWorkloadControls({}))
  })

  test('provisioner notices explain ownership, and are absent for managed services', ({ assert }) => {
    assert.match(
      provisionerNotice({ integration: integration({ provisioner: 'gitops' }) }) ?? '',
      /cluster/i
    )
    assert.match(
      provisionerNotice({ integration: integration({ provisioner: 'external' }) }) ?? '',
      /external/i
    )
    assert.isNull(provisionerNotice({ integration: integration({ provisioner: 'nomad-docker' }) }))
    assert.isNull(provisionerNotice({}))
  })
})
