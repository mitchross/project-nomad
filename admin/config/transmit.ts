import env from '#start/env'
import { defineConfig } from '@adonisjs/transmit'
import { redis } from '@adonisjs/transmit/transports'

export default defineConfig({
  pingInterval: '30s',
  // In-memory transport for tests: the Redis transport connects eagerly at
  // boot, and its pub/sub clients race process exit — ioredis flushes their
  // queues with "Connection is closed" errors that Japa reports as Unhandled
  // Errors, failing runs whose tests all passed. Tests don't need
  // cross-process SSE fan-out.
  transport:
    env.get('NODE_ENV') === 'test'
      ? null
      : {
          driver: redis({
            host: env.get('REDIS_HOST'),
            port: env.get('REDIS_PORT'),
            db: env.get('REDIS_DB') ?? 0,
            keyPrefix: 'transmit:',
          }),
        },
})
