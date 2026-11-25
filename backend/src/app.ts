import express from 'express'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from './generated/prisma/client.ts'
import type { Environment } from './config/env.ts'
import { applicationRoutes } from './http/routes.ts'
import { ApiError, errors } from './http/errors.ts'
import type { operationalStatus } from './http/operational-status.ts'

export function createApp(
  checkDatabase: () => Promise<void>,
  options?: { database: PrismaClient; env: Environment },
  operations?: ReturnType<typeof operationalStatus>,
) {
  const app = express()
  app.disable('x-powered-by')
  const proxy =
    options?.env.NODE_ENV === 'production'
      ? options.env.TRUSTED_PROXY_IP
      : undefined
  if (proxy)
    app.set(
      'trust proxy',
      (address: string, hop: number) =>
        hop === 0 && (address === proxy || address === '::ffff:' + proxy),
    )
  app.use((_request, response, next) => {
    response.locals.requestId = randomUUID()
    response.setHeader('X-Request-Id', response.locals.requestId)
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    next()
  })
  if (operations) {
    app.use(operations.requests)
    app.get('/internal/ops/metrics', operations.metrics)
  }

  app.get(['/health', '/api/v1/health'], async (_request, response) => {
    try {
      await checkDatabase()
      response.json({ status: 'ok', database: 'ready' })
    } catch {
      // Do not expose driver errors, credentials or connection strings.
      response.status(503).json({ status: 'degraded', database: 'unavailable' })
    }
  })

  app.use(express.json({ limit: 128 * 1024, strict: true }))
  if (options)
    app.use('/api/v1', applicationRoutes(options.database, options.env))
  app.use((_request, _response, next) =>
    next(new ApiError(404, 'NOT_FOUND', 'Route not found.')),
  )
  app.use(errors)

  return app
}
