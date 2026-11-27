import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createApp } from '../../src/app.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../../src/modules/auth/security.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
let server: Server
let origin: string
let adminId: string
let admin: string
let customer: string
let customerId: string
let pending: string
let disabled: string

async function session(userId: string) {
  const raw = newToken()
  await db.session.create({
    data: {
      userId,
      tokenHash: tokenHash(raw),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
  return COOKIE_NAME + '=' + raw
}
async function call(
  path: string,
  cookie = '',
  method = 'GET',
  data?: unknown,
  csrf = true,
) {
  const response = await fetch(origin + '/api/v1' + path, {
    method,
    headers: {
      cookie,
      'content-type': 'application/json',
      ...(csrf
        ? { 'x-requested-with': 'MembershipStore', origin: env.APP_BASE_URL }
        : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  return {
    status: response.status,
    noStore: response.headers.get('cache-control'),
    body: await response.json(),
  }
}

before(async () => {
  const [adminUser, ...users] = await Promise.all([
    db.user.findFirstOrThrow({ where: { role: 'ADMIN' } }),
    ...(['ACTIVE', 'PENDING_ACTIVATION', 'DISABLED'] as const).map((status) =>
      db.user.create({
        data: {
          role: 'CUSTOMER',
          status,
          loginEmail: randomUUID() + '@example.com',
        },
      }),
    ),
  ])
  adminId = adminUser.id
  customerId = users[0]!.id
  ;[admin, customer, pending, disabled] = (await Promise.all(
    [adminUser, ...users].map((user) => session(user.id)),
  )) as [string, string, string, string]
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  origin = 'http://127.0.0.1:' + address.port
})
after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.$disconnect()
})

test('guidance requires an ACTIVE storefront session and has an exact no-store projection', async () => {
  for (const [cookie, status] of [
    ['', 401],
    [admin, 200],
    [pending, 401],
    [disabled, 401],
  ] as const)
    assert.equal(
      (await call('/customer/order-guidance', cookie)).status,
      status,
    )
  assert.equal(
    (await call('/customer/order-guidance?userId=other', customer)).status,
    400,
  )
  const settings = await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })
  const result = await call('/customer/order-guidance', customer)
  assert.equal(result.status, 200)
  assert.equal(result.noStore, 'no-store')
  assert.deepEqual(result.body, {
    storeName: settings.storeName,
    businessTimezone: settings.timezone,
    paymentInstructions: settings.paymentInstructions,
  })
})

test('ADMIN settings normalize newlines, enforce boundaries, save and clear without auditing instruction text', async () => {
  const path = '/admin/settings'
  const marker = '汇款说明 <b>按纯文本展示</b>'
  const normalized = marker + '\n第一行\n第二行\n'
  const full = normalized.padEnd(4000, '中')
  const input = { paymentInstructions: full.replaceAll('\n', '\r\n') }
  assert.equal((await call(path, customer, 'PATCH', input)).status, 403)
  assert.equal((await call(path, admin, 'PATCH', input, false)).status, 403)
  const saved = await call(path, admin, 'PATCH', input)
  assert.equal(saved.status, 200)
  assert.equal(saved.body.settings.paymentInstructions, full)
  assert.equal(
    (await call(path, admin)).body.settings.paymentInstructions,
    full,
  )
  assert.equal(
    (await call('/customer/order-guidance', customer)).body.paymentInstructions,
    full,
  )
  const audit = await db.adminAuditLog.findFirstOrThrow({
    where: { action: 'SETTINGS_UPDATED', actorAdminId: adminId },
    orderBy: { createdAt: 'desc' },
  })
  assert.deepEqual(audit.beforeJson, { timezone: saved.body.settings.timezone })
  assert.deepEqual(audit.afterJson, {
    fields: ['paymentInstructions'],
    timezone: saved.body.settings.timezone,
  })
  assert(!JSON.stringify(audit).includes(marker))

  const auditCount = await db.adminAuditLog.count()
  for (const data of [
    { paymentInstructions: 'x'.repeat(4001) },
    { paymentInstructions: null },
    { paymentInstructions: 1 },
    { paymentInstructions: 'text', unknown: true },
    { paymentInstructions: 'API key: fictional-secret-value' },
  ])
    assert.equal((await call(path, admin, 'PATCH', data)).status, 400)
  assert.equal(await db.adminAuditLog.count(), auditCount)
  assert.equal(
    (await call(path, admin)).body.settings.paymentInstructions,
    full,
  )
  assert.equal(
    (await call(path, admin, 'PATCH', { paymentInstructions: '' })).status,
    200,
  )
  assert.equal(
    (await call('/customer/order-guidance', customer)).body.paymentInstructions,
    '',
  )
})

test('customer projection exposes frozen forms while suppressing undeclared legacy values without changing administrator snapshots', async () => {
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Customer read fixture',
      priceFen: 1000,
      termLabel: 'Once',
      type: 'ONE_TIME',
    },
  })
  const cases = [
    {
      id: 'password',
      label: '密码',
      value: 'fictional legacy credential',
      exposed: true,
    },
    {
      id: 'account',
      label: '账号',
      value: 'password: fictional tagged credential',
      exposed: true,
    },
    {
      id: 'account',
      label: '账号',
      value: 'safe account',
      unexpected: true,
      exposed: false,
    },
    {
      id: 'account',
      label: '账号',
      value: 'safe account',
      defaultValue: 'Bearer synthetic-private-default',
      exposed: true,
    },
  ]
  for (const { id, label, value, unexpected, defaultValue, exposed } of cases) {
    const record = await db.order.create({
      data: {
        orderNo: 'T21-' + randomUUID().replaceAll('-', ''),
        source: 'ADMIN',
        createdByAdminId: adminId,
        userId: customerId,
        productId: product.id,
        kind: 'ONE_TIME',
        productNameSnapshot: product.name,
        productTypeSnapshot: 'ONE_TIME',
        termSnapshot: product.termLabel,
        amountFen: 1000,
        contactEmailSnapshot: 'fixture@example.com',
        formSchemaSnapshot: {
          version: 1,
          fields: [
            {
              id,
              label,
              type: 'text',
              required: true,
              ...(defaultValue ? { defaultValue } : {}),
            },
          ],
        },
        formData: {
          [id]: value,
          ...(unexpected ? { secret: 'unknown legacy key' } : {}),
        },
        targetIdentifier: value,
        internalNote: 'private fixture note',
      },
    })
    const path = '/customer/orders/' + record.id
    const { status, body } = await call(path, customer)
    assert.equal(status, 200)
    if (exposed) {
      assert.equal(body.order.formSchemaSnapshot.fields[0].label, label)
      assert.deepEqual(body.order.formData, record.formData)
      assert.equal(body.order.targetIdentifier, value)
    } else {
      assert.equal(body.order.formSchemaSnapshot, null)
      assert.equal(body.order.formData, null)
      assert.equal(body.order.targetIdentifier, null)
    }
    assert(!('internalNote' in body.order))
    assert(!('creator' in body.order))
    const list = await call(
      '/customer/orders?search=' + record.orderNo,
      customer,
    )
    assert.equal(list.body.total, 1)
    assert.deepEqual(
      list.body.items.map((item: { formData: unknown }) => item.formData),
      [exposed ? record.formData : null],
    )
    const raw = await call('/admin/orders/' + record.id, admin)
    assert.deepEqual(raw.body.order.formData, record.formData)
    assert.deepEqual(
      raw.body.order.formSchemaSnapshot,
      record.formSchemaSnapshot,
    )
  }
})
