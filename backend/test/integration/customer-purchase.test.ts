import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { after, before, test } from 'node:test'
import { createApp } from '../../src/app.ts'
import { checkDatabase, createDatabase } from '../../src/db/client.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../../src/modules/auth/security.ts'
import { purchaseSchema } from './purchase-fixture.ts'
import { activeCredentials, integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const updatedAt = new Date('2026-11-21T10:00:00.123Z')
const display = {
  slug: 'purchase-available',
  name: 'Purchase fixture',
  description: 'Customer-facing product information',
  type: 'SUBSCRIPTION',
  priceFen: 9900,
  renewalPriceFen: 8800,
  termLabel: '按月',
  servicePeriodUnit: 'MONTH',
  servicePeriodCount: 1,
} as const
let server: Server
let origin: string
let productId: string
let active: string
let pending: string
let disabled: string
let expired: string
let revoked: string
let admin: string

async function session(userId: string, expiresAt: Date, revokedAt?: Date) {
  const token = newToken()
  await db.session.create({
    data: { userId, tokenHash: tokenHash(token), expiresAt, revokedAt },
  })
  return COOKIE_NAME + '=' + token
}

before(async () => {
  const configured = {
    ...display,
    listed: true,
    formSchema: purchaseSchema,
    updatedAt,
  }
  const product = await db.product.create({ data: configured })
  productId = product.id
  await db.product.createMany({
    data: [
      { ...configured, slug: 'purchase-unlisted', listed: false },
      { ...configured, slug: 'purchase-archived', archivedAt: updatedAt },
      {
        ...configured,
        slug: 'purchase-credential',
        formSchema: {
          version: 1,
          fields: [
            {
              id: 'password',
              label: '禁止展示的配置',
              type: 'text',
              required: true,
            },
          ],
        },
      },
      {
        ...configured,
        slug: 'purchase-malformed',
        formSchema: {
          version: 1,
          fields: [{ id: 'privateFixture', type: 'obsolete' }],
        },
      },
    ],
  })
  const owner = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const [customer, inactive, blocked] = await Promise.all(
    (['ACTIVE', 'PENDING_ACTIVATION', 'DISABLED'] as const).map(
      async (status) =>
        db.user.create({
          data: {
            role: 'CUSTOMER',
            status,
            ...(status === 'ACTIVE' ? await activeCredentials() : {}),
            loginEmail: status.toLowerCase() + '@purchase.example',
          },
        }),
    ),
  )
  const future = new Date(Date.now() + 3_600_000)
  admin = await session(owner.id, future)
  active = await session(customer!.id, future)
  pending = await session(inactive!.id, future)
  disabled = await session(blocked!.id, future)
  expired = await session(customer!.id, new Date(Date.now() - 1000))
  revoked = await session(customer!.id, future, new Date())
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = 'http://127.0.0.1:' + address.port
})

after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  await db.$disconnect()
})

async function read(slug: string, cookie = active) {
  const response = await fetch(origin + '/api/v1/customer/products/' + slug, {
    headers: { cookie },
  })
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: await response.json(),
  }
}

test('purchase access requires an ACTIVE account with a valid Session', async () => {
  for (const [label, cookie, status] of [
    ['guest', '', 401],
    ['pending', pending, 401],
    ['disabled', disabled, 401],
    ['expired', expired, 401],
    ['revoked', revoked, 401],
  ] as const) {
    const result = await read(display.slug, cookie)
    assert.equal(result.status, status, label)
    assert.equal(result.body.error.code, 'UNAUTHENTICATED', label)
  }
  const result = await read(display.slug, admin)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, (await read(display.slug)).body)
})

test('purchase reads the exact fields, strips defaults and preserves the eight ordered field types', async () => {
  const result = await read(display.slug)
  assert.equal(result.status, 200)
  assert.equal(result.cache, 'no-store')
  const fields = purchaseSchema.fields.map(({ defaultValue, ...field }) => {
    assert.notEqual(defaultValue, undefined)
    return field
  })
  assert.deepEqual(result.body, {
    ...display,
    coverImageUrl: null,
    id: productId,
    updatedAt: '2026-11-21T10:00:00.123Z',
    formSchema: { version: 1, fields },
  })
})

test('purchase re-reads current display and form values from the database', async () => {
  const updated = await db.product.update({
    where: { id: productId },
    data: { priceFen: 7999, formSchema: { version: 1, fields: [] } },
  })
  const result = await read(display.slug)
  assert.equal(result.status, 200)
  assert.equal(result.body.priceFen, 7999)
  assert.deepEqual(result.body.formSchema, { version: 1, fields: [] })
  assert.equal(result.body.updatedAt, updated.updatedAt.toISOString())
})

test('missing, unlisted and archived purchases have identical 404 responses', async () => {
  for (const slug of [
    'purchase-missing',
    'purchase-unlisted',
    'purchase-archived',
  ]) {
    const result = await read(slug)
    assert.equal(result.status, 404)
    const { requestId, ...error } = result.body.error
    assert.equal(typeof requestId, 'string')
    assert.deepEqual(error, { code: 'NOT_FOUND', message: '商品不存在' })
  }
})

test('credential-labeled fields stay purchasable while malformed historical forms return a sanitized 409', async () => {
  const purchasable = await read('purchase-credential')
  assert.equal(purchasable.status, 200)
  assert.equal(purchasable.body.formSchema.fields[0].label, '禁止展示的配置')
  const result = await read('purchase-malformed')
  assert.equal(result.status, 409)
  const { requestId, ...error } = result.body.error
  assert.equal(typeof requestId, 'string')
  assert.deepEqual(error, {
    code: 'PRODUCT_FORM_UNAVAILABLE',
    message: '此商品的服务表单暂不可用',
  })
  assert.deepEqual(Object.keys(result.body), ['error'])
})
