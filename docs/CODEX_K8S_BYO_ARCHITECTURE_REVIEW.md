# Project NOMAD Kubernetes + BYO Architecture Review

Date: 2026-08-24  
Reviewed fork: `mitchross/project-nomad`, `main` at `92ef553`  
Compared with: `Crosstalk-Solutions/project-nomad`, `main` at `0bd1c6f`

## Scope and method

This is a static, code-level review of the fork. It traces controllers, services, jobs,
models, React pages, boot providers, environment parsing, Kustomize manifests, and the
remaining direct Docker call paths. README and manifest comments were treated as claims to
verify, not evidence.

The review made no application code changes. The only created file is this report.
`kubectl kustomize deploy/k8s` rendered successfully (684 lines). Application typecheck and
tests could not run because this checkout has no installed `admin/node_modules`: TypeScript
reported missing packages and `node ace test` stopped at missing `ts-node-maintained`. That is
an environment limitation, not a test result.

Static analysis can establish endpoint selection and authorization behavior, but not network,
storage-class, ingress-controller, or third-party API behavior. Required runtime experiments
are listed where those facts matter.

---

## 1. Executive verdict

### Current state: **C**

The fork has the beginnings of a good data plane but not yet a clean service control plane.

- Chat, embeddings, and Qdrant can already use environment-provided endpoints without a
  Docker socket. The `LLMProvider` split is directionally correct, and the bundled Kubernetes
  Ollama + Qdrant path is close to usable.
- The Kubernetes manifests correctly avoid a service-account token and broad RBAC. The
  bundled Kiwix component preserves the important shared-ZIM-storage contract.
- However, service state is still represented as Docker-shaped `installed` state. Kubernetes
  synchronization equates “an environment variable exists” with “installed and running,” and
  neither ownership nor allowed operations exists in the model returned to the UI
  (`admin/app/models/service.ts:38-66`,
  `admin/app/services/system_service.ts:1023-1089`).
- Global `isKubernetesMode()` guards protect only some endpoints. The actual Supply Depot page,
  Easy Setup, custom-app operations, logs/stats, scheduled app updates, and three boot providers
  still expose or execute Docker paths (`admin/start/routes.ts:138-146`,
  `admin/inertia/pages/supply-depot.tsx:1013-1122`,
  `admin/inertia/pages/easy-setup/index.tsx:405-439`,
  `admin/app/controllers/system_controller.ts:317-607`).
- BYO Kiwix is only a configuration illusion, generic OpenAI-compatible remote setup is wired
  to an Ollama client, Kolibri's Kubernetes component is associated with a deprecated service
  identifier, and the Qdrant collection has no embedding-configuration identity.

In practical terms: **Compose remains the only coherent full appliance path. Kubernetes can
run the core and selected data-plane integrations, but the management UI and persisted service
state do not faithfully describe who owns what or what is actually healthy. BYO support is
strongest for Qdrant and OpenAI-compatible chat/embeddings, partial for remote Ollama, link-only
for three companions, and absent for endpoint-only Kiwix.**

### Potential state: **A-**

The fork can reach a clean architecture without an operator, CRDs, Kubernetes credentials, or
a rewrite of DockerService. The smallest durable design is:

1. resolve a per-service integration descriptor from database state plus deployment config;
2. separate workload provisioning ownership from model/content ownership;
3. expose explicit endpoints, observed availability, and capabilities to every controller and
   UI;
4. retain DockerService as the managed-Docker executor;
5. make provider/model and Kiwix content contracts honest; and
6. fingerprint embedding collections before writing or searching them.

This preserves upstream's Docker workflows and keeps Kubernetes/GitOps outside the application.

---

## 2. What is already good

### 2.1 The provider boundary is conceptually sound

`LLMProvider` covers the genuinely common operations—chat, streaming, embeddings, and model
listing—and advertises model-management and native-benchmark support
(`admin/app/services/llm/llm_provider.ts:63-127`). `OllamaService` is a compatibility facade,
which limits changes to upstream callers while provider-specific behavior moves behind it
(`admin/app/services/ollama_service.ts:23-43`). Preserve that migration strategy.

`OllamaProvider` contains Ollama-native chat, stream cancellation, embedding options, model
listing, pull/delete, thinking, process placement, and unload behavior rather than spreading
them across controllers (`admin/app/services/llm/ollama_provider.ts:32-168`).
`OpenAIProvider` implements `/chat/completions`, streaming normalization, reasoning extraction,
request cancellation, `/embeddings`, and `/models` without importing Docker
(`admin/app/services/llm/openai_provider.ts:23-120`,
`admin/app/services/llm/openai_provider.ts:225-285`).

Cancellation is traced end-to-end: the HTTP controller aborts when the client closes
(`admin/app/controllers/ollama_controller.ts:187-215`), the Ollama iterator calls `abort()`
(`admin/app/services/llm/ollama_provider.ts:88-130`), and OpenAI fetches receive the signal
(`admin/app/services/llm/openai_provider.ts:52-64`,
`admin/app/services/llm/openai_provider.ts:102-114`).

### 2.2 RAG endpoint selection is mostly deployment-neutral

`RagService` prefers `QDRANT_HOST` and otherwise falls back to Docker discovery
(`admin/app/services/rag_service.ts:80-100`). A real Qdrant health probe exists
(`admin/app/services/rag_service.ts:103-117`). Embedding selection distinguishes a dedicated
`EMBEDDING_HOST`, a non-managing OpenAI-compatible provider, and Ollama's verify/auto-pull path
(`admin/app/services/rag_service.ts:309-375`).

The embedding job understands that an environment-provided backend does not need a local
container, and Qdrant resolution matches `RagService`
(`admin/app/jobs/embed_file_job.ts:80-123`). Retry behavior is bounded at 30 attempts with a
one-minute fixed delay, and known permanent context-length failures become unrecoverable
(`admin/app/jobs/embed_file_job.ts:302-345`,
`admin/app/jobs/embed_file_job.ts:380-410`).

### 2.3 The Kiwix shared-storage design preserves Compose semantics

NOMAD owns ZIM files and the library XML at `/storage/zim`
(`admin/app/utils/fs.ts:7-8`). `KiwixLibraryService` reads metadata from local ZIMs and performs
atomic XML replacement (`admin/app/services/kiwix_library_service.ts:31-155`), can rebuild from
disk (`admin/app/services/kiwix_library_service.ts:224-289`), and adds/removes library entries
(`admin/app/services/kiwix_library_service.ts:291-363`). Downloads rebuild the XML
(`admin/app/services/zim_service.ts:350-367`), local uploads rescan it
(`admin/app/services/zim_service.ts:507-529`), and deletion removes both the file and XML entry
(`admin/app/services/zim_service.ts:646-680`).

The Kubernetes Kiwix pod mounts `nomad-storage`'s `zim` subpath at `/data` and runs
`kiwix-serve --library /data/kiwix-library.xml --monitorLibrary`
(`deploy/k8s/components/kiwix/deployment.yaml:19-55`), while admin mounts the same PVC at
`/app/storage` (`deploy/k8s/base/admin/deployment.yaml:34-56`). That is the right minimal way to
preserve the existing content workflow.

### 2.4 Kubernetes is deliberately credential-free

Admin, MySQL, Redis, and every optional component set
`automountServiceAccountToken: false`; for example admin does so at
`deploy/k8s/base/admin/deployment.yaml:19-25` and Kiwix at
`deploy/k8s/components/kiwix/deployment.yaml:18-20`. There are no Roles, ClusterRoles, bindings,
CRDs, or dynamic workload-creation paths. Nothing found in the application requires adding
them.

### 2.5 App-private storage is already separated

MySQL, Redis, Qdrant, Ollama, Kolibri, and FlatNotes each receive their own PVCs rather than
subpaths of NOMAD content storage (`deploy/k8s/base/mysql/deployment.yaml:41-56`,
`deploy/k8s/base/redis/deployment.yaml:26-41`,
`deploy/k8s/components/qdrant/deployment.yaml:32-42`,
`deploy/k8s/components/ollama/deployment.yaml:27-37`,
`deploy/k8s/components/kolibri/deployment.yaml:34-44`,
`deploy/k8s/components/flatnotes/deployment.yaml:32-42`). Only Kiwix shares NOMAD-owned content,
which matches its actual integration.

---

## 3. Findings

No P0 issue was established by static analysis. In particular, the unguarded Kubernetes Docker
paths usually fail against `/dev/null` and are caught; they are broken and operationally unsafe,
but I did not find a demonstrated data-loss or privilege-escalation path.

### P1 — architecture blockers

#### P1.1 — There is no per-service ownership/capability model, and the remaining global guard is incomplete

**Files/functions:**

- `DockerService.isKubernetesMode()` and constructor,
  `admin/app/services/docker_service.ts:49-78`
- `Service`, `admin/app/models/service.ts:38-127`
- `SystemController`, `admin/app/controllers/system_controller.ts:59-105`,
  `admin/app/controllers/system_controller.ts:317-607`
- Supply Depot actions, `admin/inertia/pages/supply-depot.tsx:1013-1122`
- Easy Setup dispatch, `admin/inertia/pages/easy-setup/index.tsx:405-439`

**Behavior:** Runtime is inferred solely from `KUBERNETES_SERVICE_HOST`. In that runtime,
DockerService creates a dummy Docker client at `/dev/null` and assumes every Docker call is
guarded. Only install, start/stop/restart, force-reinstall, and curated update endpoints have
server guards. Preflight, custom app create/edit/delete/update, curated uninstall, service logs,
and service stats do not. Supply Depot renders all of those actions. Easy Setup still configures
the UI remote backend and dispatches all selected service installs.

The older Settings Apps page does globally hide lifecycle operations
(`admin/inertia/pages/settings/apps.tsx:216-264`), but `/settings/apps` redirects to Supply Depot
(`admin/start/routes.ts:138-146`), so that protection is not on the active app-management path.

**Why it matters:** A Kubernetes deployment currently exposes buttons that fail, return 501, or
touch the dummy Docker client. More importantly, a global runtime check cannot express valid
mixed cases: Docker NOMAD + external Ollama, K8s NOMAD + GitOps Ollama whose models NOMAD may
manage, or external Kiwix with shared NOMAD content.

**Recommendation:** Introduce one integration resolver used server-side before every operation.
Return its capabilities with service data, and render the same capabilities in Supply Depot,
Easy Setup, Settings, Home, models, benchmark, and update pages. Do not make React the security or
correctness boundary. Keep the existing Docker methods as the executor when a capability resolves
true.

#### P1.2 — Kubernetes service synchronization destroys the distinctions among configured, reachable, installed, and running

**Files/functions:** `SystemService.getServices()` and `_syncServicesForKubernetes()`,
`admin/app/services/system_service.ts:324-393`,
`admin/app/services/system_service.ts:1018-1095`; `DockerService.getServicesStatus()`,
`admin/app/services/docker_service.ts:184-199`.

**Behavior:** An environment variable makes the corresponding database row `installed=true` and
the returned status `running`. Removing the environment variable reverses `installed` on the next
`getServices()` call, so the flag is not permanently stale; however, the prior browser URL is not
restored, configuration changes require a pod restart, and no reachability probe occurs. The
DockerService status fallback independently reports every installed row as running.

**Why it matters:** A typo, unready pod, failed external server, expired credential, or
cluster-internal URL exposed as a browser URL all look healthy. Home renders any installed service
with a URL (`admin/inertia/pages/home.tsx:135-159`), so false state becomes a navigation tile.
Supply Depot also uses that false state to enable management operations. Persisted `installed`
oscillates based on deployment config rather than an installed artifact.

**Recommendation:** Stop mutating `Service.installed` for configured external/GitOps integrations.
Treat the current field as managed-Docker artifact state during the first refactor. Resolve and
return separate `configuration`, `observedAvailability`, `endpoints`, and `capabilities`. Probe
service-specific health with short timeouts and cache results; use `unknown` when a probe is not
available. Never define configured as running.

#### P1.3 — The UI-configured “OpenAI-compatible” remote path validates one protocol and executes another

**Files/functions:** `OllamaController.configureRemote()`,
`admin/app/controllers/ollama_controller.ts:271-347`; `provider_factory`,
`admin/app/services/llm/provider_factory.ts:19-52`; `OllamaProvider._initialize()`,
`admin/app/services/llm/ollama_provider.ts:32-56`; model settings copy,
`admin/inertia/pages/settings/models.tsx:407-450`.

**Behavior:** Settings promises support for any OpenAI-compatible server and tests
`<url>/v1/models`. It then saves only `ai.remoteOllamaUrl`; it does not select the OpenAI provider.
With the default `LLM_PROVIDER=ollama`, Docker discovery returns that URL and `OllamaProvider`
uses the Ollama SDK and `/api/*` semantics. Thus LM Studio, vLLM, or llama.cpp can pass Save & Test
and fail on chat/model calls.

The factory and facade also cache the provider/client. `resetLLMProvider()` exists but has no
caller (`admin/app/services/llm/provider_factory.ts:50-52`). Saving or clearing a remote URL after
the provider initializes can leave the old endpoint active until process restart.

The controller additionally stops a local Docker Ollama and auto-installs Docker Qdrant
(`admin/app/controllers/ollama_controller.ts:329-339`), which is an appliance workflow embedded
inside generic endpoint configuration and is reachable in Kubernetes.

**Why it matters:** This is a concrete false-success configuration bug and prevents a clean BYO
provider story.

**Recommendation:** Either narrow this UI to “remote Ollama” and validate `/api/tags`, or add an
explicit provider selector, API base, credential, and ownership fields and instantiate the matching
provider. Make reconfiguration atomically replace/reset provider state, or document env config as
restart-required and remove runtime mutation. Move the optional “install Qdrant/stop local
Ollama” workflow behind Docker-appliance capabilities.

#### P1.4 — Qdrant collections have no embedding identity, so model/dimension changes fail or silently mix vector spaces

**Files/functions:** RAG constants and `_ensureCollection()`,
`admin/app/services/rag_service.ts:53-73`,
`admin/app/services/rag_service.ts:126-169`; ingestion and retrieval,
`admin/app/services/rag_service.ts:377-510`,
`admin/app/services/rag_service.ts:897-963`.

**Behavior:** A missing collection is created with `EMBEDDING_DIMENSIONS`; an existing collection
is accepted without inspecting its vector size or stored metadata. The service memoizes that check.
Documents and queries use the currently configured model and prefixes. Returned embedding count
and vector dimension are not validated before `embeddings[index]` is put into Qdrant.

**Why it matters:** Changing dimensions produces Qdrant upsert/search errors. Changing model or
document/query prefixes at the same dimension silently combines incompatible vectors in
`nomad_knowledge_base`, corrupting retrieval quality without an obvious error. This affects every
deployment case, but BYO makes changes much more likely.

**Recommendation:** Compute an embedding fingerprint from provider kind, normalized endpoint
identity (not credentials), model, dimension, document prefix, and query prefix. Persist it in
collection metadata or a NOMAD metadata row, verify Qdrant's actual vector size, and refuse writes
and searches on mismatch with a migration/reindex action. Validate response count and every vector
dimension before upsert/search. Prefer versioned collection aliases for later migrations; do not
automatically delete the old collection.

#### P1.5 — `KIWIX_URL` is not a BYO Kiwix integration

**Files/functions:** environment declaration, `admin/start/env.ts:90-99`; Kubernetes sync,
`admin/app/services/system_service.ts:1029-1038`; URL resolution,
`admin/app/services/docker_service.ts:259-278`; local library and ZIM management,
`admin/app/services/kiwix_library_service.ts:31-38`,
`admin/app/services/zim_service.ts:350-367`.

**Behavior:** No application code calls the Kiwix endpoint. `KIWIX_URL` only marks a service row
installed, participates in URL lookup, and is overwritten as a Home link to NOMAD's Content
Explorer. The Content Explorer browses download catalogs/custom HTTP directories and local file
state (`admin/inertia/pages/settings/zim/remote-explorer.tsx:45-85`,
`admin/inertia/pages/settings/zim/remote-explorer.tsx:867-940`); it is not a proxy or client for an
existing Kiwix server.

The Kubernetes comment claiming “the admin talks to Kiwix's API directly” is false
(`deploy/k8s/components/kiwix/admin-env-patch.yaml:10-14`), as is the README claim that admin
proxies Kiwix content (`deploy/k8s/README.md:54-65`).

**Why it matters:** With only `KIWIX_URL=http://existing-kiwix:8080`:

- NOMAD cannot discover the server's ZIMs;
- NOMAD cannot search or browse that server through its Content Explorer;
- a NOMAD download is written to NOMAD's local `/storage/zim` and is invisible to the server;
- NOMAD assumes it can write a local `kiwix-library.xml`;
- RAG can ingest only a ZIM file locally readable by admin, not endpoint-only content; and
- even the configured endpoint is not offered as the Kiwix browser link.

It works as a full integration only when the external operator deliberately mounts the same
NOMAD ZIM storage, consumes NOMAD's XML at `/data/kiwix-library.xml`, and runs compatible library
monitoring. That is the bundled component contract, not an endpoint contract.

**Recommendation:** Define two honest integrations: (1) `sharedNomadLibrary`, where NOMAD owns
ZIM files/XML and the Kiwix workload—Docker or GitOps—serves the shared storage; and (2)
`externalEndpoint`, which initially supports only `canOpen`/health and no NOMAD content management
or RAG. Add remote discovery/import only if a specific Kiwix API and data-transfer contract is
implemented later.

#### P1.6 — The bundled Kubernetes Kolibri component is invisible to the service model

**Files/functions:** service names, `admin/constants/service_names.ts:1-8`; Gen 2 seed,
`admin/database/seeders/service_seeder.ts:166-205`; legacy deprecation migration,
`admin/database/migrations/1776300000001_deprecate_legacy_kolibri.ts:14-33`; Kubernetes sync,
`admin/app/services/system_service.ts:1029-1038`; Kolibri env patch,
`deploy/k8s/components/kolibri/admin-env-patch.yaml:10-15`.

**Behavior:** The manifest deploys `learningequality/kolibri:0.19.4`, matching the Gen 2 catalog
entry `nomad_kolibri_2`, but `KOLIBRI_URL` maps only to legacy `nomad_kolibri`. Fresh databases have
the unused legacy row deleted; installed legacy rows are deprecated. The Gen 2 row is never marked
configured/installed.

**Why it matters:** Enabling the Kustomize component does not reliably create a Kolibri Home or
Supply Depot integration even though the pod may be healthy.

**Recommendation:** Map `KOLIBRI_URL` to `KOLIBRI_GEN2`. Add a migration/compatibility rule only
for an actually installed legacy Docker container. Test both fresh and upgraded databases.

### P2 — significant correctness and UX issues

#### P2.1 — Provider technical capabilities are confused with NOMAD's authorization to manage an external backend

`supportsModelManagement()` is true for every Ollama endpoint
(`admin/app/services/llm/ollama_provider.ts:164-169`). Therefore a remote Ollama is treated like a
NOMAD-managed appliance: model pull/delete and benchmark-model pull are allowed
(`admin/app/services/ollama_service.ts:64-90`,
`admin/app/services/benchmark_service.ts:1040-1045`). A remote server may technically expose those
APIs while still being externally owned.

Conversely, Settings computes `supportsModelMgmt` but does not pass it to React
(`admin/app/controllers/settings_controller.ts:61-98`). The page always renders Delete actions,
Ollama Flash Attention/reinstall semantics, and the catalog UI
(`admin/inertia/pages/settings/models.tsx:303-405`,
`admin/inertia/pages/settings/models.tsx:454-583`). OpenAI backend models are labeled “Installed”
even though `/models` only means served/available.

**Recommendation:** Separate `backendSupportsModelMutation` from `canManageModels`; derive the
latter from model-content ownership. Pass capabilities to the page and remove unsupported settings
and actions entirely. A GitOps-provisioned, NOMAD-dedicated Ollama may validly set
`canManageModels=true` while `canUpdateWorkload=false`; an external shared Ollama should default
false unless explicitly opted in.

#### P2.2 — OpenAI-compatible reasoning and context semantics are incomplete

The controller contains model-name logic for `gpt-oss` and turns thinking into Ollama/OpenAI
options (`admin/app/controllers/ollama_controller.ts:148-175`). But
`OpenAIProvider.checkModelHasThinking()` always returns false
(`admin/app/services/llm/openai_provider.ts:282-285`), so vLLM-hosted reasoning models never enable
`reasoning_effort` through this path. The computed `num_ctx` is passed as a generic option but
OpenAIProvider only maps `num_predict` to `max_tokens`
(`admin/app/services/llm/openai_provider.ts:52-64`).

**Recommendation:** Add configured/inferred provider model capabilities (reasoning parameter,
context limit, token option) rather than provider-name or model-name tests in the controller. Keep
unknown models conservative.

#### P2.3 — Supply Depot and scheduled updates conflate discovery with permission to update

The nightly job scans every `installed` row and writes registry results
(`admin/app/jobs/check_service_updates_job.ts:20-79`,
`admin/app/jobs/check_service_updates_job.ts:105-121`). Supply Depot displays update badges and
auto-update controls for those rows (`admin/inertia/pages/supply-depot.tsx:1000-1010`,
`admin/inertia/pages/supply-depot.tsx:1088-1117`). The manual curated-update endpoint is guarded in
Kubernetes, but the custom update endpoint is not
(`admin/app/controllers/system_controller.ts:268-284`,
`admin/app/controllers/system_controller.ts:558-577`).

The hourly app updater selects installed, opted-in rows without ownership and calls
`DockerService.updateContainer()` (`admin/app/services/app_auto_update_service.ts:180-190`,
`admin/app/services/app_auto_update_service.ts:238-303`), scheduled at
`admin/app/jobs/app_auto_update_job.ts:42-58`. Core auto-update requires a Docker updater sidecar and
self-disables after repeated missing-sidecar failures
(`admin/app/services/auto_update_service.ts:277-327`,
`admin/app/services/auto_update_service.ts:525-543`), yet the Kubernetes update page still offers
Start Update, describes Docker pulls/recreation, and renders core/app auto-update controls
(`admin/inertia/pages/settings/update.tsx:279-428`,
`admin/inertia/pages/settings/update.tsx:455-458`).

**Recommendation:** Allow version discovery as informational metadata only when useful, but gate
manual and scheduled mutation on `canUpdate`. Disable scheduling rather than failing against the
dummy Docker client. Keep content updates separate: NOMAD-owned ZIM/map content remains valid on
Kubernetes.

#### P2.4 — System and benchmark semantics describe the admin pod as “the system” and can attribute remote AI to it

`getSystemInfo()` starts with `systeminformation` in the current container
(`admin/app/services/system_service.ts:420-430`). Docker mode enriches it from the daemon, but
Kubernetes skips that branch (`admin/app/services/system_service.ts:463-639`). The UI still labels
the result “System Information,” “CPU Usage,” “Total RAM,” and “Operating System” without saying
these are pod/cgroup/container observations (`admin/inertia/pages/settings/system.tsx:113-203`).
Debug output similarly labels them System/Hardware and probes Docker best-effort even in
Kubernetes (`admin/app/services/system_service.ts:757-855`).

For remote Ollama, GPU probing invents vendor/model `NVIDIA GPU (external Ollama)` after only
checking Ollama endpoints and VRAM allocation (`admin/app/services/system_service.ts:267-315`). It
cannot distinguish NVIDIA, AMD, Apple, or CPU.

The benchmark correctly rejects Docker sysbench in Kubernetes
(`admin/app/services/benchmark_service.ts:833-847`), but the UI still offers Full and System Only
(`admin/inertia/pages/settings/benchmark.tsx:282-314`). OpenAI-compatible AI timing uses estimated
tokens and estimated TTFT and explicitly is not comparable with the native reference benchmark
(`admin/app/services/benchmark_service.ts:1112-1148`). Leaderboard submission blocks only the KV
`ai.remoteOllamaUrl`, not an external `LLM_HOST`, so Kubernetes/BYO inference can be attributed to
admin-pod hardware (`admin/app/services/benchmark_service.ts:340-370`).

**Recommendation:** Present three semantic scopes: NOMAD runtime (pod/container and limits), AI
backend (self-reported or unknown), and storage backend. Hide full/system benchmark when
`canBenchmarkSystem=false`; never submit a combined hardware result unless locality is explicitly
established. Name the OpenAI result “endpoint latency/throughput estimate,” not a comparable NOMAD
AI score.

#### P2.5 — Bundled Kiwix works at the storage level but its browser experience and RWO placement need correction

Kubernetes synchronization overwrites Kiwix's browser location with Content Explorer
(`admin/app/services/system_service.ts:1029-1033`). That page manages catalogs/downloads, while the
local Content Manager only lists and deletes files
(`admin/inertia/pages/settings/zim/index.tsx:22-39`,
`admin/inertia/pages/settings/zim/index.tsx:200-245`). The UI does not provide the raw Kiwix server
link that serves installed ZIMs in Kubernetes.

The default content PVC is RWO (`deploy/k8s/base/admin/pvc.yaml:7-16`). Kiwix has required
pod-affinity to the current admin pod's node (`deploy/k8s/components/kiwix/deployment.yaml:20-30`),
but admin has no symmetric placement constraint. Initial scheduling should co-locate them, yet
multi-node rescheduling/failover can leave the second pod pending behind a volume attachment. RWX
avoids that. A single pod with Kiwix as a sidecar would also make RWO co-location atomic, but has
different lifecycle tradeoffs and is not required for the first refactor.

**Recommendation:** Return separate `browserUrl` and `managementUrl` so Home can open Kiwix while
Settings opens NOMAD content management. Document RWO as single-node/placement-sensitive and add a
runtime test with the target CSI driver. Consider sidecar or symmetric placement only after that
test; keep RWX as the multi-node recommendation.

#### P2.6 — Kiwix content completion still probes Docker in Kubernetes

After correctly rebuilding shared XML, download completion and rescan call
`isKiwixOnLegacyConfig()` (`admin/app/services/zim_service.ts:397-406`,
`admin/app/services/zim_service.ts:507-520`). That method catches a failed Docker call and returns
false (`admin/app/services/docker_service.ts:1320-1332`), so the Kubernetes content path should
complete, but every call needlessly touches `/dev/null` and logs a warning. The Kiwix boot provider
does the same (`admin/providers/kiwix_migration_provider.ts:27-58`).

**Recommendation:** Treat “legacy Docker container config” as a capability only implemented by the
managed Docker adapter. Always rebuild XML in the runtime-neutral content service; ask the adapter
whether a restart/migration is required only when it exists.

#### P2.7 — Three boot providers assume a Docker daemon even though the constructor comment promises all calls are guarded

Qdrant restart-policy repair opens `/var/run/docker.sock`
(`admin/providers/qdrant_restart_policy_provider.ts:17-57`), Kiwix migration creates DockerService
(`admin/providers/kiwix_migration_provider.ts:15-58`), and GPU remediation opens the socket,
executes `nvidia-smi`, and may force-reinstall Ollama
(`admin/providers/gpu_passthrough_remediation_provider.ts:26-117`). They catch failures, so this is
startup noise rather than a demonstrated crash, but it disproves the invariant documented at
`admin/app/services/docker_service.ts:61-66`.

**Recommendation:** Register/run these providers only when the Docker-managed capability exists.

#### P2.8 — Upload and ingestion admission is inconsistent

ZIM download sites use `OllamaService.isEmbeddingBackendConfigured()` before dispatch
(`admin/app/jobs/run_download_job.ts:207-290`). Direct KB uploads always save the file and enqueue an
embedding job (`admin/app/controllers/rag_controller.ts:18-50`), even if no embedding or Qdrant
backend is configured; the job then records an unrecoverable missing-service failure. For
OpenAIProvider, `listModels()` returns `[]` on outage and the job's `if (!existingModels)` readiness
check accepts it (`admin/app/jobs/embed_file_job.ts:107-116`), deferring failure to embed.

**Recommendation:** Add a single embedding integration readiness result used for admission,
status, and jobs. Preserve uploaded files when unavailable, but mark them
`pending_backend_configuration` rather than dispatching a guaranteed failed job.

#### P2.9 — Companion URL support is mostly link registration, not integration

`KOLIBRI_URL`, `CYBERCHEF_URL`, and `FLATNOTES_URL` are read only by service sync/URL resolution
(`admin/app/services/system_service.ts:1029-1038`,
`admin/app/services/docker_service.ts:263-270`). NOMAD does not call their APIs or manage their
content. That is valid as a link integration if labeled honestly. `PROTOMAPS_URL` is declared but
has no consumer beyond env validation (`admin/start/env.ts:95-99`); maps are downloaded into and
served by admin, consistent with `deploy/k8s/README.md:91-92`.

**Recommendation:** Describe Kolibri/CyberChef/FlatNotes as browser-link integrations with optional
health probes. Remove or mark `PROTOMAPS_URL` reserved until a real code path exists. Keep internal
API endpoints and browser endpoints as different fields.

#### P2.10 — Kolibri's alternate-origin ingress example needs a runtime proof

Kolibri listens and advertises zip content on port 8311
(`admin/database/seeders/service_seeder.ts:183-200`,
`deploy/k8s/components/kolibri/deployment.yaml:23-33`). The example maps it through a different
hostname (`deploy/k8s/components/ingress/ingress.yaml:42-63`) without configuring Kolibri with that
external host/origin. Static analysis cannot prove the generated asset URLs match that ingress.

**Recommendation:** Run an interactive HTML5 exercise through each supported ingress controller,
inspect the generated zip-content URL, and document/configure the exact external-origin variables.
Do not call the component fully supported until that passes.

### P3 — cleanup and maintainability

#### P3.1 — Docker-coupling taxonomy

The meaningful non-DockerService call sites fall into four groups:

| Category | Current call paths | Disposition |
|---|---|---|
| Legitimate Docker-only lifecycle | container lifecycle, image pull/update/rollback, host ports, binds/volumes, network/GPU detection, custom apps, logs/stats in `admin/app/services/docker_service.ts:102-182`, `330-574`, `1432-1470`, `1628-1947`, `2015-2260`; controller calls at `admin/app/controllers/system_controller.ts:59-105`, `392-607` | Keep behavior. Put authorization in front of it and expose it as the managed-Docker executor. |
| Should be runtime-neutral | service inventory/sync in `admin/app/services/system_service.ts:324-393`, content download completion in `admin/app/jobs/run_download_job.ts:207-290`, local ZIM library work in `admin/app/services/zim_service.ts:350-680` | Remove direct runtime tests; consume integration descriptors or an optional lifecycle hook. |
| Should use provider/capability abstraction | chat/embeddings/model operations in `admin/app/services/ollama_service.ts:121-206`; Qdrant selection in `admin/app/services/rag_service.ts:80-169`; benchmark AI selection in `admin/app/services/benchmark_service.ts:974-1148` | Provider split is good; add authorization, health, and benchmark semantics. |
| Disable for external/GitOps ownership | Supply Depot mutation/log/stat paths, core/app updater, boot remediators, remote model mutation, Docker sysbench | Resolve false capabilities server-side; do not call a dummy Docker object. |

Job constructors that instantiate DockerService solely for endpoint fallback—EmbedFileJob,
RunDownloadJob, CheckUpdateJob, and RunBenchmarkJob—do not themselves prove Docker coupling. The
problem is whether the called service requires Docker. Endpoint fallback in RAG is acceptable;
sysbench and lifecycle/update are explicitly Docker-only.

#### P3.2 — Naming still leaks Ollama into generic code

`OllamaService`, `OllamaController`, settings prop names, `remoteOllamaUrl`, and benchmark fields
remain generic-provider entry points. Keeping the facade name was a sensible low-conflict first
step (`admin/app/services/ollama_service.ts:23-30`), but new generic behavior should not add more
Ollama-named APIs.

**Recommendation:** Do not perform a flag-day rename. Introduce new `LLMIntegrationService` or
generic endpoints beside the facade, migrate callers incrementally, and leave compatibility
aliases until upstream convergence.

#### P3.3 — Fork patch surface is concentrated in upstream-hot files

The fork differs from upstream in 82 files (+2,800/-927). Highest-risk modified files are
`system_service.ts` (+240/-145), `ollama_service.ts` (+177/-668), `rag_service.ts` (+90/-44),
`benchmark_service.ts` (+67/-4), `system_controller.ts` (+41/-15), Settings/Chat React files, and
the service seeder. Those are active upstream feature files. The new provider directory and
`deploy/k8s` are isolated and therefore lower-conflict.

**Recommendation:** Put new ownership/capability resolution in new files, keep upstream service
methods intact, and reduce fork edits to narrow calls at controller/page boundaries. Avoid a
Kubernetes fork of each workflow.

---

## 4. Deployment matrix

“Expected support” below describes what the reviewed code actually supports now, followed by the
target after the recommended capability refactor.

| NOMAD Runtime | Service | Ownership/provisioning | Expected support |
|---|---|---|---|
| Docker | Ollama | NOMAD-managed Docker | **Current: supported.** Docker discovery, lifecycle, models, chat, embeddings, benchmark, logs/stats, and update use the existing appliance path. **Target: unchanged.** |
| Docker | remote Ollama | External workload | **Current: partial.** KV URL wins Docker discovery (`docker_service.ts:281-285`); native chat/embed/models work, but provider caching can require restart and NOMAD can pull/delete models and benchmark-pull on the external server. **Target:** chat/embed/list/health; model mutation only by explicit content ownership; no workload lifecycle/update/logs/stats. |
| Kubernetes | bundled Ollama | GitOps workload; optionally NOMAD-owned models | **Current: likely data-plane supported.** `LLM_HOST` selects Ollama; chat/embed/models and model pull call its API. Workload lifecycle is 501 in some routes, but Supply Depot/update UI is inconsistent. **Target:** no workload mutation; optional model management/benchmark; health and diagnostics scoped to backend. |
| Kubernetes | external Ollama | External workload and default external model ownership | **Current: same API behavior as bundled; ownership is indistinguishable, so model pulls/deletes remain enabled.** **Target:** chat/embed/list/health by default, explicit opt-in for model management, no workload mutation. |
| Kubernetes | external vLLM/OpenAI-compatible | External | **Current: chat/stream/model list work when `LLM_PROVIDER=openai` and host includes `/v1`. Reasoning capability is false; model UI is misleading. Embeddings work only if that endpoint also serves configured `/embeddings`, otherwise `EMBEDDING_HOST` is required. Native benchmark is replaced with a non-comparable estimate.** **Target:** honest capabilities and dedicated embedding integration. |
| Kubernetes | Qdrant | Bundled GitOps | **Current: RAG API works via `QDRANT_HOST`; DB status is configuration-only; no lifecycle.** **Target:** same data plane plus health/configuration state and embedding fingerprint guard. |
| Kubernetes | Qdrant | External | **Current: same API path as bundled and therefore generally viable; no authentication/TLS-specific config beyond the URL, and no collection identity guard.** **Target:** explicit external ownership, credentials/TLS if required, health, and safe collection identity. |
| Kubernetes | Kiwix | Bundled GitOps workload; NOMAD-owned content | **Current: shared ZIM/XML workflow is preserved and Kiwix monitorLibrary should reload. UI links to management/catalog rather than the serving endpoint; RWO placement is sensitive.** **Target:** separate browser and management URLs, shared-storage health, no workload lifecycle. |
| Kubernetes | Kiwix | External endpoint only | **Current: not integrated.** URL only marks installed; NOMAD cannot discover or ingest remote ZIMs. **Target:** link/health only unless a remote import API is deliberately built. |
| Kubernetes | Kiwix | External operator with shared NOMAD storage/XML | **Current: can work if operator reproduces bundled mount/path/args contract; not represented distinctly or verified.** **Target:** first-class `sharedNomadLibrary` integration with storage-contract diagnostics. |
| Kubernetes | Kolibri Gen 2 | Bundled GitOps | **Current: pod/manifests exist but the admin maps `KOLIBRI_URL` to the deprecated service ID, so integration is invisible.** **Target:** browser link + health; no lifecycle/content management. |
| Kubernetes | CyberChef | Bundled or external | **Current: browser link only.** **Target:** browser link + optional health; lifecycle capabilities based on owner. |
| Kubernetes | FlatNotes | Bundled or external | **Current: browser link only; app-private data belongs to its PVC/operator.** **Target:** browser link + optional health; no content API in NOMAD. |

### RAG scenario trace

#### Case 1 — Docker-managed Ollama + Docker-managed Qdrant

**Config:** leave `LLM_HOST`, `EMBEDDING_HOST`, and `QDRANT_HOST` unset; install AI Assistant.

**Actual path:** OllamaProvider falls back to Docker service discovery
(`ollama_provider.ts:42-50`); RagService discovers Qdrant from Docker
(`rag_service.ts:83-94`); missing `nomic-embed-text:v1.5` is pulled
(`rag_service.ts:340-370`); a 768-dimensional collection is created
(`rag_service.ts:126-147`). ZIM/file ingestion, retrieval, and chat should work.

**Risk:** existing collection identity is not checked; all other behavior matches the appliance
model.

#### Case 2 — K8s NOMAD + bundled Ollama + bundled Qdrant

**Config:** Ollama component sets `LLM_PROVIDER=ollama`/`LLM_HOST`; Qdrant component sets
`QDRANT_HOST` (`deploy/k8s/components/ollama/admin-env-patch.yaml:10-12`,
`deploy/k8s/components/qdrant/admin-env-patch.yaml:10-12`).

**Actual path:** no Docker discovery is needed; model verification/auto-pull and Qdrant operations
use cluster services. This is the strongest Kubernetes AI/RAG case and should work if network,
PVC, and workers are healthy.

**Risk:** service status lies on endpoint config, model/workload ownership is not separated, and
collection fingerprinting is absent.

#### Case 3 — K8s NOMAD + external vLLM + bundled Qdrant

**Config:** `LLM_PROVIDER=openai`, `LLM_HOST=http://.../v1`, API key as needed, Qdrant component.
Set `EMBEDDING_HOST` unless the same vLLM endpoint serves the chosen embedding model.

**Actual path:** chat uses OpenAIProvider. Without `EMBEDDING_HOST`, embeddings are sent to the chat
endpoint's `/embeddings` with the default `nomic-embed-text:v1.5`; many vLLM deployments will not
serve that model alongside the chat model. Static analysis cannot establish a particular vLLM
deployment's served models.

**Likely result:** chat succeeds; RAG succeeds only when an embedding endpoint/model/dimension are
deliberately configured. The external-LLM patch's default embedding values can imply more
automatic compatibility than exists (`deploy/k8s/components/external-llm/admin-env-patch.yaml:22-35`).

#### Case 4 — K8s NOMAD + external vLLM + dedicated external embeddings + external Qdrant

**Config:** `LLM_PROVIDER=openai`, `LLM_HOST=<chat>/v1`, `LLM_API_KEY`,
`EMBEDDING_HOST=<embed>/v1`, `EMBEDDING_API_KEY`, correct model/dimension/prefixes, and
`QDRANT_HOST`.

**Actual path:** chat and embeddings use separate OpenAI-compatible endpoints
(`ollama_service.ts:281-305`); Qdrant is direct. Ingestion and search are deployment-neutral.

**Likely result:** this can work today and is the best BYO composition, provided `/models`,
`/chat/completions`, `/embeddings`, response ordering, vector dimensions, prefixes, and Qdrant
network access match the code's assumptions. There is no startup validation or collection
fingerprint, so misconfiguration fails late or silently degrades retrieval.

#### Case 5 — Docker NOMAD + remote Ollama

**Config:** Settings remote URL or, more reliably, `LLM_PROVIDER=ollama` plus `LLM_HOST`/
`OLLAMA_HOST` at process start; install/use Qdrant locally or set `QDRANT_HOST`.

**Actual path:** the Settings KV URL wins Docker service discovery, and Ollama-native chat/embed/
model APIs operate remotely. ConfigureRemote stops local Ollama and fire-and-forgets a local
Qdrant install. If the provider initialized earlier, cached endpoint state may remain stale.

**Likely result:** remote Ollama works after clean initialization/restart. A generic
OpenAI-compatible URL does not. NOMAD currently mutates the remote model store, which is unsafe as
a default for an externally owned service.

---

## 5. Service capability matrix — actual code behavior

Legend: **Yes** = working code path; **Partial** = conditional/misleading; **No** = absent or
intentionally unavailable. “Lifecycle” and “updates” describe what NOMAD code can do, not what
Kubernetes can do.

| Service/integration | API use | Shared storage | Content/model management | Lifecycle | Updates | Logs/stats | External-safe today |
|---|---|---|---|---|---|---|---|
| Docker-managed Ollama | Yes, native Ollama | Ollama model bind | Yes, pull/delete | Yes | Image update | Docker logs/stats | N/A—managed |
| Remote Ollama | Yes, native Ollama | No | **Yes by accident/technical capability** | Local container stop during configuration; remote workload no | Registry UI can still appear from service row | Remote no; UI may offer Docker paths | **No**—ownership not enforced |
| OpenAI-compatible LLM | Yes, chat/models/optional embeddings | No | No backend mutation, but UI still renders actions/settings | No meaningful lifecycle | No | No | Partial—chat safe; UI/benchmark semantics not |
| Qdrant managed or external | Yes, collections/upsert/search/health | No; owns private persistence | NOMAD creates/indexes collection and deletes points | Docker-managed only | Docker image update only | Docker only | Partial—endpoint works; schema identity unsafe |
| Kiwix Docker-managed | NOMAD does not call Kiwix API | **Required:** ZIM/XML bind | Yes, local downloads/uploads/XML/delete/RAG | Yes | Docker image update | Docker logs/stats | N/A—managed |
| Kiwix K8s bundled/shared | NOMAD does not call endpoint | **Required:** shared `nomad-storage/zim` | Yes, NOMAD-owned local content and RAG | No intended; Docker probes remain | GitOps, but update UI may advertise | Cluster tooling; Supply UI may offer Docker | Partial—data works, UI/placement gaps |
| Kiwix endpoint-only external | **No endpoint use** | None | No discovery/download visibility/RAG | No | No | No | **No—claimed integration is false** |
| Kolibri | No API; browser link only | No NOMAD share; app-private PVC/bind | No | Docker-managed only | Docker image update only | Docker only | Partial; K8s Gen 2 mapping is broken |
| CyberChef | No API; browser link only | No | No | Docker-managed only | Docker image update only | Docker only | Yes as a link, but state/health lie |
| FlatNotes | No API; browser link only | No NOMAD share; app-private PVC/bind | No | Docker-managed only | Docker image update only | Docker only | Yes as a link, but state/health lie |
| Maps/PMTiles | Admin HTTP/file APIs | NOMAD storage only | Yes, download/delete/serve | No separate service | Content updater | Admin diagnostics | Yes; `PROTOMAPS_URL` unused |
| Other Supply Depot apps | Usually no integration beyond browser URL | Docker binds vary | App-specific files only | Docker lifecycle | Docker registry/image update | Docker logs/stats | No BYO descriptor; custom URL is link-only |

The key architectural nuance is that ownership is not one bit. A bundled Kubernetes Ollama can
have **GitOps-owned workload lifecycle** and **NOMAD-owned models**. Bundled Kiwix has a
**GitOps-owned workload** and **NOMAD-owned ZIM content**. External shared services usually have
both planes externally owned. Capabilities should be authoritative even when the ownership labels
are useful for explanation.

---

## 6. Recommended architecture

### 6.1 Add a small service integration control plane

Do not introduce a general “Kubernetes runtime service.” NOMAD does not need to enumerate pods or
deploy workloads. Add a resolver/registry in new files and use DockerService only as one executor.

One possible TypeScript shape:

```ts
type RuntimeContext = 'docker' | 'kubernetes' | 'unknown'
type WorkloadProvisioner = 'nomad-docker' | 'external-gitops' | 'external' | 'none'
type ResourceOwner = 'nomad' | 'external' | 'none'
type Availability = 'disabled' | 'configured' | 'reachable' | 'unhealthy' | 'unknown'

interface ServiceEndpoints {
  apiUrl?: string       // server-to-server; never placed in an href
  browserUrl?: string   // user/browser reachable
  managementUrl?: string // NOMAD page such as Content Manager
}

interface ServiceCapabilities {
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
  canBenchmarkAI: boolean
  canBenchmarkSystem: boolean
}

interface ServiceIntegration {
  serviceName: string
  runtimeContext: RuntimeContext
  workloadProvisioner: WorkloadProvisioner
  modelOwner: ResourceOwner
  contentOwner: ResourceOwner
  configuration: 'disabled' | 'configured'
  availability: Availability
  availabilityMessage?: string
  endpoints: ServiceEndpoints
  capabilities: ServiceCapabilities
  contracts?: {
    kiwixContent?: 'sharedNomadLibrary' | 'externalEndpoint'
    embeddingFingerprint?: string
  }
}
```

The field names are less important than the separation. Do not infer every capability from
`runtimeContext`. Compute them from the integration:

- Docker-managed app: workload lifecycle/update/logs/stats true.
- K8s/GitOps app: those workload capabilities false.
- External app: workload capabilities false.
- K8s bundled Ollama with NOMAD-owned model PVC/API: `canManageModels=true` can be independent.
- K8s bundled Kiwix with shared storage: `canManageContent=true`; endpoint-only external Kiwix:
  false.
- Disabled service: everything false.

### 6.2 Resolve, do not synchronize, externally configured state

Build descriptors from:

1. stable catalog/DB service metadata;
2. managed-Docker container existence for Docker-provisioned services;
3. explicit deployment config for external/GitOps integrations;
4. cached service-specific health probes; and
5. optional ownership overrides.

Initially leave the `services` table intact and avoid a wholesale migration. `installed` can keep
its upstream Docker meaning. The resolver overlays configured external/GitOps state in the API
response. Add persisted columns only when runtime configuration through the UI is deliberately
supported; env/Kustomize settings can remain process configuration.

Replace `_syncServicesForKubernetes()` with resolution. That avoids database churn, stale
`ui_location`, and migration problems when environment variables disappear.

### 6.3 Centralize endpoint and health contracts per integration

Use a registry keyed by service name, with narrow adapters:

- Ollama: `/api/tags` or `/api/version` health; native capabilities.
- OpenAI-compatible LLM: `/models`; configured reasoning/model metadata.
- Qdrant: `getCollections()`.
- Kiwix shared-library: local ZIM/XML health plus optional HTTP endpoint probe.
- Kiwix external endpoint: HTTP health/open only.
- Kolibri/CyberChef/FlatNotes: browser URL plus optional HEAD/GET probe; do not call these
  “installed” solely because the URL exists.

Keep `apiUrl`, `browserUrl`, and `managementUrl` separate end to end. `Service.custom_url` already
correctly documents that it affects only the launch link
(`admin/app/models/service.ts:62-66`); preserve that idea in the new descriptor.

### 6.4 Keep DockerService, but make it an executor rather than the source of truth

Do not redesign its existing container logic. Add a thin `ManagedServiceExecutor` interface only
where controllers need it, implemented by DockerService or a small adapter around it:

```ts
interface ManagedServiceExecutor {
  install(name: string): Promise<OperationResult>
  uninstall(name: string, options?: { removeImage?: boolean }): Promise<OperationResult>
  affect(name: string, action: 'start' | 'stop' | 'restart'): Promise<OperationResult>
  update(name: string, version: string): Promise<OperationResult>
  logs(name: string, tail: number): Promise<LogResult>
  stats(name: string): Promise<StatsResult>
}
```

The resolver determines whether an executor is present and an operation is authorized. No dummy
Docker object is needed in Kubernetes. No Kubernetes executor is needed because GitOps owns that
lifecycle.

### 6.5 Treat embedding configuration as a versioned data contract

Create an `EmbeddingIntegration` with endpoint, model, dimensions, prefixes, readiness, and
fingerprint. On startup/first use:

1. call one probe embedding;
2. verify returned count and dimensions;
3. inspect Qdrant collection vector size;
4. compare stored fingerprint;
5. refuse mismatch with an actionable “create/reindex/migrate” response; and
6. use an alias to switch to a newly indexed collection only after success.

This is more important than adding another provider implementation.

### 6.6 Make Kiwix's storage contract explicit

For `sharedNomadLibrary`, verify:

- admin can read/write `/storage/zim` and atomically rename XML;
- Kiwix is configured to see the same filenames at `/data`;
- the serving endpoint is reachable if configured; and
- UI offers both NOMAD content management and the browser-serving URL.

For `externalEndpoint`, expose open/health only. Do not show NOMAD download, delete, library
rescan, or RAG-from-remote claims. An optional later import feature should copy a selected remote
ZIM into NOMAD storage before it enters the existing ingestion path.

### 6.7 Separate update discovery from update authority

Retain registry discovery where informative, but include `canUpdateWorkload`. The UI may say
“version X exists; managed by GitOps” without offering mutation. Scheduled jobs must query only
capability-authorized targets. Core/app update panels should be absent on Kubernetes; content
updates should remain because NOMAD owns that content.

---

## 7. Incremental refactor sequence

Each phase should leave Compose behavior working and be small enough for a focused PR.

### PR 1 — Integration descriptors and server-side capability enforcement

**Objective:** Add `ServiceIntegrationResolver`, endpoint types, health/availability enums, and a
capability response. Preserve `Service` and DockerService behavior. Enforce capabilities in every
SystemController mutation/log/stat route, Easy Setup, and updater entry point.

**Likely files:** new `admin/app/services/service_integration/*`; `system_service.ts`;
`system_controller.ts`; `supply_depot_controller.ts`; `easy_setup_controller.ts` or endpoint
guards; update jobs/services; shared `types/services.ts`.

**Tests:** table-driven descriptor tests for Docker managed, K8s GitOps, external, and disabled;
functional 403/409/501-equivalent tests proving every disallowed route does not call Docker;
Compose behavior regression tests.

**Migration risk:** low if descriptors initially overlay DB state and no schema changes occur.

**Upstream conflict risk:** medium in `system_service.ts`/controller; keep new logic in new files
and changes at boundaries.

### PR 2 — Capability-driven Supply Depot, Easy Setup, models, benchmark, and update UI

**Objective:** Render operations from server capabilities. Remove global Kubernetes behavior from
active pages. Hide Docker update panels and full/system benchmark when unsupported. Distinguish
available vs installed models.

**Likely files:** `supply-depot.tsx`, `easy-setup/index.tsx`, `settings/models.tsx`,
`settings/benchmark.tsx`, `settings/update.tsx`, `SettingsLayout.tsx`, service hooks/types.

**Tests:** React component tests or Playwright for each capability combination; assert no hidden
button can be reached by keyboard/menu; API denial remains the backstop.

**Migration risk:** low; presentational except for wiring.

**Upstream conflict risk:** medium/high because these pages evolve upstream; use a shared
`ServiceActions` component/selector rather than repeated conditionals.

### PR 3 — Fix provider configuration and ownership-safe model management

**Objective:** Make runtime remote config protocol-honest and reset-safe; distinguish provider
support from permission. Either narrow the existing UI to remote Ollama or add explicit provider
selection and credentials. Remove Docker/Qdrant side effects from generic config.

**Likely files:** `provider_factory.ts`, `ollama_service.ts`, `ollama_controller.ts`,
`settings_controller.ts`, `settings/models.tsx`, new LLM integration config types.

**Tests:** remote Ollama native endpoints; vLLM/llama.cpp OpenAI endpoints; save/clear after prior
provider initialization; external Ollama model mutation denied by default; bundled NOMAD-owned
models allowed; request cancellation.

**Migration risk:** medium because KV `ai.remoteOllamaUrl` must be migrated/interpreted as Ollama.

**Upstream conflict risk:** medium; provider files are fork-owned, controller/UI are hot.

### PR 4 — Embedding/Qdrant contract and safe migration UX

**Objective:** Add readiness probe, response validation, Qdrant dimension inspection, embedding
fingerprint, mismatch error, and explicit reindex/new-collection flow.

**Likely files:** `rag_service.ts`, `ollama_service.ts` or a new embedding provider,
`embed_file_job.ts`, KB models/controller/UI.

**Tests:** dimensions match/mismatch; same dimension but different model/prefix; incomplete
embedding response; external Qdrant outage/recovery; no old-collection deletion; alias switch only
after successful reindex.

**Migration risk:** medium/high for existing knowledge bases; default fingerprint adoption must
recognize the legacy nomic/768/default-prefix case or require explicit confirmation.

**Upstream conflict risk:** high in `rag_service.ts`; isolate fingerprint/storage logic.

### PR 5 — Honest Kiwix integration modes and Kolibri repair

**Objective:** Define `sharedNomadLibrary` versus `externalEndpoint`; separate Kiwix browser and
management URLs; remove Docker probes from runtime-neutral ZIM completion; map Kolibri Gen 2.

**Likely files:** integration registry, `zim_service.ts`, Kiwix boot provider, Home/navigation,
Kustomize env patches/README, `system_service.ts` map removal.

**Tests:** fresh/upgraded Kolibri DB; ZIM download/upload/delete updates XML without Docker; shared
mount serves additions/deletions; endpoint-only external mode disables content management/RAG;
browser URL and management URL are distinct.

**Migration risk:** low/medium; existing K8s env users need an explicit Kiwix mode or safe bundled
default.

**Upstream conflict risk:** medium; Kustomize files are isolated, ZIM service is upstream-active.

### PR 6 — Diagnostics, benchmark attribution, updates, and boot cleanup

**Objective:** Scope runtime/AI/storage diagnostics, prevent remote leaderboard attribution,
disable Docker-only schedules/providers when unauthorized, and make registry discovery
informational for GitOps.

**Likely files:** `system_service.ts`, `benchmark_service.ts`, benchmark/system/update React pages,
auto-update/check jobs, three boot providers.

**Tests:** pod/cgroup labels; remote LLM submission denial; AI-only external estimate labeling;
K8s schedules never call Docker; content update remains available; boot providers skip cleanly.

**Migration risk:** low; mostly presentation and gating.

**Upstream conflict risk:** high in benchmark/system services; keep backend-scope detection in new
helpers.

---

## 8. Tests we are missing

There are currently no tests mentioning Kubernetes mode, LLM providers, external embeddings,
Qdrant host selection, Kiwix URL/storage, or Supply Depot capability rendering. Highest-value
additions are:

1. **Capability contract tests:** every service shape maps to exact capabilities; every controller
   checks the same descriptor before calling an executor.
2. **Docker appliance regression:** managed install/uninstall/start/stop/restart/update/logs/stats,
   model pull/delete, and Kiwix content flows remain unchanged.
3. **No-Docker Kubernetes functional test:** run admin with `KUBERNETES_SERVICE_HOST` and no socket;
   visit Home, Supply Depot, Easy Setup, models, benchmark, update; exercise every visible action;
   assert zero Docker calls and no `/dev/null` errors.
4. **Configured vs health state:** missing env, valid env/unreachable host, unhealthy response,
   recovery, env removal after pod restart, browser/internal URL separation.
5. **Remote Ollama:** chat/stream cancellation/embed/list; provider reconfiguration; default deny
   pull/delete/update; explicit NOMAD-owned model opt-in.
6. **vLLM/llama.cpp contract:** `/models`, sync and streaming chat, SSE variants, reasoning content,
   cancellation, missing model, unsupported parameters, API keys, base URL with exactly one `/v1`.
7. **Dedicated embedding host:** chat provider has no embeddings; separate host succeeds; response
   order/count/dimension validation; transient outage retries.
8. **Qdrant:** external and bundled selection; health recovery; first collection; dimension
   mismatch; same-dimension fingerprint mismatch; safe reindex/alias switch.
9. **Kiwix shared storage:** a test volume shared by an admin process and `kiwix-serve`; download,
   XML atomic update, hot reload, deletion, rescan, local upload, and RAG extraction from the same
   ZIM. Repeat on intended RWO CSI and multi-node scheduling.
10. **Kiwix external endpoint:** prove it exposes only link/health and cannot advertise content
    management. If remote discovery is later added, test against a pinned Kiwix version.
11. **Kolibri:** fresh migration maps Gen 2; upgraded legacy row remains manageable; interactive
    zip content works through supported ingress/Gateway implementations.
12. **UI rendering:** snapshots/interaction tests for `canOpen` only, model management, content
    management, GitOps version notice, and completely disabled services.
13. **Updater scheduling:** external/GitOps services may receive discovery metadata but never enter
    manual/automatic mutation; Docker apps still do; content updates remain runtime-neutral.
14. **Diagnostics/benchmark:** labels reflect pod versus backend; external AI never combines with
    local hardware for leaderboard submission; K8s offers only supported benchmark types.
15. **Kustomize CI:** render base, every component individually, bundled default, external-LLM
    alternative, Ingress, HTTPRoute, and GPU overlay; add schema validation and policy checks for
    `automountServiceAccountToken: false` and absence of RBAC.

Runtime experiments specifically required before declaring support:

- exercise all five RAG cases with actual pinned Ollama, vLLM/llama.cpp, embedding, and Qdrant
  versions;
- restart each backend mid-ingestion and during chat cancellation;
- change embedding model/dimension on a populated collection;
- validate Kiwix monitorLibrary hot reload on the target filesystem/CSI driver;
- force admin and Kiwix rescheduling across two nodes with the intended RWO/RWX class;
- execute a Kolibri HTML5/zip-content lesson through each documented ingress topology; and
- verify browser-facing URLs from a client outside cluster DNS.

---

## 9. Do NOT do yet

- **Do not build a Kubernetes operator, CRDs, dynamic Deployment creation, or cluster-wide RBAC.**
  The reviewed data-plane code works through endpoints and shared storage; GitOps ownership is a
  product constraint, not a missing feature.
- **Do not mount a service-account token.** No compelling Kubernetes API use was found.
- **Do not create a third global “BYO mode.”** Runtime, workload provisioner, model owner, content
  owner, endpoints, health, and capabilities vary independently.
- **Do not replace DockerService wholesale.** Its appliance lifecycle, image, port, volume, GPU,
  log, stat, and rollback behavior is legitimate and should remain stable.
- **Do not replace the `services` schema wholesale.** Start with a computed descriptor overlay;
  add only fields needed for durable UI-configured integrations.
- **Do not duplicate every controller/job for Kubernetes.** Kubernetes should contribute
  descriptors and false lifecycle capabilities, not parallel workflows.
- **Do not make configured URLs synonymous with health.** Add probes and `unknown`.
- **Do not automatically delete or recreate Qdrant collections on embedding mismatch.** Require an
  explicit reindex/migration with recoverable old data.
- **Do not promise endpoint-only Kiwix content management.** Shared storage or an implemented
  import/sync API is required.
- **Do not generalize the current Settings remote URL beyond Ollama without protocol selection.**
  A `/v1/models` probe is not proof of native Ollama compatibility.
- **Do not spend the next PR renaming every Ollama symbol.** Preserve the facade to minimize
  upstream conflicts; migrate names as generic APIs are introduced.
- **Do not move all app-private data onto `nomad-storage` for Kubernetes neatness.** The current
  separate PVCs are a good boundary. Share only NOMAD-owned content that a companion must consume.

---

## Bottom line

The fork is closer to a good architecture in the **data plane** than the UI suggests: environment-
selected OpenAI/Ollama endpoints, dedicated embeddings, external Qdrant, local content storage,
and Kiwix's shared XML contract are valuable foundations. It is farther away in the **control
plane**: `installed`, `running`, ownership, health, browser/API endpoints, and permissions are
collapsed into Docker-era concepts and a global Kubernetes boolean.

The highest-leverage next move is not more Kustomize components. It is a narrow, per-service
integration descriptor with server-enforced capabilities. Once that exists, the provider,
embedding, Kiwix, updater, diagnostics, and React issues become small, independently testable
repairs while the upstream Docker appliance remains intact.
