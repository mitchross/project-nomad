import { SERVICE_NAMES } from '../../../constants/service_names.js'
import type {
  ResourceOwner,
  RuntimeContext,
  ServiceCapabilities,
  ServiceIntegration,
  WorkloadProvisioner,
} from './types.js'

/**
 * Pure capability rules: (runtime, provisioner, service identity, owners) →
 * what NOMAD may do. No I/O — fully table-testable.
 *
 * PR 1 behavior-parity contract: the ENFORCED workload capabilities must
 * reproduce today's guard outcomes exactly — in the Docker runtime every
 * managed workload operation is allowed (as upstream ships), and on
 * Kubernetes they are all refused (as the PR 0 runtime guards did). The
 * model/content fields are descriptive target semantics consumed by later
 * PRs; they change no behavior here.
 */

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
 * Default resource-ownership rules, until an explicit ownership setting
 * exists (PR 3). Documented assumptions:
 *
 * - Docker-managed local Ollama: NOMAD owns the models (upstream appliance).
 * - Kubernetes Ollama via LLM_HOST/OLLAMA_HOST with the ollama provider: the
 *   bundled, NOMAD-dedicated deployment (the Kustomize component) is assumed
 *   — models are NOMAD-owned, matching today's working model management.
 *   A SHARED external Ollama on Kubernetes needs the PR 3 opt-out.
 * - Docker-mode Settings-configured remote Ollama: conservatively external —
 *   consistent with the PR 0 rule that already stops model eviction there.
 * - OpenAI-compatible providers (vLLM etc.): external; the API cannot manage
 *   models anyway.
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
 * Kiwix content ownership: NOMAD owns the shared ZIM library and its XML in
 * every currently supported topology (Docker bind mount or the shared-PVC
 * Kubernetes component). An endpoint-only external Kiwix — where this becomes
 * 'external' — is a PR 5 concern.
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
