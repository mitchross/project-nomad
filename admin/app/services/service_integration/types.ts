/**
 * Per-service integration descriptors (PR 1 of the Kubernetes/BYO sequence —
 * see docs/CODEX_K8S_BYO_ARCHITECTURE_REVIEW.md §6).
 *
 * A descriptor answers, for one service in THIS deployment:
 *   who provisions the workload? · who owns its models/content? · is it
 *   configured/reachable? · which endpoints exist? · what is NOMAD allowed
 *   to do with it?
 *
 * Descriptors are COMPUTED — resolved from catalog/DB state, runtime context,
 * env/KV configuration, Docker container state, and cached health probes.
 * Nothing here is persisted; `Service.installed` keeps its upstream
 * Docker-artifact meaning as a compatibility shim until every server-side
 * reader consumes descriptors instead.
 */

/** Where the NOMAD admin itself is running. */
export type RuntimeContext = 'docker' | 'kubernetes'

/**
 * Who provisions (creates/updates/destroys) the service's workload.
 * - 'nomad-docker': NOMAD's managed Docker appliance owns the container.
 * - 'gitops': the Kubernetes cluster owns the workload (deployed via
 *   Kustomize/Argo/Flux); NOMAD only consumes its endpoint.
 * - 'external': a workload NOMAD knows only by URL (remote Ollama box, BYO
 *   server); nobody in this deployment provisions it on NOMAD's behalf.
 * - 'none': not deployed/configured at all in this runtime.
 */
export type WorkloadProvisioner = 'nomad-docker' | 'gitops' | 'external' | 'none'

/** Who owns a resource plane (models on an AI backend, content in Kiwix). */
export type ResourceOwner = 'nomad' | 'external' | 'none'

/**
 * Observed availability. NEVER derived from configuration alone:
 * - 'disabled': not configured/installed in this runtime.
 * - 'configured': configuration exists; no probe result (yet).
 * - 'reachable' / 'unhealthy': a probe or container state said so.
 * - 'unknown': no probe is applicable/possible for this integration.
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

/**
 * What NOMAD may do with this service. Workload capabilities are ENFORCED
 * server-side (system controller); model/content capabilities are descriptive
 * in PR 1 — their enforcement lands with the provider-ownership work (PR 3)
 * and Supply Depot UI (PR 2). Keep this list minimal: add a capability only
 * when a consumer exists.
 */
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
