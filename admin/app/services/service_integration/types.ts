// Per-service integration descriptors: for one service in THIS deployment, who
// provisions the workload, who owns its models/content, whether it's reachable,
// and what NOMAD is allowed to do with it.
//
// Descriptors are computed from catalog/DB state, runtime context, env/KV config,
// container state and cached probes — never persisted. `Service.installed` keeps
// its upstream Docker-artifact meaning until every reader consumes descriptors.

/** Where the NOMAD admin itself is running. */
export type RuntimeContext = 'docker' | 'kubernetes'

/**
 * Who creates/updates/destroys the service's workload.
 * - 'nomad-docker': NOMAD's managed Docker appliance owns the container.
 * - 'gitops': the cluster owns it (Kustomize/Argo/Flux); NOMAD only consumes
 *   its endpoint.
 * - 'external': known only by URL (remote Ollama box, BYO server).
 * - 'none': not deployed or configured in this runtime.
 */
export type WorkloadProvisioner = 'nomad-docker' | 'gitops' | 'external' | 'none'

/** Who owns a resource plane (models on an AI backend, content in Kiwix). */
export type ResourceOwner = 'nomad' | 'external' | 'none'

/**
 * Observed availability — never derived from configuration alone.
 * - 'disabled': not configured/installed in this runtime.
 * - 'configured': configuration exists, no probe result yet.
 * - 'reachable' / 'unhealthy': a probe or container state said so.
 * - 'unknown': no probe applies to this integration.
 */
export type Availability = 'disabled' | 'configured' | 'reachable' | 'unhealthy' | 'unknown'

export interface ServiceEndpoints {
  /** Server-to-server API endpoint. Never rendered as a browser href. */
  apiUrl?: string
  /** User/browser-reachable URL (ingress hostname, LAN port). */
  browserUrl?: string
  /** NOMAD's own management page for this service (e.g. Content Manager). */
  managementUrl?: string
}

// Workload capabilities are enforced server-side in the system controller;
// model/content capabilities are enforced by the provider layer.
export interface ServiceCapabilities {
  canInstall: boolean
  canUninstall: boolean
  canStartStop: boolean
  canRestart: boolean
  canUpdateWorkload: boolean
  canViewLogs: boolean
  canViewStats: boolean
  canManageModels: boolean
  canManageContent: boolean
  canOpen: boolean
}

export interface ServiceIntegration {
  serviceName: string
  runtimeContext: RuntimeContext
  provisioner: WorkloadProvisioner
  /** Only meaningful for AI backends. */
  modelOwner?: ResourceOwner
  /** Only meaningful for content-serving services (Kiwix). */
  contentOwner?: ResourceOwner
  availability: Availability
  endpoints: ServiceEndpoints
  capabilities: ServiceCapabilities
}

/** The row fields resolution needs — a subset of Service/ServiceSlim. */
export interface ServiceRowLike {
  service_name: string
  installed: boolean
  is_custom: boolean
  is_deprecated: boolean
  ui_location: string | null
  custom_url: string | null
}
