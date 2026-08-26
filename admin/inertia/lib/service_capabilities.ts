import type { ServiceSlim } from '../../types/services.js'
import type { ServiceCapabilities } from '../../app/services/service_integration/types.js'

/**
 * Frontend accessor for server-resolved capabilities, so pages don't grow their
 * own isKubernetesMode-style conditionals.
 *
 * Presentation only — the server enforces every capability independently in
 * denyUnlessCapable(); hiding an action here just stops offering a button that
 * would be refused. When `integration` is absent (a response predating
 * descriptors) every capability reads true, which preserves the upstream Docker
 * appliance and can only over-offer, never hide something that works.
 */
const ALL_ALLOWED: ServiceCapabilities = {
  canInstall: true,
  canUninstall: true,
  canStartStop: true,
  canRestart: true,
  canUpdateWorkload: true,
  canViewLogs: true,
  canViewStats: true,
  canManageModels: true,
  canManageContent: true,
  canOpen: true,
}

export function capabilitiesOf(service: Pick<ServiceSlim, 'integration'>): ServiceCapabilities {
  return service.integration?.capabilities ?? ALL_ALLOWED
}

export function can(
  service: Pick<ServiceSlim, 'integration'>,
  capability: keyof ServiceCapabilities
): boolean {
  return capabilitiesOf(service)[capability]
}

/**
 * True when the cluster or an external operator provisions this workload, so
 * version info is phrased as a notice rather than an actionable control.
 */
export function isExternallyProvisioned(service: Pick<ServiceSlim, 'integration'>): boolean {
  const provisioner = service.integration?.provisioner
  return provisioner === 'gitops' || provisioner === 'external'
}

/** True when NOMAD offers no workload management at all for this service. */
export function hasNoWorkloadControls(service: Pick<ServiceSlim, 'integration'>): boolean {
  const caps = capabilitiesOf(service)
  return (
    !caps.canStartStop &&
    !caps.canRestart &&
    !caps.canUninstall &&
    !caps.canUpdateWorkload &&
    !caps.canViewLogs &&
    !caps.canViewStats
  )
}

/** Short, user-facing explanation of who owns this service's lifecycle. */
export function provisionerNotice(service: Pick<ServiceSlim, 'integration'>): string | null {
  switch (service.integration?.provisioner) {
    case 'gitops':
      return 'Managed by your cluster (GitOps) — lifecycle and updates happen in your deployment, not here.'
    case 'external':
      return 'External service — NOMAD uses it but does not manage it.'
    default:
      return null
  }
}
