import { createApp } from './app.ts'
import { startSupportReminders } from './modules/chat/reminders.ts'
import {
  parseEnvironment,
  EnvironmentError,
  requireProductionMode,
} from './config/env.ts'
import { createDatabase, checkDatabase } from './db/client.ts'
import { createGracefulShutdown } from './shutdown.ts'
import { operationalStatus } from './http/operational-status.ts'
import { subscriptionService } from './modules/subscriptions/service.ts'
import { startExpiryScheduler } from './modules/subscriptions/scheduler.ts'
import {
  orderTimeoutService,
  startOrderTimeoutScheduler,
} from './modules/orders/timeout.ts'

const operations = operationalStatus()
try {
  if (process.argv.includes('--production')) requireProductionMode()
  const env = parseEnvironment()
  const database = createDatabase(
    env.DATABASE_URL,
    env.MYSQL_AUTH_PUBLIC_KEY_FILE,
  )
  let stopExpiry: () => Promise<void> = async () => {}
  let stopOrders: () => Promise<void> = async () => {}
  let stopSupport: () => Promise<void> = async () => {}
  let shuttingDown = false
  const server = createApp(
    () => checkDatabase(database),
    {
      database,
      env,
    },
    operations,
  ).listen(env.API_PORT, '127.0.0.1', () => {
    if (shuttingDown) return
    stopSupport = startSupportReminders(database, env.APP_BASE_URL)
    stopExpiry = startExpiryScheduler(
      subscriptionService(database).autoTerminate,
      () => {},
      operations.observe('subscriptionExpiry'),
    )
    stopOrders = startOrderTimeoutScheduler(
      orderTimeoutService(database),
      () => {},
      operations.observe('orderTimeout'),
    )
    operations.log({ event: 'startup', result: 'listening' })
  })
  const drain = createGracefulShutdown(
    [
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (
              error &&
              (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            )
              reject(error)
            else resolve()
          })
        }),
      () => stopExpiry(),
      () => stopOrders(),
      () => stopSupport(),
    ],
    () => database.$disconnect(),
  )

  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    void drain()
      .then(() => operations.log({ event: 'shutdown', result: 'stopped' }))
      .catch(() => {
        operations.log({
          event: 'shutdown',
          result: 'failed',
          errorCode: 'DRAIN_FAILED',
        })
        process.exitCode = 1
      })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  server.on('error', () => {
    operations.log({
      event: 'startup',
      result: 'failed',
      errorCode: 'LISTEN_FAILED',
    })
    process.exitCode = 1
    shutdown()
  })
} catch (error) {
  operations.log({
    event: 'startup',
    result: 'failed',
    errorCode:
      error instanceof EnvironmentError
        ? 'INVALID_ENVIRONMENT'
        : 'STARTUP_FAILED',
  })
  process.exitCode = 1
}
