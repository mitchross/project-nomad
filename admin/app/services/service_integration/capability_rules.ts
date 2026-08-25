import { SERVICE_NAMES } from '../../../constants/service_names.js'
import type {
  ResourceOwner,
  RuntimeContext,
  ServiceCapabilities,
  ServiceIntegration,
  WorkloadProvisioner,
} from './types.js'

// Pure capability rules: (runtime, provisioner, service identity, owners) →
// what NOMAD may do. No I/O, fully table-testable.
//
// Workload capabilities reproduce the runtime guards exactly: allowed for every
// managed workload under Docker, refused under Kubernetes.

const NO_WORKLOAD_CAPS = {
  canInstall: false,
  canUninstall: false,
  canStartStop: false,
  canRestart: false,
  canUpdateWorkload: false,
  canViewLogs: false,
  canViewStats: false,
} as const

export function computeCapabilities(input: {
  runtimeContext: RuntimeContext
  provisioner: WorkloadProvisioner
  serviceName: string
  modelOwner?: ResourceOwner
  contentOwner?: ResourceOwner
  hasBrowserUrl: boolean
}): ServiceCapabilities {
  const dockerManaged =
    input.runtimeContext === 'docker' && input.provisioner === 'nomad-docker'

  const workloadCaps = dockerManaged
    ? {
        canInstall: true,
        canUninstall: true,
        canStartStop: true,
        canRestart: true,
        canUpdateWorkload: true,
        canViewLogs: true,
        canViewStats: true,
      }
    : NO_WORKLOAD_CAPS

  return {
    ...workloadCaps,
    // Model management follows model OWNERSHIP, not workload provisioning: a
    // GitOps-provisioned Ollama dedicated to NOMAD validly has NOMAD-owned
    // models while its pod lifecycle belongs to the cluster.
    canManageModels: input.serviceName === SERVICE_NAMES.OLLAMA && input.modelOwner === 'nomad',
    // Content management likewise: NOMAD owns the shared ZIM library even
    // when a GitOps Kiwix pod serves it.
    canManageContent:
      input.serviceName === SERVICE_NAMES.KIWIX && input.contentOwner === 'nomad',
    canOpen: input.hasBrowserUrl,
  }
}

/**
 * Default ownership when no explicit setting exists. A Docker-managed local
 * Ollama is NOMAD's; a Kubernetes Ollama on LLM_HOST/OLLAMA_HOST is assumed to
 * be the bundled NOMAD-dedicated deployment (a shared one needs the opt-out);
 * a Settings-configured remote is conservatively external, as is any
 * OpenAI-compatible provider, whose API can't manage models anyway.
 */
export function defaultModelOwner(input: {
  runtimeContext: RuntimeContext
  provisioner: WorkloadProvisioner
  llmProviderType: 'ollama' | 'openai'
}): ResourceOwner {
  if (input.llmProviderType === 'openai') return 'external'
  if (input.provisioner === 'nomad-docker') return 'nomad'
  if (input.runtimeContext === 'kubernetes' && input.provisioner === 'gitops') return 'nomad'
  return 'external'
}

/**
 * NOMAD owns the shared ZIM library and its XML in every supported topology
 * (Docker bind mount, or the shared-PVC Kubernetes component). An
 * endpoint-only external Kiwix would be 'external'; not yet supported.
 */
export function defaultContentOwner(provisioner: WorkloadProvisioner): ResourceOwner {
  return provisioner === 'none' ? 'none' : 'nomad'
}

/** Human messages for refusals, keyed by capability. */
export const CAPABILITY_DENIED_MESSAGES: Record<keyof ServiceCapabilities, string> = {
  canInstall: 'Service installation is managed by the deployment (not NOMAD) in this runtime.',
  canUninstall: 'Service removal is managed by the deployment (not NOMAD) in this runtime.',
  canStartStop: 'Service lifecycle is managed by the deployment (not NOMAD) in this runtime.',
  canRestart: 'Service lifecycle is managed by the deployment (not NOMAD) in this runtime.',
  canUpdateWorkload: 'Workload updates are managed by the deployment (not NOMAD) in this runtime.',
  canViewLogs: 'Logs are available through your cluster tooling, not NOMAD, in this runtime.',
  canViewStats: 'Stats are available through your cluster tooling, not NOMAD, in this runtime.',
  canManageModels: 'Model management is not available for this AI backend.',
  canManageContent: 'Content management is not available for this service.',
  canOpen: 'No browser URL is configured for this service.',
}

export function describeIntegration(integration: ServiceIntegration): string {
  return `${integration.serviceName}: provisioner=${integration.provisioner}, availability=${integration.availability}`
}
