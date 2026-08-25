import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { ServiceIntegrationResolver } from '#services/service_integration/resolver'

// Guards provisioning of NEW managed workloads (install preflights, custom-app
// creation), which is runtime-level by nature — no per-service integration
// exists yet for the thing being created. Operations on existing services are
// gated per-service via ServiceIntegrationResolver.assertCapability().
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
