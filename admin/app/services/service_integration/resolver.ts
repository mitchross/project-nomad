import env from '#start/env'
import { DockerService } from '#services/docker_service'
import { SERVICE_NAMES } from '../../../constants/service_names.js'
import { K8S_SERVICE_URL_ENV_VARS } from '../../utils/k8s_service_env.js'
import {
  CAPABILITY_DENIED_MESSAGES,
  computeCapabilities,
  defaultContentOwner,
  defaultModelOwner,
} from './capability_rules.js'
import { getCachedAvailability } from './health_probes.js'
import type {
  Availability,
  RuntimeContext,
  ServiceCapabilities,
  ServiceEndpoints,
  ServiceIntegration,
  ServiceRowLike,
} from './types.js'

/**
 * Resolves per-service integration descriptors. Pure resolution lives in
 * `resolveIntegration(row, ctx)` (unit-testable with an injected context);
 * the static class methods gather the real context and are the entry points
 * for controllers and `SystemService.getServices()`.
 *
 * Descriptors are additive: `Service.installed` and the Kubernetes env sync
 * keep their existing meaning. Workload capabilities reproduce the runtime
 * guards exactly — allowed under Docker, refused under Kubernetes. Under
 * Docker the provisioner describes the LOCAL workload: a Settings-configured
 * remote Ollama moves the AI endpoint and model ownership, not who provisions
 * the container.
 */

/** Browser-facing ui_location env overrides in Kubernetes (see k8s sync). */
const K8S_BROWSER_URL_ENV: Partial<Record<string, string>> = {
  [SERVICE_NAMES.KOLIBRI_GEN2]: 'KOLIBRI_URL',
  [SERVICE_NAMES.CYBERCHEF]: 'CYBERCHEF_URL',
  [SERVICE_NAMES.FLATNOTES]: 'FLATNOTES_URL',
}

export interface ResolutionContext {
  runtimeContext: RuntimeContext
  /** Raw env lookup (process env in production; injected in tests). */
  envValue: (name: string) => string | undefined
  /** 'ollama' | 'openai' — from LLM_PROVIDER. */
  llmProviderType: 'ollama' | 'openai'
  /** Settings-configured remote Ollama URL (Docker appliance only). */
  kvRemoteOllamaUrl: string | null
  /**
   * Explicit operator answer to "may NOMAD manage models on this backend?"
   * null = never answered, so the documented defaults apply.
   */
  kvRemoteManagedByNomad: boolean | null
  /** Docker container status by service name ('running', 'exited', ...). */
  dockerStatusFor: (serviceName: string) => string | undefined
  /** Cached availability for an API endpoint (never probes inline). */
  availabilityFor: (serviceName: string, apiUrl: string) => Availability
}

function k8sApiUrlFor(serviceName: string, ctx: ResolutionContext): string | undefined {
  const envVars = K8S_SERVICE_URL_ENV_VARS[serviceName]
  if (!envVars) return undefined
  for (const name of envVars) {
    const value = ctx.envValue(name)
    if (value) return value
  }
  return undefined
}

export function resolveIntegration(
  row: ServiceRowLike,
  ctx: ResolutionContext
): ServiceIntegration {
  const isKubernetes = ctx.runtimeContext === 'kubernetes'
  const endpoints: ServiceEndpoints = {}

  let provisioner: ServiceIntegration['provisioner']
  let availability: Availability

  if (isKubernetes) {
    const apiUrl = k8sApiUrlFor(row.service_name, ctx)
    const browserEnv = K8S_BROWSER_URL_ENV[row.service_name]
    const browserUrl = browserEnv ? ctx.envValue(browserEnv) : undefined

    if (apiUrl) {
      provisioner = 'gitops'
      if (browserUrl) {
        // Browser-facing companion (Kolibri/CyberChef/FlatNotes): the URL is
        // for users' browsers — never probed from the server (may be
        // internet-external or LAN-only; SSRF/hang hazard).
        endpoints.browserUrl = browserUrl
        availability = 'configured'
      } else {
        endpoints.apiUrl = apiUrl
        availability = ctx.availabilityFor(row.service_name, apiUrl)
      }
      if (row.service_name === SERVICE_NAMES.KIWIX) {
        endpoints.managementUrl = '/settings/zim/remote-explorer'
      }
      if (row.service_name === SERVICE_NAMES.OLLAMA) {
        endpoints.browserUrl = '/chat'
      }
    } else {
      // Not part of this Kubernetes deployment (unmapped catalog app, custom
      // app, or a stale Docker-era row).
      provisioner = 'none'
      availability = 'disabled'
    }
  } else {
    // Docker appliance: every catalog/custom row is managed by NOMAD's Docker
    // runtime — that is what upstream ships and what stays allowed.
    provisioner = 'nomad-docker'
    const status = ctx.dockerStatusFor(row.service_name)
    availability = !row.installed
      ? 'disabled'
      : status === 'running'
        ? 'reachable'
        : status
          ? 'unhealthy'
          : 'unknown'

    if (row.service_name === SERVICE_NAMES.OLLAMA) {
      // AI endpoint precedence mirrors the provider: env host, then the
      // Settings remote URL, then the local container.
      const envHost = ctx.envValue('LLM_HOST') || ctx.envValue('OLLAMA_HOST')
      if (envHost) endpoints.apiUrl = envHost
      else if (ctx.kvRemoteOllamaUrl) endpoints.apiUrl = ctx.kvRemoteOllamaUrl
      endpoints.browserUrl = '/chat'
    }
    if (row.ui_location?.startsWith('/')) {
      endpoints.browserUrl = row.ui_location
    }
  }

  // Upstream semantic preserved: custom_url only overrides the launch link.
  if (row.custom_url) {
    endpoints.browserUrl = row.custom_url
  }

  // Resource ownership (AI models / Kiwix content).
  let modelOwner: ServiceIntegration['modelOwner']
  let contentOwner: ServiceIntegration['contentOwner']
  if (row.service_name === SERVICE_NAMES.OLLAMA) {
    const usesRemoteBackend = !!(
      ctx.kvRemoteOllamaUrl ||
      ctx.envValue('LLM_HOST') ||
      ctx.envValue('OLLAMA_HOST')
    )
    if (ctx.kvRemoteManagedByNomad !== null && usesRemoteBackend) {
      // The operator answered explicitly — that always wins over defaults.
      modelOwner = ctx.kvRemoteManagedByNomad ? 'nomad' : 'external'
    } else if (!isKubernetes && usesRemoteBackend) {
      // Unanswered Docker-mode remote: conservatively external (matches the
      // no-eviction rule) — a remote server may be shared.
      modelOwner = 'external'
    } else {
      modelOwner = defaultModelOwner({
        runtimeContext: ctx.runtimeContext,
        provisioner,
        llmProviderType: ctx.llmProviderType,
      })
    }
  }
  if (row.service_name === SERVICE_NAMES.KIWIX) {
    contentOwner = defaultContentOwner(provisioner)
  }

  const capabilities = computeCapabilities({
    runtimeContext: ctx.runtimeContext,
    provisioner,
    serviceName: row.service_name,
    modelOwner,
    contentOwner,
    hasBrowserUrl: !!endpoints.browserUrl || (!isKubernetes && !!row.ui_location),
  })

  return {
    serviceName: row.service_name,
    runtimeContext: ctx.runtimeContext,
    provisioner,
    ...(modelOwner ? { modelOwner } : {}),
    ...(contentOwner ? { contentOwner } : {}),
    availability,
    endpoints,
    capabilities,
  }
}

export class ServiceIntegrationResolver {
  static runtimeContext(): RuntimeContext {
    return DockerService.isKubernetesMode() ? 'kubernetes' : 'docker'
  }

  /**
   * Whether this runtime can provision NEW managed workloads at all (custom
   * app creation, install preflights). The per-service capabilities govern
   * operations on existing services.
   */
  static canProvisionWorkloads(): boolean {
    return this.runtimeContext() === 'docker'
  }

  /** Gather the live resolution context (one KV read; no probes inline). */
  static async buildContext(
    dockerStatuses: { service_name: string; status: string }[]
  ): Promise<ResolutionContext> {
    const runtimeContext = this.runtimeContext()
    let kvRemoteOllamaUrl: string | null = null
    let kvRemoteManagedByNomad: boolean | null = null
    try {
      const { default: KVStore } = await import('#models/kv_store')
      // The remote URL only participates in provider selection outside
      // Kubernetes (env config wins there), but the ownership answer applies
      // in both runtimes — a K8s operator can mark a shared backend hands-off.
      if (runtimeContext === 'docker') {
        kvRemoteOllamaUrl = await KVStore.getValue('ai.remoteOllamaUrl')
      }
      kvRemoteManagedByNomad = await KVStore.getValue('ai.remoteManagedByNomad')
    } catch {
      kvRemoteOllamaUrl = null
      kvRemoteManagedByNomad = null
    }
    const statusMap = new Map(dockerStatuses.map((s) => [s.service_name, s.status]))
    return {
      runtimeContext,
      envValue: (name) => process.env[name] || undefined,
      llmProviderType: env.get('LLM_PROVIDER') === 'openai' ? 'openai' : 'ollama',
      kvRemoteOllamaUrl,
      kvRemoteManagedByNomad,
      dockerStatusFor: (name) => statusMap.get(name),
      availabilityFor: (name, apiUrl) => getCachedAvailability(name, apiUrl),
    }
  }

  /** Resolve descriptors for a list of service rows (used by getServices). */
  static async resolveAll(
    rows: ServiceRowLike[],
    dockerStatuses: { service_name: string; status: string }[]
  ): Promise<Map<string, ServiceIntegration>> {
    const ctx = await this.buildContext(dockerStatuses)
    return new Map(rows.map((row) => [row.service_name, resolveIntegration(row, ctx)]))
  }

  /** Resolve one service by name (controllers). Null when no row exists. */
  static async resolve(serviceName: string): Promise<ServiceIntegration | null> {
    const { default: Service } = await import('#models/service')
    const row = await Service.query().where('service_name', serviceName).first()
    if (!row) return null
    const ctx = await this.buildContext([])
    return resolveIntegration(
      {
        service_name: row.service_name,
        installed: row.installed,
        is_custom: row.is_custom,
        is_deprecated: row.is_deprecated,
        ui_location: row.ui_location,
        custom_url: row.custom_url,
      },
      ctx
    )
  }

  /**
   * Server-side capability check for controllers. `allowed: false` comes with
   * a user-facing message; unknown services are refused.
   */
  static async assertCapability(
    serviceName: string,
    capability: keyof ServiceCapabilities
  ): Promise<{ allowed: boolean; message: string }> {
    const integration = await this.resolve(serviceName)
    if (!integration) {
      return { allowed: false, message: `Unknown service: ${serviceName}` }
    }
    if (!integration.capabilities[capability]) {
      return { allowed: false, message: CAPABILITY_DENIED_MESSAGES[capability] }
    }
    return { allowed: true, message: 'ok' }
  }
}
