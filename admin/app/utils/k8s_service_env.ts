import { SERVICE_NAMES } from '../../constants/service_names.js'

// Env vars announcing a companion service in Kubernetes mode. Shared by
// DockerService.getServiceURL() and SystemService._syncServicesForKubernetes()
// so the two can't drift. KOLIBRI_URL maps to Gen 2 — the legacy
// nomad_kolibri row is deprecated and must not be resurrected here.
export const K8S_SERVICE_URL_ENV_VARS: Record<string, string[]> = {
  [SERVICE_NAMES.OLLAMA]: ['LLM_HOST', 'OLLAMA_HOST'],
  [SERVICE_NAMES.QDRANT]: ['QDRANT_HOST'],
  [SERVICE_NAMES.KIWIX]: ['KIWIX_URL'],
  [SERVICE_NAMES.CYBERCHEF]: ['CYBERCHEF_URL'],
  [SERVICE_NAMES.FLATNOTES]: ['FLATNOTES_URL'],
  [SERVICE_NAMES.KOLIBRI_GEN2]: ['KOLIBRI_URL'],
}
