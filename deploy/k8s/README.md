# Project N.O.M.A.D. on Kubernetes

Community-supported Kustomize manifests for running NOMAD on Kubernetes —
no Docker socket required. The Command Center detects Kubernetes automatically
(via the `KUBERNETES_SERVICE_HOST` env var every pod gets) and switches to
**Docker-free mode**: companion services are discovered through environment
variables instead of the Docker API.

> **Image note:** upstream's image does not (yet) include Kubernetes support.
> These manifests default to this fork's image, `ghcr.io/mitchross/project-nomad`.

## Quickstart

```bash
# 1. Edit the secrets (APP_KEY must be ≥16 chars) and the URL in config.env
$EDITOR deploy/k8s/base/secret.yaml deploy/k8s/base/config.env

# 2. Choose your components (LLM flavor, companion apps, ingress vs httproute)
$EDITOR deploy/k8s/kustomization.yaml

# 3. Apply
kubectl apply -k deploy/k8s

# 4. Open the Command Center
kubectl -n project-nomad port-forward svc/nomad-admin 8080:8080
# → http://localhost:8080
```

Works as-is with ArgoCD/Flux — point an Application/Kustomization at `deploy/k8s`.

## Layout

```
base/                  admin (Command Center) + MySQL + Redis — the minimum
components/            opt-in mix-ins; each adds its workload AND injects the
                       right env var into the admin deployment
  qdrant/              vector DB — required for the Knowledge Base (RAG)
  ollama/              in-cluster LLM (the upstream-like default)
  ollama-gpu-nvidia/   adds an NVIDIA GPU to the ollama pod
  external-llm/        INSTEAD of ollama: BYO vLLM / llama.cpp / OpenAI-compatible
  kiwix/               Information Library (Wikipedia etc.) — shares admin storage
  kolibri/             Education Platform (dual-port caveat below)
  cyberchef/           Data Tools
  flatnotes/           Notes
  ingress/             plain Ingress (edit hosts first)
  httproute/           Gateway API alternative
```

## The env contract

How the admin discovers services in Kubernetes mode. Components set these for
you; listed here for reference and for wiring in externally-hosted services.

| Variable | Meaning | Audience |
|---|---|---|
| `LLM_HOST` | LLM API endpoint (Ollama base URL, or OpenAI-compatible **with `/v1`**) | cluster-internal |
| `LLM_PROVIDER` | `ollama` (default) or `openai` (vLLM, llama.cpp, …) | — |
| `LLM_API_KEY` | API key for OpenAI-compatible backends (`unused` for local) | — |
| `QDRANT_HOST` | Qdrant URL; enables the Knowledge Base | cluster-internal |
| `KIWIX_URL` | Kiwix server URL (admin proxies content through its own UI) | cluster-internal |
| `KOLIBRI_URL` | Kolibri — becomes the UI's "Open" link | **browser-facing** |
| `CYBERCHEF_URL` | CyberChef — becomes the UI's "Open" link | **browser-facing** |
| `FLATNOTES_URL` | Flatnotes — becomes the UI's "Open" link | **browser-facing** |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | RAG embedding model + its vector size (default `nomic-embed-text:v1.5` / `768`) | — |
| `EMBEDDING_HOST` / `EMBEDDING_API_KEY` | optional dedicated OpenAI-compatible embedding service | cluster-internal |

**Browser-facing vs cluster-internal matters:** `KOLIBRI_URL`, `CYBERCHEF_URL`,
and `FLATNOTES_URL` are shown to users as links, so they must resolve from your
users' browsers (your ingress hostnames) — not `*.svc.cluster.local`.

## Caveats worth knowing

- **Shared storage (kiwix):** the admin downloads ZIM files into the
  `nomad-storage` volume; Kiwix serves the same files. With the default
  `ReadWriteOnce` claim, the kiwix deployment carries a pod-affinity that
  co-schedules it with the admin. On multi-node clusters either keep that
  affinity or switch `nomad-storage` to a `ReadWriteMany` storage class and
  remove it.
- **Kolibri needs two exposed origins:** the web UI (8080) and the
  zip-content server (8311) that browsers connect to directly for interactive
  exercises. Expose both through your ingress (example commented in
  `components/ingress/ingress.yaml`).
- **What's intentionally absent:** the `updater`, `disk-collector`, and
  `dozzle` sidecars from the Docker install are Docker-socket tools. On
  Kubernetes, updates are image-tag bumps (GitOps), logs/metrics come from
  your cluster stack, and host-disk reporting is limited.
- **Service management from the UI is reduced by design:** in Kubernetes mode
  the cluster owns the lifecycle. Install/uninstall buttons for the curated
  catalog are disabled; Supply Depot custom apps are Docker-only today.
  Currently the six services above are the ones the admin recognizes via env.
- **Maps:** PMTiles are downloaded via the UI onto the admin's storage volume
  and served by the admin itself — no separate map server pod is needed.
- **Why `replicas: 1` for the admin:** `nomad-admin` is currently tested and
  supported as a single replica. Its HTTP server, BullMQ worker, scheduler
  registration, migrations, and startup lifecycle have not yet been audited
  for active-active operation. Keep `replicas: 1` until multi-replica
  behavior and leader/scheduler semantics are explicitly validated;
  HA/leader-election is deliberately out of scope for now.
- **vLLM users:** enable `components/external-llm` instead of `ollama`, and
  set `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` to match what your server
  actually serves. Model install/delete from the NOMAD UI is unavailable in
  this mode — manage models on your backend.
