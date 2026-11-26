import { Router, type RequestHandler } from 'express'
import type { PrismaClient } from '../generated/prisma/client.ts'
import type { Environment } from '../config/env.ts'
import { authService } from '../modules/auth/service.ts'
import {
  COOKIE_NAME,
  SESSION_MS,
  sessionCookie,
} from '../modules/auth/security.ts'
import { customerService } from '../modules/users/service.ts'
import * as schemas from '../modules/users/schemas.ts'
import { settingsService } from '../modules/settings/service.ts'
import { wechatPaymentRoutes } from '../modules/settings/wechat-routes.ts'
import { ApiError } from './errors.ts'
import { supportRoutes } from '../modules/chat/routes.ts'
import { csrf, rateLimit } from './security.ts'
import {
  customerPurchaseRoutes,
  productSettingsRoutes,
  publicCatalogRoutes,
} from '../modules/products/routes.ts'
import {
  customerSubscriptionRoutes,
  subscriptionRoutes,
} from '../modules/subscriptions/routes.ts'
import {
  adminOrderRoutes,
  customerOrderRoutes,
} from '../modules/orders/routes.ts'

export function applicationRoutes(database: PrismaClient, env: Environment) {
  const router = Router()
  const auth = authService(database)
  const customers = customerService(database, env.APP_BASE_URL)
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: new URL(env.APP_BASE_URL).protocol === 'https:',
    path: '/',
  }
  const sessionCookieOptions = { ...cookieOptions, maxAge: SESSION_MS }
  const settings = settingsService(database)
  router.use(csrf(env.APP_BASE_URL))
  router.get('/storefront/config', async (_request, response) => {
    response.json(await settings.publicConfig())
  })
  router.use(
    '/catalog',
    publicCatalogRoutes(database, env.PRODUCT_COVER_STORAGE_DIR),
  )
  const authenticate: RequestHandler = async (request, response, next) => {
    const principal = await auth.resolve(
      sessionCookie(request.headers.cookie),
      // A valid pending customer's creation request gets the documented 403.
      // Every other route retains its existing ACTIVE-only authentication behavior.
      request.method === 'POST' &&
        request.baseUrl === '/api/v1/customer' &&
        /^\/orders\/?$/.test(request.path),
    )
    if (!principal) throw new ApiError(401, 'UNAUTHENTICATED', '请先登录')
    response.locals.principal = principal
    next()
  }
  router.post('/auth/register', rateLimit(5), async (request, response) => {
    if (await auth.resolve(sessionCookie(request.headers.cookie)))
      throw new ApiError(
        409,
        'ALREADY_AUTHENTICATED',
        '当前已登录，请先退出再注册',
      )
    const input = schemas.register.parse(request.body)
    const { token, user } = await auth.register(
      input.email,
      input.password,
      input.invitationToken,
    )
    response.cookie(COOKIE_NAME, token, sessionCookieOptions)
    response.status(201).json({ user })
  })
  router.post('/auth/login', rateLimit(30), async (request, response) => {
    const input = schemas.login.parse(request.body)
    const result = await auth.login(
      input.email,
      input.password,
      response.locals.requestId,
    )
    response.cookie(COOKIE_NAME, result.token, sessionCookieOptions)
    response.json({ user: result.user })
  })
  router.get('/auth/me', authenticate, (_request, response) => {
    response.json({ user: response.locals.principal.user })
  })
  router.use('/chat', authenticate, supportRoutes(database))
  router.post('/auth/logout', async (request, response) => {
    schemas.emptyBody.parse(request.body)
    await auth.logout(
      sessionCookie(request.headers.cookie),
      response.locals.requestId,
    )
    response.clearCookie(COOKIE_NAME, cookieOptions).sendStatus(204)
  })
  // Storefront routes use the Session owner and customer-safe permissions for either role.
  router.use(
    '/customer',
    authenticate,
    customerOrderRoutes(database, env.WECHAT_QR_STORAGE_DIR),
    customerPurchaseRoutes(database),
    customerSubscriptionRoutes(database),
  )
  // This guard covers implemented and future admin routes, including unknown paths.
  router.use(
    '/admin',
    authenticate,
    (_request, response, next) => {
      if (response.locals.principal.user.role !== 'ADMIN')
        throw new ApiError(403, 'FORBIDDEN', '仅管理员可以执行此操作')
      next()
    },
    (request, response, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next()
      return adminMutations(request, response, next)
    },
  )
  const adminMutations = rateLimit(120)
  router.use(
    '/admin',
    productSettingsRoutes(database, env.PRODUCT_COVER_STORAGE_DIR),
  )
  router.use('/admin', wechatPaymentRoutes(database, env.WECHAT_QR_STORAGE_DIR))
  router.use('/admin', subscriptionRoutes(database))
  router.use('/admin', adminOrderRoutes(database))
  router.get('/admin/users', async (request, response) => {
    response.json(
      await customers.list(schemas.listCustomers.parse(request.query)),
    )
  })
  router.post('/admin/users', async (request, response) => {
    response.status(201).json({
      user: await customers.create(
        schemas.createCustomer.parse(request.body),
        response.locals.principal.user.id,
        response.locals.requestId,
      ),
    })
  })
  router.get('/admin/users/:id', async (request, response) => {
    response.json({
      user: await customers.detail(schemas.id.parse(request.params.id)),
    })
  })
  router.patch('/admin/users/:id', async (request, response) => {
    response.json({
      user: await customers.edit(
        schemas.id.parse(request.params.id),
        schemas.editCustomer.parse(request.body),
        response.locals.principal.user.id,
        response.locals.requestId,
      ),
    })
  })
  router.patch('/admin/users/:id/status', async (request, response) => {
    response.json({
      user: await customers.status(
        schemas.id.parse(request.params.id),
        schemas.changeStatus.parse(request.body),
        response.locals.principal.user.id,
        response.locals.requestId,
      ),
    })
  })
  router.post('/admin/users/:id/invitations', async (request, response) => {
    schemas.emptyBody.parse(request.body)
    response
      .status(201)
      .json(
        await customers.issue(
          schemas.id.parse(request.params.id),
          response.locals.principal.user.id,
          response.locals.requestId,
        ),
      )
  })
  router.post('/admin/invitations/:id/revoke', async (request, response) => {
    schemas.emptyBody.parse(request.body)
    await customers.revoke(
      schemas.id.parse(request.params.id),
      response.locals.principal.user.id,
      response.locals.requestId,
    )
    response.sendStatus(204)
  })
  return router
}
