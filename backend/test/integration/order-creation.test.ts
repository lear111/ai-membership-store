import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { Server } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import {
  formDataAtLimit,
  formSchemaAtLimit,
  jsonBytes,
} from '../long-text-fixture.ts'
import { createApp } from '../../src/app.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import type {
  Prisma,
  Product,
  User,
} from '../../src/generated/prisma/client.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../../src/modules/auth/security.ts'
import { buildOrderSnapshot } from '../../src/modules/orders/revisions.ts'
import { activeCredentials, integrationEnvironment } from './support.ts'
import { businessSnapshot } from './order-source-support.ts'

const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
let server: Server,
  base: string,
  admin: User,
  alice: User,
  bob: User,
  pending: User,
  disabled: User
const cookies: Record<string, string> = {}
const form = {
  version: 1,
  fields: [
    {
      id: 'account',
      type: 'text',
      label: 'Account identifier',
      required: true,
      hint: '',
    },
    {
      id: 'note',
      type: 'textarea',
      label: 'Optional note',
      required: false,
      hint: '',
    },
  ],
}
async function session(
  userId: string,
  extra: Partial<Prisma.SessionUncheckedCreateInput> = {},
) {
  const token = newToken()
  await db.session.create({
    data: {
      userId,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
      ...extra,
    },
  })
  return COOKIE_NAME + '=' + token
}
async function product(extra: Partial<Prisma.ProductCreateInput> = {}) {
  return db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Creation fixture',
      description: 'Frozen description',
      type: 'SUBSCRIPTION',
      priceFen: 12900,
      renewalPriceFen: 9900,
      termLabel: 'Display label only',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
      listed: true,
      formSchema: form,
      ...extra,
    },
  })
}
const commonBody = (p: Product) => ({
  productId: p.id,
  formData: { account: 'non-sensitive-account' },
})
const body = (p: Product) => ({
  ...commonBody(p),
  expectedProductUpdatedAt: p.updatedAt.toISOString(),
})
const adminBody = (p: Product) => ({
  ...commonBody(p),
  userId: alice.id,
  amountFen: p.priceFen,
})
async function request(
  role: 'customer' | 'admin',
  input: unknown,
  key: string | null = randomUUID(),
  cookie = cookies[role],
  method = 'POST',
  suffix = '',
) {
  const response = await fetch(base + '/api/v1/' + role + '/orders' + suffix, {
    method,
    headers: {
      cookie,
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
      ...(key === null ? {} : { 'Idempotency-Key': key }),
    },
    body: method === 'GET' ? undefined : JSON.stringify(input),
  })
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  }
}
async function snapshot(): Promise<Record<string, unknown[]>> {
  return {
    ...(await businessSnapshot(db)),
    OrderRevision: await db.orderRevision.findMany({ orderBy: { id: 'asc' } }),
  }
}
async function rejected(
  action: () => ReturnType<typeof request>,
  status: number,
  code?: string,
) {
  const before = await snapshot()
  const result = await action()
  assert.equal(result.status, status, JSON.stringify(result.body))
  if (code) assert.equal(result.body.error.code, code)
  assert(
    isDeepStrictEqual(await snapshot(), before),
    'Rejected request changed business records',
  )
}
function sql(input: string) {
  // Only the random runner-owned container; passwords stay in its environment.
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      process.env.FOUNDATION_DB_TEST + '-mysql-1',
      'sh',
      '-c',
      'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql --user=root --database=foundation_test',
    ],
    { input, encoding: 'utf8', stdio: 'pipe', timeout: 10000 },
  )
}
before(async () => {
  admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const user = async (status: User['status'], name: string) =>
    db.user.create({
      data: {
        role: 'CUSTOMER',
        status,
        ...(status === 'ACTIVE' ? await activeCredentials() : {}),
        loginEmail: randomUUID() + '@example.com',
        username: name,
        notificationEmail: name + '-notify@example.com',
        adminLabel: 'PRIVATE_LABEL',
      },
    })
  alice = await user('ACTIVE', 'Alice')
  bob = await user('ACTIVE', 'Bob')
  pending = await user('PENDING_ACTIVATION', 'Pending')
  disabled = await user('DISABLED', 'Disabled')
  cookies.admin = await session(admin.id)
  cookies.customer = await session(alice.id)
  cookies.bob = await session(bob.id)
  cookies.pending = await session(pending.id)
  cookies.disabled = await session(disabled.id)
  cookies.expired = await session(alice.id, {
    expiresAt: new Date(Date.now() - 1000),
  })
  cookies.revoked = await session(alice.id, { revokedAt: new Date() })
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  base = 'http://127.0.0.1:' + address.port
})
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    )
  await db.$disconnect()
})

test('creation enforces persisted Session, role, ACTIVE self-order eligibility and CSRF', async () => {
  const p = await product()
  for (const role of ['customer', 'admin'] as const) {
    const input = role === 'admin' ? adminBody(p) : body(p)
    for (const cookie of [
      '',
      COOKIE_NAME + '=invalid',
      cookies.disabled,
      cookies.expired,
      cookies.revoked,
    ])
      await rejected(() => request(role, input, randomUUID(), cookie), 401)
    if (role === 'admin')
      await rejected(
        () => request(role, input, randomUUID(), cookies.customer),
        403,
      )
  }
  await rejected(
    () => request('customer', body(p), randomUUID(), cookies.pending),
    403,
    'ACCOUNT_NOT_ELIGIBLE',
  )
  const response = await fetch(base + '/api/v1/customer/orders', {
    method: 'POST',
    headers: { cookie: cookies.customer, 'content-type': 'application/json' },
    body: JSON.stringify(body(p)),
  })
  assert.equal(response.status, 403)
})

test('strict role DTOs reject forged ownership, price, state and snapshot fields; keys are mandatory', async () => {
  const p = await product()
  for (const field of [
    'userId',
    'amountFen',
    'internalNote',
    'source',
    'hidden',
    'version',
    'paymentStatus',
    'fulfillmentStatus',
    'createdByAdminId',
    'productNameSnapshot',
    'paidAt',
    'expiresAt',
  ])
    await rejected(
      () => request('customer', { ...body(p), [field]: bob.id }),
      400,
      'INVALID_INPUT',
    )
  await rejected(
    () => request('admin', { ...adminBody(p), source: 'USER' }),
    400,
  )
  for (const key of [null, '', 'bad,key', 'x'.repeat(129)])
    await rejected(
      () => request('customer', body(p), key),
      400,
      'INVALID_IDEMPOTENCY_KEY',
    )
  await rejected(
    () => request('customer', { ...body(p), formData: undefined }),
    400,
  )
})

test('HTTP creation requires the canonical millisecond UTC version only for CUSTOMER', async () => {
  const p = await product({ updatedAt: new Date('2026-11-21T10:00:00.123Z') })
  for (const expectedProductUpdatedAt of [
    undefined,
    null,
    'not-a-timestamp',
    '2026-02-29T10:00:00.123Z',
    '2026-11-21T10:00:00.123+00:00',
    '2026-11-21T10:00:00Z',
    '2026-11-21T10:00:00.1234Z',
  ])
    await rejected(
      () => request('customer', { ...body(p), expectedProductUpdatedAt }),
      400,
      'INVALID_INPUT',
    )
  await rejected(
    () =>
      request('admin', {
        ...adminBody(p),
        expectedProductUpdatedAt: p.updatedAt.toISOString(),
      }),
    400,
    'INVALID_INPUT',
  )
  const purchase = await fetch(base + '/api/v1/customer/products/' + p.slug, {
    headers: { cookie: cookies.customer },
  })
  assert.equal(purchase.status, 200)
  const { id, updatedAt } = await purchase.json()
  assert.equal(id, p.id)
  assert.equal(updatedAt, '2026-11-21T10:00:00.123Z')
  const result = await request('customer', {
    ...body(p),
    expectedProductUpdatedAt: updatedAt,
  })
  assert.equal(result.status, 201)
  assert.equal(result.body.order.amountFen, p.priceFen)
  assert.equal((await request('admin', adminBody(p))).status, 201)
})

test('ADMIN may target active/pending CUSTOMER only, and must explicitly supply valid Fen and price adjustment reason', async () => {
  const p = await product({ listed: false })
  for (const userId of [randomUUID(), admin.id])
    await rejected(
      () => request('admin', { ...adminBody(p), userId }),
      404,
      'CUSTOMER_NOT_FOUND',
    )
  await rejected(
    () => request('admin', { ...adminBody(p), userId: disabled.id }),
    409,
    'CUSTOMER_DISABLED',
  )
  for (const amountFen of [undefined, null, -1, 1.5, '12900', 2147483648])
    await rejected(
      () => request('admin', { ...adminBody(p), amountFen }),
      400,
      'INVALID_INPUT',
    )
  for (const amountFen of [0, 100, 20000])
    await rejected(
      () => request('admin', { ...adminBody(p), amountFen }),
      400,
      'PRICE_ADJUSTMENT_REASON_REQUIRED',
    )
  for (const userId of [alice.id, pending.id]) {
    const amountFen = userId === alice.id ? 20000 : 8000
    const result = await request('admin', {
      ...adminBody(p),
      userId,
      amountFen,
      priceAdjustmentReason: 'Explicit price adjustment',
      internalNote: 'PRIVATE_ORDER_NOTE',
    })
    assert.equal(result.status, 201)
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.body.order.id },
    })
    assert.equal(order.userId, userId)
    assert.equal(order.amountFen, amountFen)
    assert.equal(order.priceSnapshotFen, 12900)
    assert.equal(order.internalNote, 'PRIVATE_ORDER_NOTE')
    assert.equal(
      (
        await db.orderRevision.findFirstOrThrow({
          where: { orderId: order.id },
        })
      ).reason,
      'Explicit price adjustment',
    )
  }
})

test('product eligibility distinguishes listed, unlisted, archived, missing and historical unconfigured periods', async () => {
  const unlisted = await product({ listed: false })
  await rejected(
    () => request('customer', body(unlisted)),
    409,
    'PRODUCT_NOT_AVAILABLE',
  )
  assert.equal((await request('admin', adminBody(unlisted))).status, 201)
  const archived = await product({ listed: false, archivedAt: new Date() })
  const unknownPeriod = await product({
    servicePeriodUnit: null,
    servicePeriodCount: null,
    termLabel: '30 days (not parsed)',
  })
  for (const role of ['customer', 'admin'] as const) {
    const input = role === 'admin' ? adminBody(archived) : body(archived)
    await rejected(() => request(role, input), 409, 'PRODUCT_ARCHIVED')
    await rejected(
      () => request(role, { ...input, productId: randomUUID() }),
      404,
      'PRODUCT_NOT_FOUND',
    )
    await rejected(
      () =>
        request(
          role,
          role === 'admin' ? adminBody(unknownPeriod) : body(unknownPeriod),
        ),
      409,
      'PRODUCT_PERIOD_UNCONFIGURED',
    )
  }
  assert.equal(
    (await db.product.findUniqueOrThrow({ where: { id: unknownPeriod.id } }))
      .servicePeriodCount,
    null,
  )
})

test('stale versions reject each product change without writes, even one millisecond apart', async () => {
  const shownVersion = new Date('2026-11-21T10:00:00.123Z')
  const currentVersion = new Date('2026-11-21T10:00:00.124Z')
  const changes: Prisma.ProductUpdateInput[] = [
    { priceFen: 42 },
    { formSchema: { version: 1, fields: [] } },
    { description: 'Changed description' },
    { servicePeriodUnit: 'YEAR', servicePeriodCount: 2 },
    { listed: false },
    { listed: false, archivedAt: currentVersion },
  ]
  for (const change of changes) {
    const p = await product({ updatedAt: shownVersion })
    await db.product.update({
      where: { id: p.id },
      data: { ...change, updatedAt: currentVersion },
    })
    await rejected(() => request('customer', body(p)), 409, 'PRODUCT_CHANGED')
  }
})

test('a real ADMIN product edit invalidates the old version and a refreshed request uses the new price', async () => {
  const p = await product({ updatedAt: new Date('2026-01-01T00:00:00.123Z') })
  const key = randomUUID()
  const response = await fetch(base + '/api/v1/admin/products/' + p.id, {
    method: 'PATCH',
    headers: {
      cookie: cookies.admin,
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ priceFen: 4200 }),
  })
  assert.equal(response.status, 200)
  const { product: current } = await response.json()
  assert.notEqual(current.updatedAt, p.updatedAt.toISOString())
  await rejected(
    () => request('customer', body(p), key),
    409,
    'PRODUCT_CHANGED',
  )

  const refreshed = await request(
    'customer',
    {
      ...body(p),
      expectedProductUpdatedAt: current.updatedAt,
    },
    key,
  )
  assert.equal(refreshed.status, 201)
  assert.equal(refreshed.body.order.amountFen, 4200)
  assert.equal(refreshed.body.order.priceSnapshotFen, 4200)
})

test('both actors enforce all dynamic field types, required values, options and unknown fields', async () => {
  const full = {
    version: 1,
    fields: [
      { id: 'text', type: 'text', label: 'Account', required: true },
      { id: 'email', type: 'email', label: 'Contact', required: true },
      {
        id: 'textarea',
        type: 'textarea',
        label: 'Description',
        required: true,
      },
      {
        id: 'select',
        type: 'select',
        label: 'Plan',
        required: true,
        options: [{ value: 'a', label: 'A' }],
      },
      {
        id: 'radio',
        type: 'radio',
        label: 'Region',
        required: true,
        options: [{ value: 'b', label: 'B' }],
      },
      {
        id: 'checkbox',
        type: 'checkbox',
        label: 'Features',
        required: true,
        options: [{ value: 'c', label: 'C' }],
      },
      { id: 'number', type: 'number', label: 'Quantity', required: true },
      { id: 'date', type: 'date', label: 'Date', required: true },
    ],
  }
  const p = await product({ formSchema: full })
  const valid = {
    text: 'account',
    email: 'contact@example.com',
    textarea: 'Plain details',
    select: 'a',
    radio: 'b',
    checkbox: ['c'],
    number: 3,
    date: '2028-02-29',
  }
  const invalid = [
    {},
    { ...valid, text: '   ' },
    { ...valid, text: 'x'.repeat(501) },
    { ...valid, email: 'bad' },
    { ...valid, textarea: 1 },
    { ...valid, select: 'other' },
    { ...valid, radio: 'other' },
    { ...valid, checkbox: ['c', 'c'] },
    { ...valid, number: '3' },
    { ...valid, date: '2027-02-29' },
    { ...valid, unknown: 'forged' },
  ]
  for (const role of ['customer', 'admin'] as const) {
    const input = role === 'admin' ? adminBody(p) : body(p)
    for (const formData of invalid)
      await rejected(
        () => request(role, { ...input, formData }),
        400,
        'INVALID_INPUT',
      )
    const result = await request(role, { ...input, formData: valid })
    assert.equal(result.status, 201)
    assert.deepEqual(result.body.order.formData, valid)
    assert.deepEqual(
      result.body.order.formSchemaSnapshot,
      role === 'admin'
        ? full
        : {
            version: 1,
            fields: full.fields.map((field) => ({ ...field, hint: '' })),
          },
    )
  }
})

test('credential fields and recognizable credential payloads are rejected without persistence', async () => {
  const p = await product()
  for (const value of [
    'password=never-store-this',
    'Bearer synthetic-access-token',
    '-----BEGIN PRIVATE KEY-----',
  ])
    await rejected(
      () => request('customer', { ...body(p), formData: { account: value } }),
      400,
    )
  const secret = await product({
    formSchema: {
      version: 1,
      fields: [
        {
          id: 'accessToken',
          label: 'Access token',
          type: 'text',
          required: true,
        },
      ],
    },
  })
  for (const role of ['customer', 'admin'] as const)
    await rejected(
      () =>
        request(role, {
          ...(role === 'admin' ? adminBody(secret) : body(secret)),
          formData: { accessToken: 'never-store' },
        }),
      400,
    )
})

const customerKeys = [
  'expiresAt',
  'remainingSeconds',
  'version',
  'id',
  'orderNo',
  'productId',
  'kind',
  'productNameSnapshot',
  'productDescriptionSnapshot',
  'productTypeSnapshot',
  'priceSnapshotFen',
  'termSnapshot',
  'servicePeriodUnitSnapshot',
  'servicePeriodCountSnapshot',
  'formSchemaSnapshot',
  'formData',
  'amountFen',
  'renewalPriceSnapshotFen',
  'contactEmailSnapshot',
  'targetIdentifier',
  'paymentStatus',
  'fulfillmentStatus',
  'createdAt',
  'paidAt',
  'paymentConfirmedAt',
  'fulfilledAt',
  'cancelledAt',
]
test('complete role-safe DTOs, frozen terms, V1 revisions and correct actor-specific events/audits commit atomically', async () => {
  const p = await product()
  for (const role of ['customer', 'admin'] as const) {
    const before = await db.adminAuditLog.count()
    const result = await request(
      role,
      role === 'admin'
        ? { ...adminBody(p), internalNote: 'PRIVATE_ORDER_NOTE' }
        : body(p),
    )
    assert.equal(result.status, 201)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Object.keys(result.body), ['order'])
    const o = result.body.order
    assert.deepEqual(
      Object.keys(o).sort(),
      [
        ...customerKeys,
        ...(role === 'admin'
          ? ['internalNote', 'customer', 'creator', 'cancellationReason']
          : []),
      ].sort(),
    )
    if (role === 'admin') {
      assert.deepEqual(
        Object.keys(o.customer).sort(),
        [
          'id',
          'username',
          'adminLabel',
          'loginEmail',
          'notificationEmail',
        ].sort(),
      )
      assert.deepEqual(
        Object.keys(o.creator).sort(),
        ['source', 'adminId', 'userId'].sort(),
      )
      assert.equal(o.internalNote, 'PRIVATE_ORDER_NOTE')
      assert.deepEqual(o.creator, {
        source: 'ADMIN',
        adminId: admin.id,
        userId: null,
      })
    }
    assert.equal(o.version, 1)
    assert.equal(o.kind, 'INITIAL')
    assert.equal(o.amountFen, p.priceFen)
    assert.equal(o.productNameSnapshot, p.name)
    assert.equal(o.productDescriptionSnapshot, p.description)
    assert.equal(o.servicePeriodUnitSnapshot, 'MONTH')
    assert.equal(o.servicePeriodCountSnapshot, 1)
    assert.deepEqual(o.formSchemaSnapshot, form)
    assert.deepEqual(o.formData, body(p).formData)
    assert.equal(o.contactEmailSnapshot, alice.notificationEmail)
    assert.equal(o.paymentStatus, 'UNPAID')
    assert.equal(o.fulfillmentStatus, 'NOT_STARTED')
    assert.equal(Date.parse(o.expiresAt) - Date.parse(o.createdAt), 86400000)
    assert(o.remainingSeconds > 86390 && o.remainingSeconds <= 86400)
    const stored = await db.order.findUniqueOrThrow({ where: { id: o.id } })
    assert.equal(stored.userId, alice.id)
    assert.equal(stored.source, role === 'admin' ? 'ADMIN' : 'USER')
    assert.equal(stored.hidden, false)
    assert.equal(stored.targetIdentifier, null)
    const revisions = await db.orderRevision.findMany({
      where: { orderId: o.id },
    })
    assert.equal(revisions.length, 1)
    assert.deepEqual(revisions[0].snapshotJson, buildOrderSnapshot(stored))
    assert.equal(revisions[0].actorType, role === 'admin' ? 'ADMIN' : 'USER')
    assert.equal(
      revisions[0].actorUserId,
      role === 'admin' ? admin.id : alice.id,
    )
    const events = await db.orderEvent.findMany({ where: { orderId: o.id } })
    assert.equal(events.length, 1)
    assert.equal(events[0].eventType, 'ORDER_CREATED')
    assert.equal(events[0].actorType, revisions[0].actorType)
    assert.equal(events[0].actorUserId, role === 'admin' ? null : alice.id)
    assert.equal(events[0].actorAdminId, role === 'admin' ? admin.id : null)
    assert.equal(
      await db.adminAuditLog.count(),
      before + (role === 'admin' ? 1 : 0),
    )
    assert.equal(
      await db.subscription.count({ where: { sourceOrderId: o.id } }),
      0,
    )
    assert.equal(
      await db.paymentTransaction.count({ where: { orderId: o.id } }),
      0,
    )
    assert(!JSON.stringify(events).includes('PRIVATE_ORDER_NOTE'))
    if (role === 'admin') {
      const audit = await db.adminAuditLog.findFirstOrThrow({
        where: { entityId: o.id },
      })
      assert(!JSON.stringify(audit.afterJson).includes('PRIVATE_ORDER_NOTE'))
      assert(!JSON.stringify(audit.afterJson).includes('non-sensitive-account'))
    }
  }
  const fallback = await product({
    type: 'ONE_TIME',
    renewalPriceFen: null,
    servicePeriodUnit: null,
    servicePeriodCount: null,
    formSchema: { version: 1, fields: [] },
  })
  const noNotify = await db.user.create({
    data: {
      loginEmail: randomUUID() + '@example.com',
      status: 'PENDING_ACTIVATION',
    },
  })
  const response = await request('admin', {
    ...adminBody(fallback),
    userId: noNotify.id,
    formData: {},
  })
  assert.equal(response.status, 201)
  assert.equal(response.body.order.contactEmailSnapshot, noNotify.loginEmail)
  assert.equal(response.body.order.kind, 'ONE_TIME')
  assert.equal(response.body.order.renewalPriceSnapshotFen, null)
})

test('CUSTOMER create, list and detail remove editor defaults while ADMIN and stored history retain them', async () => {
  const option = { label: 'Basic', value: 'basic' }
  const choice = {
    id: 'plan',
    type: 'select',
    label: 'Plan',
    required: false,
    hint: 'Choose the service',
    options: [option],
  }
  const schema = {
    version: 1,
    fields: [
      { ...form.fields[0], defaultValue: 'editor-only account' },
      form.fields[1],
      { ...choice, defaultValue: 'basic' },
    ],
  }
  const projection = { version: 1, fields: [...form.fields, choice] }
  const p = await product({ formSchema: schema })
  const created = await request('customer', body(p))
  assert.equal(created.status, 201)
  const order = created.body.order
  const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  const revisions = await db.orderRevision.findMany({
    where: { orderId: order.id },
  })
  assert.equal(revisions.length, 1)
  assert.deepEqual(stored.formSchemaSnapshot, schema)
  assert.deepEqual(revisions[0].snapshotJson, buildOrderSnapshot(stored))
  const detail = await request(
    'customer',
    undefined,
    null,
    cookies.customer,
    'GET',
    '/' + order.id,
  )
  const list = await request(
    'customer',
    undefined,
    null,
    cookies.customer,
    'GET',
    '?search=' + order.orderNo,
  )
  const adminDetail = await request(
    'admin',
    undefined,
    null,
    cookies.admin,
    'GET',
    '/' + order.id,
  )
  assert.equal(detail.status, 200)
  assert.equal(list.status, 200)
  assert.equal(adminDetail.status, 200)
  assert.equal(list.body.total, 1)
  for (const result of [order, detail.body.order, list.body.items[0]]) {
    assert.deepEqual(Object.keys(result).sort(), [...customerKeys].sort())
    assert.deepEqual(result.formSchemaSnapshot, projection)
    assert.deepEqual(result.formData, body(p).formData)
  }
  assert.deepEqual(adminDetail.body.order.formSchemaSnapshot, schema)
  const adminCreated = await request('admin', adminBody(p))
  assert.equal(adminCreated.status, 201)
  assert.deepEqual(adminCreated.body.order.formSchemaSnapshot, schema)
  assert.deepEqual(
    (await db.order.findUniqueOrThrow({ where: { id: order.id } }))
      .formSchemaSnapshot,
    schema,
  )
  assert.deepEqual(
    await db.orderRevision.findMany({ where: { orderId: order.id } }),
    revisions,
  )
})

test('zero-price USER catalog and ADMIN adjustment create NOT_REQUIRED/PROCESSING without payment facts or entitlements', async () => {
  const p = await product({ priceFen: 0 })
  const ordinary = await product()
  for (const [role, input] of [
    ['customer', body(p)],
    [
      'admin',
      { ...adminBody(ordinary), amountFen: 0, priceAdjustmentReason: 'Gift' },
    ],
  ] as const) {
    const before = await snapshot()
    const result = await request(role, input)
    assert.equal(result.status, 201)
    assert.equal(result.body.order.amountFen, 0)
    assert.equal(result.body.order.paymentStatus, 'NOT_REQUIRED')
    assert.equal(result.body.order.fulfillmentStatus, 'PROCESSING')
    assert.equal(result.body.order.remainingSeconds, 0)
    const order = await db.order.findUniqueOrThrow({
      where: { id: result.body.order.id },
    })
    for (const field of [
      'paidAt',
      'paymentRecordedAt',
      'paymentConfirmedAt',
      'fulfilledAt',
      'cancelledAt',
    ] as const)
      assert.equal(order[field], null)
    assert.equal(
      await db.paymentTransaction.count(),
      before.PaymentTransaction.length,
    )
    assert.equal(await db.subscription.count(), before.Subscription.length)
    assert.deepEqual(
      (
        await db.orderRevision.findFirstOrThrow({
          where: { orderId: order.id },
        })
      ).snapshotJson,
      buildOrderSnapshot(order),
    )
    const read = await request(
      role,
      undefined,
      null,
      cookies[role],
      'GET',
      '?paymentStatus=NOT_REQUIRED',
    )
    assert.equal(read.status, 200)
    assert(read.body.items.some((v: { id: string }) => v.id === order.id))
  }
})

test('same actor/key replays exact original DTO after product price/schema/archive and target changes; distinct intent conflicts', async () => {
  const p = await product(),
    key = randomUUID()
  const input = { ...adminBody(p), userId: pending.id }
  const first = await request('admin', input, key)
  assert.equal(first.status, 201)
  await db.product.update({
    where: { id: p.id },
    data: {
      priceFen: 12,
      name: 'Changed current product',
      formSchema: { version: 1, fields: [] },
      archivedAt: new Date(),
      listed: false,
    },
  })
  await db.user.update({
    where: { id: pending.id },
    data: { status: 'DISABLED' },
  })
  const before = await snapshot()
  const replay = await request('admin', input, key)
  assert.equal(replay.status, 201)
  assert.deepEqual(replay.body, first.body)
  assert(isDeepStrictEqual(await snapshot(), before))
  await rejected(
    () => request('admin', { ...input, internalNote: 'Different intent' }, key),
    409,
    'IDEMPOTENCY_CONFLICT',
  )
  const record = await db.idempotencyRecord.findUniqueOrThrow({
    where: {
      actorUserId_keyHash: {
        actorUserId: admin.id,
        keyHash: createHash('sha256').update(key).digest('hex'),
      },
    },
  })
  assert.deepEqual(record.responseJson, first.body)
  assert(!JSON.stringify(record).includes(key))
  const self = await product(),
    selfKey = randomUUID(),
    selfInput = body(self)
  const selfFirst = await request('customer', selfInput, selfKey)
  assert.equal(selfFirst.status, 201)
  const changed = await db.product.update({
    where: { id: self.id },
    data: {
      listed: false,
      priceFen: 1,
      updatedAt: new Date(self.updatedAt.getTime() + 1),
    },
  })
  const unlistedReplay = await request('customer', selfInput, selfKey)
  assert.equal(unlistedReplay.status, 201)
  assert.deepEqual(unlistedReplay.body, selfFirst.body)
  await rejected(
    () =>
      request(
        'customer',
        {
          ...selfInput,
          expectedProductUpdatedAt: changed.updatedAt.toISOString(),
        },
        selfKey,
      ),
    409,
    'IDEMPOTENCY_CONFLICT',
  )
  await rejected(
    () =>
      request(
        'customer',
        { ...selfInput, formData: { account: 'changed' } },
        selfKey,
      ),
    409,
  )
  await db.product.update({
    where: { id: self.id },
    data: { archivedAt: new Date(), formSchema: { version: 1, fields: [] } },
  })
  const beforeArchiveReplay = await snapshot()
  const archivedReplay = await request('customer', selfInput, selfKey)
  assert.equal(archivedReplay.status, 201)
  assert.deepEqual(archivedReplay.body, selfFirst.body)
  assert(isDeepStrictEqual(await snapshot(), beforeArchiveReplay))
})

test('sequential retries, actor namespaces, distinct keys and canonical field ordering preserve idempotency', async () => {
  const p = await product(),
    key = randomUUID(),
    input = body(p)
  const first = await request('customer', input, key)
  const reordered = {
    formData: { account: 'non-sensitive-account' },
    expectedProductUpdatedAt: input.expectedProductUpdatedAt,
    productId: p.id,
  }
  assert.deepEqual((await request('customer', reordered, key)).body, first.body)
  const bobResult = await request('customer', input, key, cookies.bob)
  assert.equal(bobResult.status, 201)
  assert.notEqual(bobResult.body.order.id, first.body.order.id)
  const adminResult = await request('admin', adminBody(p), key)
  assert.equal(adminResult.status, 201)
  assert.notEqual(adminResult.body.order.id, first.body.order.id)
  assert.notEqual(
    (await request('customer', input)).body.order.id,
    first.body.order.id,
  )
})

test('real order number collisions retry within the transaction, preserve replay, and stop at the limit', async (t) => {
  const p = await product()
  const candidates = [583_024_917, 583_024_917, 583_024_918]
  const draw = t.mock.method(
    crypto,
    'randomInt',
    () => candidates.shift() ?? 583_024_917,
  )
  const existing = await request('admin', adminBody(p))
  assert.equal(existing.status, 201)
  assert.equal(existing.body.order.orderNo, '583024917')

  const key = randomUUID()
  const input = body(p)
  const before = await snapshot()
  const first = await request('customer', input, key)
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(first.body.order.orderNo, '583024918')
  assert.match(first.body.order.id, /^[a-f0-9-]{36}$/)
  assert.equal(draw.mock.callCount(), 3)
  const committed = await snapshot()
  for (const table of [
    'Order',
    'OrderRevision',
    'OrderEvent',
    'IdempotencyRecord',
  ])
    assert.equal(committed[table].length, before[table].length + 1)

  const repeated = await Promise.all(
    Array.from({ length: 3 }, () => request('customer', input, key)),
  )
  for (const replay of repeated) {
    assert.equal(replay.status, 201)
    assert.deepEqual(replay.body, first.body)
  }
  assert.equal(draw.mock.callCount(), 3)
  assert.deepEqual(await snapshot(), committed)

  for (const [role, filter] of [
    ['customer', 'search'],
    ['admin', 'orderNo'],
  ] as const) {
    const query = new URLSearchParams({ [filter]: '583 024 918' })
    const results = await request(
      role,
      undefined,
      null,
      cookies[role],
      'GET',
      '?' + query,
    )
    assert.equal(results.status, 200)
    assert.deepEqual(
      results.body.items.map((order: { orderNo: string }) => order.orderNo),
      ['583024918'],
    )
  }
  assert.equal(
    (
      await request(
        'customer',
        undefined,
        null,
        cookies.customer,
        'GET',
        '/583024918',
      )
    ).status,
    400,
  )
  await rejected(
    () => request('customer', input),
    503,
    'ORDER_NUMBER_UNAVAILABLE',
  )
  assert.equal(draw.mock.callCount(), 8)
})

test('simultaneous duplicate HTTP requests produce exactly one complete set of records', async () => {
  for (const role of ['customer', 'admin'] as const) {
    const p = await product(),
      key = randomUUID(),
      input = role === 'admin' ? adminBody(p) : body(p)
    const before = await snapshot()
    // Requests are dispatched concurrently, not awaited in a sequential loop.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(role, input, key)),
    )
    assert(
      results.every((r) => r.status === 201),
      JSON.stringify(results.map((r) => r.body)),
    )
    assert(results.every((r) => isDeepStrictEqual(r.body, results[0].body)))
    const after = await snapshot()
    for (const table of [
      'Order',
      'OrderRevision',
      'OrderEvent',
      'IdempotencyRecord',
    ])
      assert.equal(after[table].length, before[table].length + 1)
    assert.equal(
      after.AdminAuditLog.length,
      before.AdminAuditLog.length + (role === 'admin' ? 1 : 0),
    )
  }
})

test('concurrent different payloads sharing a key choose one winner and roll back the loser', async () => {
  const p = await product(),
    key = randomUUID(),
    before = await snapshot()
  const results = await Promise.all(
    ['one', 'two'].map((account) =>
      request('customer', { ...body(p), formData: { account } }, key),
    ),
  )
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409])
  const after = await snapshot()
  for (const table of [
    'Order',
    'OrderRevision',
    'OrderEvent',
    'IdempotencyRecord',
  ])
    assert.equal(after[table].length, before[table].length + 1)
})

test('injected database failures at revision/event/audit/idempotency roll back every business record and allow clean retries', async () => {
  const p = await product()
  for (const table of [
    'OrderRevision',
    'OrderEvent',
    'AdminAuditLog',
    'IdempotencyRecord',
  ]) {
    const roles =
      table === 'AdminAuditLog'
        ? (['admin'] as const)
        : (['admin', 'customer'] as const)
    for (const role of roles) {
      const key = randomUUID()
      const input = role === 'admin' ? adminBody(p) : body(p)
      sql(
        `CREATE TRIGGER Creation_test_failure BEFORE INSERT ON \`${table}\` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ISOLATED_CREATION_FAILURE';`,
      )
      try {
        await rejected(() => request(role, input, key), 503)
      } finally {
        sql('DROP TRIGGER Creation_test_failure;')
      }
      assert.equal((await request(role, input, key)).status, 201)
    }
  }
})

test('customer/product locks recheck a concurrent disable, archive or price edit before creation', async () => {
  for (const change of ['disable', 'archive', 'price'] as const) {
    const p = await product()
    const target = await db.user.create({
      data: {
        loginEmail: randomUUID() + '@example.com',
        status: 'ACTIVE',
        ...(await activeCredentials()),
      },
    })
    const cookie = await session(target.id)
    let release!: () => void, locked!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      locked = resolve
    })
    const before = await snapshot()
    const writer = db.$transaction(async (tx) => {
      if (change === 'disable')
        await tx.$queryRaw`SELECT id FROM User WHERE id = ${target.id} FOR UPDATE`
      else
        await tx.$queryRaw`SELECT id FROM Product WHERE id = ${p.id} FOR UPDATE`
      locked()
      await gate
      if (change === 'disable')
        await tx.user.update({
          where: { id: target.id },
          data: { status: 'DISABLED' },
        })
      else
        await tx.product.update({
          where: { id: p.id },
          data: {
            ...(change === 'archive'
              ? { listed: false, archivedAt: new Date() }
              : { priceFen: 7 }),
            updatedAt: new Date(p.updatedAt.getTime() + 1),
          },
        })
    })
    await ready
    let settled = false
    const pending = request('customer', body(p), randomUUID(), cookie).then(
      (result) => {
        settled = true
        return result
      },
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(
        settled,
        false,
        'Creation must wait for the locked state row',
      )
    } finally {
      release()
    }
    await writer
    const result = await pending
    assert.equal(result.status, change === 'disable' ? 403 : 409)
    assert.equal(
      result.body.error.code,
      change === 'disable' ? 'ACCOUNT_NOT_ELIGIBLE' : 'PRODUCT_CHANGED',
    )
    assert.equal(await db.order.count({ where: { userId: target.id } }), 0)
    const after = await snapshot()
    for (const table of [
      'Order',
      'OrderRevision',
      'OrderEvent',
      'IdempotencyRecord',
      'AdminAuditLog',
    ])
      assert.deepEqual(after[table], before[table])
  }
})

test('MySQL independently rejects invalid NOT_REQUIRED states and accepts strict revision snapshots', async () => {
  const p = await product({ priceFen: 0 })
  const result = await request('customer', body(p))
  const order = await db.order.findUniqueOrThrow({
    where: { id: result.body.order.id },
  })
  for (const data of [
    { amountFen: 1 },
    { paymentStatus: 'NOT_REQUIRED' as const, paidAt: new Date() },
    { paymentConfirmedAt: new Date() },
    { fulfillmentStatus: 'NOT_STARTED' as const },
  ]) {
    const before = await snapshot()
    await assert.rejects(
      db.order.update({
        where: { id: order.id },
        data: { ...data, version: { increment: 1 } },
      }),
    )
    assert(isDeepStrictEqual(await snapshot(), before))
  }
  const read = await request(
    'customer',
    undefined,
    null,
    cookies.customer,
    'GET',
    '/' + order.id,
  )
  assert.equal(read.status, 200)
  assert.equal(read.body.order.paymentStatus, 'NOT_REQUIRED')
  assert.equal(read.body.order.remainingSeconds, 0)
})

test('customer and admin can submit and replay 64 KiB forms without losing frozen data', async () => {
  const formSchema = formSchemaAtLimit()
  const p = await product({ formSchema })
  const formData = formDataAtLimit()
  assert.equal(jsonBytes(formData), 65_536)
  for (const actor of ['customer', 'admin'] as const) {
    const input = { ...(actor === 'admin' ? adminBody(p) : body(p)), formData }
    for (const [invalid, message] of [
      [{ ...formData, extra: formData.extra + 'x' }, /填写信息不能超过 64 KiB/],
      [{ note: formData.note + 'x' }, /10,000 个字符/],
      [
        { note: 'A'.repeat(9_950) + '\npassword=synthetic-only' },
        /不得包含认证或付款凭证/,
      ],
    ] as const) {
      const before = await db.order.count({ where: { productId: p.id } })
      const rejected = await request(actor, { ...input, formData: invalid })
      assert.equal(rejected.status, 400)
      assert.equal(rejected.body.error.code, 'INVALID_INPUT')
      assert.match(rejected.body.error.message, message)
      assert.equal(await db.order.count({ where: { productId: p.id } }), before)
    }
    const key = randomUUID()
    const created = await request(actor, input, key)
    assert.equal(created.status, 201)
    const id = created.body.order.id
    const read = await request(
      actor,
      null,
      null,
      cookies[actor],
      'GET',
      '/' + id,
    )
    assert.equal(read.status, 200)
    assert.deepEqual(read.body.order.formData, formData)
    assert.equal(
      read.body.order.formSchemaSnapshot.fields.length,
      formSchema.fields.length,
    )
    assert.equal(
      'defaultValue' in read.body.order.formSchemaSnapshot.fields[0],
      actor === 'admin',
    )
    const stored = await db.order.findUniqueOrThrow({ where: { id } })
    assert.deepEqual(stored.formSchemaSnapshot, formSchema)
    const revision = await db.orderRevision.findFirstOrThrow({
      where: { orderId: id },
    })
    assert.deepEqual(revision.snapshotJson, buildOrderSnapshot(stored))
    const replay = await request(actor, input, key)
    assert.equal(replay.status, 201)
    assert.deepEqual(replay.body.order, created.body.order)
    assert.equal(await db.orderRevision.count({ where: { orderId: id } }), 1)
  }
  assert.equal(await db.order.count({ where: { productId: p.id } }), 2)
})
