
export const KV_STORE_SCHEMA = {
  'chat.suggestionsEnabled':    'boolean',
  'chat.lastModel':             'string',
  'rag.docsEmbedded':           'boolean',
  'rag.defaultIngestPolicy':    'string',
  'system.updateAvailable':     'boolean',
  'system.latestVersion':       'string',
  'system.earlyAccess':         'boolean',
  'system.internetStatusTestUrl': 'string',
  'autoUpdate.enabled':         'boolean',
  'autoUpdate.windowStart':     'string',
  'autoUpdate.windowEnd':       'string',
  'autoUpdate.cooloffHours':    'string',
  'autoUpdate.lastAttemptAt':   'string',
  'autoUpdate.lastError':       'string',
  'autoUpdate.lastResult':      'string',
  'autoUpdate.consecutiveFailures': 'string',
  'autoUpdate.autoDisabledReason':  'string',
  'appAutoUpdate.enabled':          'boolean',
  'appAutoUpdate.lastAttemptAt':    'string',
  'appAutoUpdate.lastResult':       'string',
  'contentAutoUpdate.enabled':           'boolean',
  'contentAutoUpdate.windowStart':       'string',
  'contentAutoUpdate.windowEnd':         'string',
  'contentAutoUpdate.cooloffHours':      'string',
  'contentAutoUpdate.maxBytesPerWindow': 'string',
  'contentAutoUpdate.lastAttemptAt':     'string',
  'contentAutoUpdate.lastResult':        'string',
  'contentAutoUpdate.lastError':         'string',
  'contentAutoUpdate.consecutiveFailures': 'string',
  'contentAutoUpdate.autoDisabledReason':  'string',
  'contentAutoUpdate.windowBytesUsed':   'string',
  'contentAutoUpdate.windowResetAt':     'string',
  'ui.hasVisitedEasySetup':     'boolean',
  'ui.theme':                   'string',
  // JSON map of Qdrant collection name → embedding identity fingerprint, so a
  // change of embedding model/endpoint/prefixes is detected before it silently
  // mixes incompatible vectors into an existing collection.
  'rag.embeddingFingerprints':  'string',
  'ai.assistantCustomName':     'string',
  'gpu.type':                   'string',
  // Legacy remote-backend URL. Since the protocol-aware settings landed it is
  // interpreted as "protocol: ollama" — kept as the storage for that case so
  // existing Docker installs need no migration and provider precedence is
  // unchanged (env → KV → managed container).
  'ai.remoteOllamaUrl':         'string',
  // Explicit backend protocol for the KV-configured remote: 'ollama' (native
  // /api/*) or 'openai' (OpenAI-compatible /v1/*, e.g. vLLM, llama.cpp,
  // LM Studio). Absent/empty means "no KV-configured remote".
  'ai.remoteProtocol':          'string',
  // API key for an OpenAI-compatible remote. Optional — most local servers
  // ignore it.
  'ai.remoteApiKey':            'string',
  // Whether NOMAD is AUTHORIZED to mutate models on the configured backend
  // (pull/delete, and the chat-path unload sweep). Defaults off for remote
  // backends: a shared server's models are not ours to change even when the
  // protocol technically allows it.
  'ai.remoteManagedByNomad':    'boolean',
  'ai.ollamaFlashAttention':    'boolean',
  'ai.autoThinking':            'boolean',
  'ai.amdGpuAcceleration':      'boolean',
  'ai.amdHsaOverride':          'string',
  'ai.autoFixGpuPassthrough':   'boolean',
  'gpu.autoRemediatedAt':       'string',
  'apps.homebox.apiKeyPepper':  'string',
  'benchmark.rerunBannerDismissed': 'boolean',
  // Drug Reference v1 — export_date of the last successfully completed
  // openFDA drug-label ingest (e.g. "2026-06-06"). Written by
  // IngestDrugDataJob on final-part completion; read by the search page's
  // status panel to show "Last updated: <date>". Null when never ingested.
  'drugReference.lastUpdatedExportDate': 'string',
  // Drug Reference — two-step ingest download-state marker (no migration; status
  // lives in job data + this KV key). Written by DownloadDrugDataJob after the
  // LAST part lands on disk; a JSON string of DownloadStateMarker
  // ({ export_date, totalParts, parts: [{ index, name, path, bytes }],
  // completedAtMs }). Read by IngestDrugDataJob to rebuild the part list for a
  // manual "Ingest into search" run (no manifest, no re-download) and by the
  // service to gate POST /ingest. Parsed defensively (parseDownloadState) with a
  // null fallback — the key simply doesn't exist before the first download.
  // Cleared after a full ingest succeeds (when the on-disk parts are deleted).
  'drugReference.downloadState': 'string',
  // Drug Reference — affirmative-content gate (upstream #1040). Independent of
  // the tier install: installing `medicine-standard` lights up the verbatim FDA
  // label search and condition→OTC matching, but the hand-authored self-care and
  // herbal REMEDY sections stay hidden until this flips true. Defaults off
  // (null → false); flipped on after a clinician content-pass, not user-toggled.
  'drugReference.remediesEnabled': 'boolean',
} as const

type KVTagToType<T extends string> = T extends 'boolean' ? boolean : string

export type KVStoreKey = keyof typeof KV_STORE_SCHEMA
export type KVStoreValue<K extends KVStoreKey> = KVTagToType<(typeof KV_STORE_SCHEMA)[K]>
