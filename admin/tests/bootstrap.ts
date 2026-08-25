import { assert } from '@japa/assert'
import app from '@adonisjs/core/services/app'
import type { Config } from '@japa/runner/types'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import testUtils from '@adonisjs/core/services/test_utils'

/**
 * This file is imported by the "bin/test.ts" entrypoint file
 */

/**
 * Configure Japa plugins in the plugins array.
 * Learn more - https://japa.dev/docs/runner-config#plugins-optional
 */
export const plugins: Config['plugins'] = [assert(), pluginAdonisJS(app)]

/**
 * Configure lifecycle function to run before and after all the
 * tests.
 *
 * The setup functions are executed before all the tests
 * The teardown functions are executed after all the tests
 */
export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
  setup: [],
  teardown: [
    // Close the long-lived Redis connections (the shared BullMQ client and
    // transmit's transport) before the process exits. Without this, the exit —
    // especially under --force-exit — races those sockets, and ioredis flushes
    // their queues with "Connection is closed" errors that Japa reports as
    // Unhandled Errors, failing a run whose tests all passed.
    async () => {
      try {
        const { default: queueConfig } = await import('#config/queue')
        queueConfig.connection.disconnect()
      } catch {
        // connection never created — nothing to close
      }
      // transmit needs no teardown here: config/transmit.ts selects the
      // in-memory transport for NODE_ENV=test, so no Redis pub/sub clients
      // exist in test runs (their eager connections were the exit-race).
    },
  ],
}

/**
 * Configure suites by tapping into the test suite instance.
 * Learn more - https://japa.dev/docs/test-suites#lifecycle-hooks
 */
export const configureSuite: Config['configureSuite'] = (suite) => {
  if (['browser', 'functional', 'e2e'].includes(suite.name)) {
    return suite.setup(() => testUtils.httpServer().start())
  }
}
