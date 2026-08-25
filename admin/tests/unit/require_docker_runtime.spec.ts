import { test } from '@japa/runner'
import RequireDockerRuntimeMiddleware from '../../app/middleware/require_docker_runtime_middleware.js'

/**
 * PR-0 scaffolding guard: managed-Docker-only operations (uninstall,
 * preflights, custom apps, Docker logs/stats) must be refused on Kubernetes
 * instead of reaching the dummy Docker client. Runtime detection is
 * process.env.KUBERNETES_SERVICE_HOST (the variable kubelet injects into
 * every pod), which DockerService.isKubernetesMode() reads live — so the
 * tests toggle it directly.
 */
function fakeContext() {
  const sent: { status?: number; body?: any } = {}
  const ctx = {
    response: {
      status(code: number) {
        sent.status = code
        return {
          send(body: any) {
            sent.body = body
            return body
          },
        }
      },
    },
  } as any
  return { ctx, sent }
}

test.group('requireDockerRuntime middleware', (group) => {
  let savedEnv: string | undefined

  group.each.setup(() => {
    savedEnv = process.env.KUBERNETES_SERVICE_HOST
    return () => {
      if (savedEnv === undefined) delete process.env.KUBERNETES_SERVICE_HOST
      else process.env.KUBERNETES_SERVICE_HOST = savedEnv
    }
  })

  test('passes through to the handler outside Kubernetes', async ({ assert }) => {
    delete process.env.KUBERNETES_SERVICE_HOST
    const { ctx, sent } = fakeContext()
    let nextCalled = false

    await new RequireDockerRuntimeMiddleware().handle(ctx, async () => {
      nextCalled = true
    })

    assert.isTrue(nextCalled)
    assert.isUndefined(sent.status)
  })

  test('returns 501 and never calls the handler on Kubernetes', async ({ assert }) => {
    process.env.KUBERNETES_SERVICE_HOST = '10.96.0.1'
    const { ctx, sent } = fakeContext()
    let nextCalled = false

    await new RequireDockerRuntimeMiddleware().handle(ctx, async () => {
      nextCalled = true
    })

    assert.isFalse(nextCalled)
    assert.equal(sent.status, 501)
    assert.match(sent.body?.error ?? '', /Docker runtime/i)
  })
})
