import { SERVICE_NAMES } from '../../constants/service_names.js'

/**
 * Kubernetes-mode service discovery: which environment variable(s) announce
 * that a companion service is deployed for this NOMAD instance.
 *
 * Single source of truth consumed by BOTH DockerService.getServiceURL()
 * (endpoint resolution) and SystemService._syncServicesForKubernetes()
 * (service-catalog sync). These two previously carried independent copies of
 * this mapping, which is exactly how KOLIBRI_URL ended up pointed at the
 * deprecated legacy nomad_kolibri identifier in one of them.
 *
 * KOLIBRI_URL deliberately targets the current Gen 2 catalog entry
 * (nomad_kolibri_2) — the legacy nomad_kolibri row is deprecated, deleted on
 * fresh installs, and must not be resurrected by env discovery.
 */
export const K8S_SERVICE_URL_ENV_VARS: Record<string, string[]> = {
  [SERVICE_NAMES.OLLAMA]: ['LLM_HOST', 'OLLAMA_HOST'],
  [SERVICE_NAMES.QDRANT]: ['QDRANT_HOST'],
  [SERVICE_NAMES.KIWIX]: ['KIWIX_URL'],
  [SERVICE_NAMES.CYBERCHEF]: ['CYBERCHEF_URL'],
  [SERVICE_NAMES.FLATNOTES]: ['FLATNOTES_URL'],
  [SERVICE_NAMES.KOLIBRI_GEN2]: ['KOLIBRI_URL'],
}
