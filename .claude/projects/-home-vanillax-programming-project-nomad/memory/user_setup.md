---
name: user_k8s_setup
description: User runs project-nomad on Kubernetes (Talos + ArgoCD) with llama-cpp as the LLM backend, not Ollama
type: user
---

User deploys project-nomad on Kubernetes using Talos Linux and ArgoCD for GitOps.
Uses llama-cpp (OpenAI-compatible API) as the LLM backend, NOT Ollama.
Values flexibility - wants the project to support local, Docker, K8s, and llama-cpp deployments.
