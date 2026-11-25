import { after, afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../src/app.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import { integrationEnvironment } from './support.ts'
import {
  tokenHash,
  COOKIE_NAME,
  SESSION_MS,
  INVITATION_MS,
  verifyPassword,
} from '../../src/modules/auth/security.ts'
import { customerService } from '../../src/modules/users/service.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
let server: Server
let base: string
let adminCookie = ''
let adminId: string
const customerPassword = 'FictionalCustomerPassword2468!'
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = adminCookie,
  idempotencyKey?: string,
) {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return {
    response,
    status: response.status,
    body: text ? JSON.parse(text) : null,
  }
}
const cookieOf = (response: Response) =>
  response.headers.get('set-cookie')!.split(';')[0]
const rawToken = (cookie: string) => cookie.slice(COOKIE_NAME.length + 1)
const newEmail = () => randomUUID() + '@example.com'
async function customer(adminLabel = '客户-' + randomUUID()) {
  const result = await request('/admin/users', 'POST', {
    adminLabel,
  })
  assert.equal(result.status, 201)
  return result.body.user
}
async function issue(userId: string) {
  const result = await request(
    '/admin/users/' + userId + '/invitations',
    'POST',
    {},
  )
  assert.equal(result.status, 201)
  return { ...result.body, token: new URL(result.body.url).hash.slice(1) }
}
beforeEach(async () => {
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  base = 'http://127.0.0.1:' + address.port
  const login = await request(
    '/auth/login',
    'POST',
    { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
    '',
  )
  assert.equal(login.status, 200)
  adminCookie = cookieOf(login.response)
  adminId = login.body.user.id
})
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
})
after(() => db.$disconnect())

test('all admin routes require a database session, even unimplemented routes', async () => {
  for (const path of [
    '/admin/users',
    '/admin/users/' + randomUUID(),
    '/admin/products',
    '/admin/orders',
    '/admin/subscriptions',
    '/admin/settings',
    '/admin/unknown',
  ])
    assert.equal((await request(path, 'GET', undefined, '')).status, 401)
  assert.equal((await request('/auth/me', 'GET', undefined, '')).status, 401)
  assert.equal((await request('/auth/register', 'POST', {}, '')).status, 400)
  assert.equal((await request('/admin/products')).status, 200)
  assert.equal((await request('/admin/orders', 'POST', {})).status, 400)
  assert.equal((await request('/admin/unknown')).status, 404)
})

test('admin login stores only a hash, rotates tokens and emits safe cookie/me responses', async () => {
  const result = await request(
    '/auth/login',
    'POST',
    {
      email: ' ' + env.ADMIN_EMAIL.toUpperCase() + ' ',
      password: env.ADMIN_PASSWORD,
    },
    '',
  )
  assert.equal(result.status, 200)
  const cookie = result.response.headers.get('set-cookie')!
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Strict/i)
  assert.match(cookie, /Path=\//i)
  assert.match(cookie, /Max-Age=43200/i)
  assert.doesNotMatch(cookie, /; Secure/i)
  const token = rawToken(cookieOf(result.response))
  assert.notEqual(token, rawToken(adminCookie))
  const session = await db.session.findUniqueOrThrow({
    where: { tokenHash: tokenHash(token) },
  })
  assert.notEqual(session.tokenHash, token)
  assert.ok(session.expiresAt.getTime() - Date.now() <= SESSION_MS)
  assert.ok(session.expiresAt.getTime() - Date.now() > SESSION_MS - 10000)
  assert.equal(result.body.user.role, 'ADMIN')
  assert.equal(JSON.stringify(result.body).includes('passwordHash'), false)
  assert.equal(JSON.stringify(result.body).includes('token'), false)
  assert.equal((await request('/auth/me')).body.user.id, adminId)
})

test('logout revokes the current session; revoked and expired sessions are rejected', async () => {
  const login = await request(
    '/auth/login',
    'POST',
    { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
    '',
  )
  const cookie = cookieOf(login.response)
  assert.equal((await request('/auth/logout', 'POST', {}, cookie)).status, 204)
  assert.equal((await request('/auth/logout', 'POST', {}, cookie)).status, 204)
  assert.equal(
    (await request('/auth/me', 'GET', undefined, cookie)).status,
    401,
  )
  assert.ok(
    (
      await db.session.findUniqueOrThrow({
        where: { tokenHash: tokenHash(rawToken(cookie)) },
      })
    ).revokedAt,
  )
  const second = cookieOf(
    (
      await request(
        '/auth/login',
        'POST',
        { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
        '',
      )
    ).response,
  )
  await db.session.update({
    where: { tokenHash: tokenHash(rawToken(second)) },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  assert.equal(
    (await request('/auth/me', 'GET', undefined, second)).status,
    401,
  )
})

test('incorrect, unknown, disabled and pending accounts fail login without account enumeration', async () => {
  const wrong = await request(
    '/auth/login',
    'POST',
    { email: env.ADMIN_EMAIL, password: customerPassword },
    '',
  )
  const unknown = await request(
    '/auth/login',
    'POST',
    { email: 'missing@example.com', password: customerPassword },
    '',
  )
  const pending = await request(
    '/auth/login',
    'POST',
    { email: newEmail(), password: customerPassword },
    '',
  )
  for (const result of [wrong, unknown, pending]) {
    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'INVALID_CREDENTIALS')
    assert.equal(JSON.stringify(result.body).includes(customerPassword), false)
  }
})

test('multiple customers can be created with only an admin label and no credentials', async () => {
  const users = await Promise.all([customer(), customer()])
  assert.notEqual(users[0].id, users[1].id)
  for (const user of users) {
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.equal(stored.status, 'PENDING_ACTIVATION')
    assert.equal(stored.role, 'CUSTOMER')
    for (const field of [
      'loginEmail',
      'notificationEmail',
      'passwordHash',
      'activatedAt',
    ] as const)
      assert.equal(stored[field], null)
    const list = await request(
      '/admin/users?search=' + encodeURIComponent(user.adminLabel),
    )
    assert.equal(list.body.total, 1)
    assert.equal(list.body.items[0].id, user.id)
    assert.equal(JSON.stringify(list.body).includes('passwordHash'), false)
    assert.equal(
      (await request('/admin/users/' + user.id)).body.user.loginEmail,
      null,
    )
  }
  for (const field of [
    'loginEmail',
    'notificationEmail',
    'password',
    'passwordHash',
    'role',
    'status',
  ])
    assert.equal(
      (
        await request('/admin/users', 'POST', {
          adminLabel: '注入',
          [field]: 'forbidden',
        })
      ).status,
      400,
    )
  const unlabelled = await request('/admin/users/' + users[0].id, 'PATCH', {
    adminLabel: null,
  })
  assert.equal(unlabelled.status, 200)
  const unfiltered = await request('/admin/users?pageSize=100')
  assert.ok(
    unfiltered.body.items.some(
      (profile: { id: string }) => profile.id === users[0].id,
    ),
  )
  assert.equal((await request('/admin/users', 'POST', {})).status, 400)
  assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 1)
})

test('customer editing is limited to profile fields and admin changes are audited without secrets', async () => {
  const user = await customer()
  const result = await request('/admin/users/' + user.id, 'PATCH', {
    adminLabel: '更新姓名',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.user.notificationEmail, null)
  const notification = await request('/admin/users/' + user.id, 'PATCH', {
    notificationEmail: 'notice@example.com',
  })
  assert.equal(notification.body.error.code, 'CUSTOMER_NOT_CLAIMED')
  for (const input of [
    { loginEmail: 'changed@example.com' },
    { password: customerPassword },
    { role: 'ADMIN' },
  ])
    assert.equal(
      (await request('/admin/users/' + user.id, 'PATCH', input)).status,
      400,
    )
  const logs = await db.adminAuditLog.findMany({
    where: { entityId: user.id },
    select: { action: true, afterJson: true },
  })
  assert.deepEqual(logs.map((log) => log.action).sort(), [
    'CUSTOMER_CREATED',
    'CUSTOMER_UPDATED',
  ])
  const serialized = JSON.stringify(logs)
  assert.equal(serialized.includes('notice@example.com'), false)
  assert.equal(serialized.includes(customerPassword), false)
  assert.equal((await request('/admin/users/' + adminId)).status, 404)
})

test('invitation is hash-only, expires in seven days and raw URL is not available from reads', async () => {
  const user = await customer()
  const created = await issue(user.id)
  const record = await db.invitationToken.findUniqueOrThrow({
    where: { id: created.invitation.id },
  })
  assert.equal(record.tokenHash, tokenHash(created.token))
  assert.notEqual(record.tokenHash, created.token)
  assert.ok(
    Math.abs(
      record.expiresAt.getTime() - record.createdAt.getTime() - INVITATION_MS,
    ) < 1000,
  )
  const detail = await request('/admin/users/' + user.id)
  const body = JSON.stringify(detail.body)
  assert.equal(body.includes(created.token), false)
  assert.equal(body.includes(record.tokenHash), false)
  assert.equal(body.includes('tokenHash'), false)
  assert.equal(new URL(created.url).origin, new URL(env.APP_BASE_URL).origin)
  assert.equal(new URL(created.url).pathname, '/activate')
  assert.equal(new URL(created.url).search, '')
})

test('reissuing, revoking and expiry invalidate activation without changing the pending account', async () => {
  const user = await customer()
  const old = await issue(user.id)
  const current = await issue(user.id)
  assert.ok(
    (
      await db.invitationToken.findUniqueOrThrow({
        where: { id: old.invitation.id },
      })
    ).revokedAt,
  )
  assert.equal(
    (
      await request(
        '/auth/register',
        'POST',
        {
          invitationToken: old.token,
          email: newEmail(),
          password: customerPassword,
        },
        '',
      )
    ).status,
    409,
  )
  assert.equal(
    (
      await request(
        '/admin/invitations/' + current.invitation.id + '/revoke',
        'POST',
        {},
      )
    ).status,
    204,
  )
  assert.equal(
    (
      await request(
        '/auth/register',
        'POST',
        {
          invitationToken: current.token,
          email: newEmail(),
          password: customerPassword,
        },
        '',
      )
    ).status,
    409,
  )
  const expired = await issue(user.id)
  await db.invitationToken.update({
    where: { id: expired.invitation.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  assert.equal(
    (
      await request(
        '/auth/register',
        'POST',
        {
          invitationToken: expired.token,
          email: newEmail(),
          password: customerPassword,
        },
        '',
      )
    ).status,
    409,
  )
  const account = await db.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(account.status, 'PENDING_ACTIVATION')
  assert.equal(account.passwordHash, null)
})

test('only one concurrent activation succeeds, password is Argon2id and customer cannot access any admin/customer data routes', async () => {
  const user = await customer()
  const invitation = await issue(user.id)
  const email = newEmail()
  const results = await Promise.all(
    [1, 2].map(() =>
      request(
        '/auth/register',
        'POST',
        {
          invitationToken: invitation.token,
          email: ' ' + email.toUpperCase() + ' ',
          password: customerPassword,
        },
        '',
      ),
    ),
  )
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409])
  const account = await db.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(account.status, 'ACTIVE')
  assert.ok(account.activatedAt)
  assert.ok(account.passwordHash?.startsWith('$argon2id$'))
  assert.equal(
    await verifyPassword(account.passwordHash!, customerPassword),
    true,
  )
  assert.ok(
    (
      await db.invitationToken.findUniqueOrThrow({
        where: { id: invitation.invitation.id },
      })
    ).usedAt,
  )
  const successful = results.find((result) => result.status === 201)!
  assert.equal(successful.body.user.id, user.id)
  assert.equal(successful.body.user.loginEmail, email)
  assert.equal('adminLabel' in successful.body.user, false)
  assert.equal('passwordHash' in successful.body.user, false)
  assert.equal(await db.session.count({ where: { userId: user.id } }), 1)
  const notification = await request('/admin/users/' + user.id, 'PATCH', {
    notificationEmail: ' Notice@Example.com ',
  })
  assert.equal(notification.status, 200)
  assert.equal(notification.body.user.notificationEmail, 'notice@example.com')
  const cookie = cookieOf(successful.response)
  assert.equal(
    (await request('/auth/me', 'GET', undefined, cookie)).body.user.id,
    user.id,
  )
  for (const path of [
    '/admin/users',
    '/admin/users/' + adminId,
    '/admin/products',
    '/admin/orders',
    '/admin/subscriptions',
  ])
    assert.equal((await request(path, 'GET', undefined, cookie)).status, 403)
  assert.equal(
    (await request('/me/orders/' + randomUUID(), 'GET', undefined, cookie))
      .status,
    404,
  )
  assert.equal(
    (
      await request(
        '/me/subscriptions/' + randomUUID(),
        'GET',
        undefined,
        cookie,
      )
    ).status,
    404,
  )
  assert.equal(
    (await request('/admin/users/' + user.id + '/invitations', 'POST', {}))
      .status,
    409,
  )
})

test('disable revokes sessions/invitations; restore preserves activation status and existing entitlement history', async () => {
  const user = await customer()
  const invitation = await issue(user.id)
  const email = newEmail()
  const registered = await request(
    '/auth/register',
    'POST',
    { invitationToken: invitation.token, email, password: customerPassword },
    '',
  )
  assert.equal(registered.status, 201)
  const cookie = cookieOf(registered.response)
  const oldHash = (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
    .passwordHash
  const disable = await request(
    '/admin/users/' + user.id + '/status',
    'PATCH',
    { disabled: true, reason: '停用测试' },
  )
  assert.equal(disable.body.user.status, 'DISABLED')
  assert.equal(
    (await request('/auth/me', 'GET', undefined, cookie)).status,
    401,
  )
  assert.equal(
    (
      await request(
        '/auth/login',
        'POST',
        { email, password: customerPassword },
        '',
      )
    ).status,
    401,
  )
  const restore = await request(
    '/admin/users/' + user.id + '/status',
    'PATCH',
    { disabled: false, reason: '恢复测试' },
  )
  assert.equal(restore.body.user.status, 'ACTIVE')
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash,
    oldHash,
  )
  assert.equal(
    (await request('/auth/me', 'GET', undefined, cookie)).status,
    401,
  )
  const pending = await customer()
  const unused = await issue(pending.id)
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Auth preservation fixture',
      type: 'SUBSCRIPTION',
      priceFen: 1000,
      renewalPriceFen: 1000,
      termLabel: 'Fixture term',
      servicePeriodUnit: 'DAY',
      servicePeriodCount: 30,
    },
  })
  const frozen = {
    userId: pending.id,
    productId: product.id,
    productNameSnapshot: product.name,
    productTypeSnapshot: product.type,
    priceSnapshotFen: product.priceFen,
    termSnapshot: product.termLabel,
    servicePeriodUnitSnapshot: product.servicePeriodUnit,
    servicePeriodCountSnapshot: product.servicePeriodCount,
    createdByAdminId: adminId,
  }
  await db.order.create({
    data: {
      ...frozen,
      source: 'ADMIN',
      kind: 'INITIAL',
      orderNo: 'AUTH-' + randomUUID().replaceAll('-', ''),
      amountFen: product.priceFen,
      renewalPriceSnapshotFen: product.renewalPriceFen,
      contactEmailSnapshot: pending.loginEmail,
    },
  })
  await db.subscription.create({
    data: {
      ...frozen,
      sourceType: 'ADMIN',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      renewalPriceFen: 1000,
    },
  })
  await request('/admin/users/' + pending.id + '/status', 'PATCH', {
    disabled: true,
    reason: '停用未激活客户',
  })
  await request('/admin/users/' + pending.id + '/status', 'PATCH', {
    disabled: false,
    reason: '恢复未激活客户',
  })
  assert.equal(
    (await request('/admin/users/' + pending.id)).body.user.status,
    'PENDING_ACTIVATION',
  )
  assert.equal(
    (
      await request(
        '/auth/register',
        'POST',
        {
          invitationToken: unused.token,
          email: newEmail(),
          password: customerPassword,
        },
        '',
      )
    ).status,
    409,
  )
  // The exact customer whose state changed retains its order and entitlement.
  const pendingOwner = await db.user.findUniqueOrThrow({
    where: { id: pending.id },
    include: { _count: { select: { orders: true, subscriptions: true } } },
  })
  assert.equal(pendingOwner.status, 'PENDING_ACTIVATION')
  assert.deepEqual(pendingOwner._count, { orders: 1, subscriptions: 1 })
  assert.equal(
    (await request('/admin/users/' + pendingOwner.id)).body.user._count
      .subscriptions,
    pendingOwner._count.subscriptions,
  )
})

test('simultaneous invitation reissues leave exactly one valid token', async () => {
  const user = await customer()
  const invitations = await Promise.all([issue(user.id), issue(user.id)])
  const valid = await db.invitationToken.findMany({
    where: {
      userId: user.id,
      usedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  })
  assert.equal(valid.length, 1)
  const results = await Promise.all(
    invitations.map((invitation) =>
      request(
        '/auth/register',
        'POST',
        {
          invitationToken: invitation.token,
          email: newEmail(),
          password: customerPassword,
        },
        '',
      ),
    ),
  )
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409])
})

test('activation racing disable never leaves an active disabled account or reusable invitation', async () => {
  const user = await customer()
  const invitation = await issue(user.id)
  const results = await Promise.all([
    request(
      '/auth/register',
      'POST',
      {
        invitationToken: invitation.token,
        email: newEmail(),
        password: customerPassword,
      },
      '',
    ),
    request('/admin/users/' + user.id + '/status', 'PATCH', {
      disabled: true,
      reason: '并发停用测试',
    }),
  ])
  assert.equal(results[1].status, 200)
  assert.ok([201, 409].includes(results[0].status))
  if (results[0].status === 201)
    assert.equal(
      (
        await request(
          '/auth/me',
          'GET',
          undefined,
          cookieOf(results[0].response),
        )
      ).status,
      401,
    )
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).status,
    'DISABLED',
  )
  assert.equal(
    (
      await request(
        '/auth/register',
        'POST',
        {
          invitationToken: invitation.token,
          email: newEmail(),
          password: customerPassword,
        },
        '',
      )
    ).status,
    409,
  )
})

test('revocation and invitation registration serialize without accepting a revoked token', async () => {
  const profile = await customer()
  const invite = await issue(profile.id)
  const requestBody = {
    invitationToken: invite.token,
    email: newEmail(),
    password: customerPassword,
  }
  const [claimed, revoked] = await Promise.all([
    request('/auth/register', 'POST', requestBody, ''),
    request(
      '/admin/invitations/' + invite.invitation.id + '/revoke',
      'POST',
      {},
    ),
  ])
  assert.deepEqual(
    [claimed.status, revoked.status],
    claimed.status === 201 ? [201, 409] : [409, 204],
  )
  const stored = await db.invitationToken.findUniqueOrThrow({
    where: { id: invite.invitation.id },
  })
  assert.equal(Boolean(stored.usedAt), claimed.status === 201)
  assert.equal(Boolean(stored.revokedAt), revoked.status === 204)
  const retry = await request('/auth/register', 'POST', requestBody, '')
  assert.equal(retry.body.error.code, 'INVITATION_INVALID')
})

test('reissuing and invitation registration cannot both succeed against the old invitation', async () => {
  const profile = await customer()
  const invite = await issue(profile.id)
  const requestBody = {
    invitationToken: invite.token,
    email: newEmail(),
    password: customerPassword,
  }
  const [claimed, reissued] = await Promise.all([
    request('/auth/register', 'POST', requestBody, ''),
    request('/admin/users/' + profile.id + '/invitations', 'POST', {}),
  ])
  assert.deepEqual(
    [claimed.status, reissued.status],
    claimed.status === 201 ? [201, 409] : [409, 201],
  )
  if (reissued.status === 201) {
    assert.equal(claimed.body.error.code, 'INVITATION_INVALID')
    assert.equal(
      (
        await request(
          '/auth/register',
          'POST',
          {
            ...requestBody,
            invitationToken: new URL(reissued.body.url).hash.slice(1),
          },
          '',
        )
      ).status,
      201,
    )
  }
  assert.equal(
    await db.session.count({ where: { userId: profile.id, revokedAt: null } }),
    1,
  )
})

test('audit failure leaves no partial customer profile', async () => {
  const adminLabel = '回滚-' + randomUUID()
  await assert.rejects(
    customerService(db, env.APP_BASE_URL).create(
      { adminLabel },
      adminId,
      'x'.repeat(100),
    ),
  )
  assert.equal(await db.user.count({ where: { adminLabel } }), 0)
})

test('duplicate email and an existing session leave the invitation available for retry', async () => {
  const user = await customer()
  const invitation = await issue(user.id)
  const attempt = (email: string, cookie = '') =>
    request(
      '/auth/register',
      'POST',
      { invitationToken: invitation.token, email, password: customerPassword },
      cookie,
    )
  const signedIn = await attempt(newEmail(), adminCookie)
  assert.equal(signedIn.body.error.code, 'ALREADY_AUTHENTICATED')
  const duplicate = await attempt(env.ADMIN_EMAIL.toUpperCase())
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.body.error.code, 'EMAIL_EXISTS')
  assert.equal(duplicate.response.headers.get('set-cookie'), null)
  const pending = await db.user.findUniqueOrThrow({ where: { id: user.id } })
  assert.equal(pending.status, 'PENDING_ACTIVATION')
  assert.equal(pending.loginEmail, null)
  assert.equal(pending.passwordHash, null)
  assert.equal(await db.session.count({ where: { userId: user.id } }), 0)
  assert.equal(
    (
      await db.invitationToken.findUniqueOrThrow({
        where: { id: invitation.invitation.id },
      })
    ).usedAt,
    null,
  )
  assert.equal((await attempt(newEmail())).status, 201)
})

test('orders and subscriptions created for an unbound profile stay visible to its new session', async () => {
  const user = await customer()
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: '邀请注册测试商品',
      type: 'SUBSCRIPTION',
      priceFen: 100,
      renewalPriceFen: 100,
      termLabel: '月',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
    },
  })
  const createdOrder = await request(
    '/admin/orders',
    'POST',
    {
      userId: user.id,
      productId: product.id,
      amountFen: 100,
      formData: {},
    },
    adminCookie,
    randomUUID(),
  )
  assert.equal(createdOrder.status, 201, JSON.stringify(createdOrder.body))
  const orderId = createdOrder.body.order.id
  assert.equal(createdOrder.body.order.contactEmailSnapshot, null)
  const revision = await db.orderRevision.findFirstOrThrow({
    where: { orderId },
  })
  assert.equal(
    (revision.snapshotJson as { order: { contactEmailSnapshot: unknown } })
      .order.contactEmailSnapshot,
    null,
  )
  const createdSubscription = await request('/admin/subscriptions', 'POST', {
    userId: user.id,
    productId: product.id,
    renewalPriceFen: 100,
    formData: {},
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  })
  assert.equal(
    createdSubscription.status,
    201,
    JSON.stringify(createdSubscription.body),
  )
  const subscriptionId = createdSubscription.body.subscription.id
  const invite = await issue(user.id)
  const result = await request(
    '/auth/register',
    'POST',
    {
      invitationToken: invite.token,
      email: newEmail(),
      password: customerPassword,
    },
    '',
  )
  assert.equal(result.status, 201)
  assert.equal(result.body.user.id, user.id)
  const cookie = cookieOf(result.response)
  const ownedOrder = await request(
    '/customer/orders/' + orderId,
    'GET',
    undefined,
    cookie,
  )
  assert.equal(ownedOrder.status, 200)
  assert.equal(ownedOrder.body.order.contactEmailSnapshot, null)
  assert.equal(
    (
      await request(
        '/customer/subscriptions/' + subscriptionId,
        'GET',
        undefined,
        cookie,
      )
    ).status,
    200,
  )
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: user.id } })).adminLabel,
    user.adminLabel,
  )
})

test('CSRF, malformed input and oversized requests are rejected without echoing secrets', async () => {
  const response = await fetch(base + '/api/v1/admin/users', {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
      origin: 'http://evil.example',
      'x-requested-with': 'MembershipStore',
    },
    body: JSON.stringify({ password: customerPassword }),
  })
  assert.equal(response.status, 403)
  assert.equal((await response.text()).includes(customerPassword), false)
  const malformed = await fetch(base + '/api/v1/auth/login', {
    method: 'POST',
    headers: {
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
    },
    body: '{"password":"' + customerPassword + '"',
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.text()).includes(customerPassword), false)
  assert.equal(
    (
      await request(
        '/auth/login',
        'POST',
        { email: env.ADMIN_EMAIL, password: 'x'.repeat(131_072) },
        '',
      )
    ).status,
    413,
  )
})
