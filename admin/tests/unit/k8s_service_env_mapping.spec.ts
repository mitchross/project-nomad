import { test } from '@japa/runner'
import { K8S_SERVICE_URL_ENV_VARS } from '../../app/utils/k8s_service_env.js'
import { SERVICE_NAMES } from '../../constants/service_names.js'

/**
 * Regression coverage for the Kolibri Gen 2 mapping (Codex finding P1.6):
 * KOLIBRI_URL used to map to the deprecated legacy `nomad_kolibri` identifier,
 * so on a fresh Kubernetes database (where the unused legacy row is deleted by
 * migration) the env var marked nothing installed and the deployed Gen 2 pod
 * was invisible to the service catalog. On an upgraded database it resurrected
 * the deprecated row instead of the Gen 2 entry.
 *
 * The mapping is now a single shared constant consumed by both
 * DockerService.getServiceURL() and SystemService._syncServicesForKubernetes()
 * — these tests pin its invariants.
 */
test.group('K8s service env mapping', () => {
  test('KOLIBRI_URL maps to the Gen 2 service, not the deprecated legacy id', ({ assert }) => {
    assert.deepEqual(K8S_SERVICE_URL_ENV_VARS[SERVICE_NAMES.KOLIBRI_GEN2], ['KOLIBRI_URL'])

    // The legacy identifier must not participate in Kubernetes env discovery at
    // all — a fresh DB deletes the row, an upgraded DB deprecates it, and env
    // config must never resurrect it.
    assert.notProperty(K8S_SERVICE_URL_ENV_VARS, SERVICE_NAMES.KOLIBRI)
  })

  test('LLM discovery accepts LLM_HOST with OLLAMA_HOST as fallback', ({ assert }) => {
    assert.deepEqual(K8S_SERVICE_URL_ENV_VARS[SERVICE_NAMES.OLLAMA], ['LLM_HOST', 'OLLAMA_HOST'])
  })

  test('every mapped service uses a distinct env var set', ({ assert }) => {
    // Two services sharing an env var would make one service's deployment
    // mark another installed — the drift class this constant exists to stop.
    const seen = new Map<string, string>()
    for (const [service, envVars] of Object.entries(K8S_SERVICE_URL_ENV_VARS)) {
      for (const envVar of envVars) {
        assert.isFalse(
          seen.has(envVar),
          `${envVar} mapped to both ${seen.get(envVar)} and ${service}`
        )
        seen.set(envVar, service)
      }
    }
  })
})
