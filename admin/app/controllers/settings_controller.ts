import KVStore from '#models/kv_store'
import { BenchmarkService } from '#services/benchmark_service'
import { MapService } from '#services/map_service'
import { OllamaService } from '#services/ollama_service'
import { SystemService } from '#services/system_service'
import { getSettingSchema, updateSettingSchema, validateSettingValue } from '#validators/settings'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import env from '#start/env'
import { DockerService } from '#services/docker_service'
import { ServiceIntegrationResolver } from '#services/service_integration/resolver'
import { SERVICE_NAMES } from '../../constants/service_names.js'
import { resolveRemoteConfigLock } from '../services/llm/remote_ollama_config.js'

@inject()
export default class SettingsController {
  constructor(
    private systemService: SystemService,
    private mapService: MapService,
    private benchmarkService: BenchmarkService,
    private ollamaService: OllamaService
  ) {}

  async system({ inertia }: HttpContext) {
    const systemInfo = await this.systemService.getSystemInfo()
    return inertia.render('settings/system', {
      system: {
        info: systemInfo,
      },
    })
  }

  async apps({ inertia }: HttpContext) {
    const services = await this.systemService.getServices({ installedOnly: false })
    return inertia.render('settings/apps', {
      system: {
        services,
      },
    })
  }

  async legal({ inertia }: HttpContext) {
    return inertia.render('settings/legal')
  }

  async support({ inertia }: HttpContext) {
    return inertia.render('settings/support')
  }

  async maps({ inertia }: HttpContext) {
    const baseAssetsCheck = await this.mapService.ensureBaseAssets()
    const [regionFiles, worldBasemapExists] = await Promise.all([
      this.mapService.listRegions(),
      this.mapService.checkWorldBasemapExists(),
    ])
    return inertia.render('settings/maps', {
      maps: {
        baseAssetsExist: baseAssetsCheck,
        worldBasemapExists,
        regionFiles: regionFiles.files,
      },
    })
  }

  async models({ inertia }: HttpContext) {
    // Only fetch the Ollama model catalog if the provider supports model management
    // (i.e. Ollama). For OpenAI-compatible providers, model installation is external.
    // The provider getter throws on a misconfig (LLM_PROVIDER=openai without
    // LLM_HOST) — render the page degraded rather than 500ing settings.
    // Backend TECHNICAL capability (can this protocol manage models at all?)
    let supportsModelMgmt = false
    try {
      supportsModelMgmt = this.ollamaService.provider.supportsModelManagement()
    } catch {
      // treat as no model management
    }
    // NOMAD's AUTHORIZATION to mutate this backend's models (ownership), from
    // the service integration resolver. Both must hold: a shared/external
    // Ollama technically supports pulls but is not ours to modify.
    const aiIntegration = await ServiceIntegrationResolver.resolve(SERVICE_NAMES.OLLAMA)
    const canManageModels = supportsModelMgmt && (aiIntegration?.capabilities.canManageModels ?? true)
    const availableModels = canManageModels
      ? await this.ollamaService.getAvailableModels({
          sort: 'pulls',
          recommendedOnly: false,
          query: null,
          limit: 15,
        })
      : null
    const installedModels = await this.ollamaService.getModels().catch(() => [])
    const chatSuggestionsEnabled = await KVStore.getValue('chat.suggestionsEnabled')
    const aiAssistantCustomName = await KVStore.getValue('ai.assistantCustomName')
    const remoteOllamaUrl = await KVStore.getValue('ai.remoteOllamaUrl')
    // Protocol/ownership of the Settings-configured remote. Absent protocol on
    // an existing URL means a pre-selection install: those were always Ollama.
    const remoteProtocol = (await KVStore.getValue('ai.remoteProtocol')) || 'ollama'
    const remoteManagedByNomad = (await KVStore.getValue('ai.remoteManagedByNomad')) ?? false
    // Who owns AI backend selection — the Settings Remote Ollama flow is only
    // live for the Docker/Compose appliance; Kubernetes/BYO configure the
    // backend declaratively (env/Kustomize). Server-side enforcement lives in
    // OllamaController.configureRemote; this powers the matching UI state.
    const remoteOllamaLock = resolveRemoteConfigLock({
      kubernetesMode: DockerService.isKubernetesMode(),
      llmProvider: env.get('LLM_PROVIDER'),
      llmHost: env.get('LLM_HOST'),
      ollamaHost: env.get('OLLAMA_HOST'),
    })
    const ollamaFlashAttention = await KVStore.getValue('ai.ollamaFlashAttention')
    const autoThinking = await KVStore.getValue('ai.autoThinking')
    return inertia.render('settings/models', {
      models: {
        availableModels: availableModels?.models || [],
        installedModels: installedModels || [],
        settings: {
          chatSuggestionsEnabled: chatSuggestionsEnabled ?? false,
          aiAssistantCustomName: aiAssistantCustomName ?? '',
          remoteOllamaUrl: remoteOllamaUrl ?? '',
          remoteProtocol: remoteProtocol === 'openai' ? 'openai' : 'ollama',
          remoteManagedByNomad,
          remoteOllamaLock,
          canManageModels,
          ollamaFlashAttention: ollamaFlashAttention ?? true,
          autoThinking: autoThinking ?? false,
        },
      },
    })
  }

  async update({ inertia }: HttpContext) {
    const updateInfo = await this.systemService.checkLatestVersion()
    // Core and app workload updates require NOMAD's managed Docker runtime
    // (updater sidecar, image pull + container recreation). Where the cluster
    // owns workloads these are image-tag bumps in your deployment, so the
    // panels are informational only. Content updates are unaffected — NOMAD
    // owns that content in every runtime.
    const canUpdateWorkloads = ServiceIntegrationResolver.canProvisionWorkloads()
    return inertia.render('settings/update', {
      system: {
        updateAvailable: updateInfo.updateAvailable,
        latestVersion: updateInfo.latestVersion,
        currentVersion: updateInfo.currentVersion,
        canUpdateWorkloads,
      },
    })
  }

  async zim({ inertia }: HttpContext) {
    return inertia.render('settings/zim/index')
  }

  async zimRemote({ inertia }: HttpContext) {
    return inertia.render('settings/zim/remote-explorer')
  }

  async creatorPacks({ inertia }: HttpContext) {
    return inertia.render('settings/creator-packs')
  }

  async benchmark({ inertia }: HttpContext) {
    const latestResult = await this.benchmarkService.getLatestResult()
    const status = this.benchmarkService.getStatus()
    // System benchmarks shell out to sysbench in Docker — unavailable when the
    // cluster owns workloads. AI-only benchmarks still work against any backend.
    const canRunSystemBenchmark = ServiceIntegrationResolver.canProvisionWorkloads()
    return inertia.render('settings/benchmark', {
      benchmark: {
        latestResult,
        status: status.status,
        currentBenchmarkId: status.benchmarkId,
        canRunSystemBenchmark,
      },
    })
  }

  async advanced({ inertia }: HttpContext) {
    // When the env var is set it always takes precedence over the stored value,
    // so surface that to the UI to disable the field and explain the override.
    const envOverride = Boolean(env.get('INTERNET_STATUS_TEST_URL')?.trim())
    const internetStatusTestUrl = await KVStore.getValue('system.internetStatusTestUrl')
    return inertia.render('settings/advanced', {
      advanced: {
        internetStatusTestUrl: internetStatusTestUrl ?? '',
        internetStatusTestUrlEnvOverride: envOverride,
      },
    })
  }

  async getSetting({ request, response }: HttpContext) {
    const { key } = await getSettingSchema.validate({ key: request.qs().key });
    const value = await KVStore.getValue(key);
    return response.status(200).send({ key, value });
  }

  async updateSetting({ request, response }: HttpContext) {
    const reqData = await request.validateUsing(updateSettingSchema)
    const valueError = validateSettingValue(reqData.key, reqData.value)
    if (valueError) {
      return response.status(422).send({ success: false, message: valueError })
    }
    await this.systemService.updateSetting(reqData.key, reqData.value)
    return response.status(200).send({ success: true, message: 'Setting updated successfully' })
  }
}
