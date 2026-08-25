import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { DockerService } from '#services/docker_service'

/**
 * TEMPORARY PR-0 SCAFFOLDING — blocks operations that fundamentally require
 * the NOMAD-managed Docker runtime (container lifecycle, custom apps, Docker
 * logs/stats) when the app is running on Kubernetes, where workload lifecycle
 * belongs to the cluster/GitOps and the Docker client is a dummy.
 *
 * This is a runtime-level check by design, applied at the route table so the
 * guarded operation set is auditable in one place. It will be REPLACED by
 * per-service capability enforcement (ServiceIntegrationResolver) in the next
 * refactor phase — do not extend it with service-specific logic.
 *
 * Response shape mirrors the existing in-controller Kubernetes guards (501).
 */
export default class RequireDockerRuntimeMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (DockerService.isKubernetesMode()) {
      return ctx.response
        .status(501)
        .send({ error: 'This operation requires the NOMAD-managed Docker runtime. On Kubernetes, workloads are managed by the cluster.' })
    }
    return next()
  }
}
