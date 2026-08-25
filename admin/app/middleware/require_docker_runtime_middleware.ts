import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { ServiceIntegrationResolver } from '#services/service_integration/resolver'

/**
 * Guards operations that PROVISION new managed workloads (install preflights,
 * custom-app creation) — a runtime-level capability by nature, since no
 * per-service integration exists yet for the thing being created.
 *
 * Operations on EXISTING services (uninstall, logs, stats, custom-app
 * update/delete) are enforced per-service in the controllers via
 * ServiceIntegrationResolver.assertCapability(), not here.
 *
 * Response shape mirrors the historical Kubernetes guards (501).
 */
export default class RequireDockerRuntimeMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    if (!ServiceIntegrationResolver.canProvisionWorkloads()) {
      return ctx.response
        .status(501)
        .send({ error: 'Provisioning managed workloads requires the NOMAD Docker runtime. On Kubernetes, workloads are managed by the cluster.' })
    }
    return next()
  }
}
