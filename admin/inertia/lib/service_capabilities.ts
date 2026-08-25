import type { ServiceSlim } from '../../types/services.js'
import type { ServiceCapabilities } from '../../app/services/service_integration/types.js'

/**
 * Frontend accessor for the server-resolved per-service capabilities
 * (ServiceIntegrationResolver). One place to read them so pages don't grow
 * their own `isKubernetesMode`-style conditionals.
 *
 * IMPORTANT: this is presentation only. The server enforces every capability
 * independently (system_controller.denyUnlessCapable) — React is never the
 * security boundary. Hiding an action here just stops users being offered
 * buttons that would be refused.
 *
 * Fallback: when a response predates descriptors (`integration` absent), all
 * capabilities read TRUE. That preserves the upstream Docker appliance
 * exactly and can only ever surface an action the server would then refuse —
 * never hide one that works.
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
 * True when NOMAD doesn't provision this service's workload — the cluster or
 * an external operator does. Used to phrase update/version information as a
 * notice ("managed by GitOps") instead of an actionable control.
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
