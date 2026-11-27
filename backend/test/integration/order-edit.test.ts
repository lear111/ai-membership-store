import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { Server } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import {
  formDataAtLimit,
  jsonBytes,
  longTextFields,
} from '../long-text-fixture.ts'
import { createApp } from '../../src/app.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import { Prisma, type User } from '../../src/generated/prisma/client.ts'
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
  productId: string
const cookies: Record<string, string> = {}
const schema = {
  version: 1,
  fields: [
    {
      id: 'account',
      type: 'text',
      label: 'Account identifier',
      required: true,
    },
    { id: 'email', type: 'email', label: 'Contact email', required: true },
    {
      id: 'note',
      type: 'textarea',
      label: 'Optional description',
      required: false,
      defaultValue: 'Never fill implicitly',
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
      options: [{ value: 'r', label: 'R' }],
    },
    {
      id: 'checkbox',
      type: 'checkbox',
      label: 'Features',
      required: true,
      options: [{ value: 'c', label: 'C' }],
    },
    { id: 'number', type: 'number', label: 'Quantity', required: true },
    { id: 'date', type: 'date', label: 'Service date', required: true },
  ],
}
const original = {
  account: 'original-account',
  email: 'contact@example.com',
  note: 'optional original',
  select: 'a',
  radio: 'r',
  checkbox: ['c'],
  number: 2,
  date: '2028-02-29',
}
const input = (account = 'changed-account') => ({
  expectedVersion: 1,
  formData: { ...original, account },
})
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
async function fixture(extra: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const source = extra.source ?? 'ADMIN'
  const order = await db.order.create({
    data: {
      orderNo: 'EDIT-' + randomUUID().replaceAll('-', ''),
      userId: alice.id,
      productId,
      source,
      kind: 'INITIAL',
      createdByAdminId: source === 'ADMIN' ? admin.id : null,
      createdByUserId: source === 'USER' ? (extra.userId ?? alice.id) : null,
      productNameSnapshot: 'Frozen product',
      productDescriptionSnapshot: 'Frozen description',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 1000,
      renewalPriceSnapshotFen: 900,
      termSnapshot: 'Display only',
      servicePeriodUnitSnapshot: 'MONTH',
      servicePeriodCountSnapshot: 1,
      formSchemaSnapshot: schema,
      formData: original,
      amountFen: 1000,
      contactEmailSnapshot: 'frozen@example.com',
      internalNote: 'PRIVATE_ORDER_NOTE',
      ...extra,
    },
  })
  await db.orderRevision.create({
    data: {
      orderId: order.id,
      version: 1,
      snapshotSchemaVersion: 1,
      snapshotJson: buildOrderSnapshot(order),
      actorType: source === 'SYSTEM_RENEWAL' ? 'SYSTEM' : source,
      actorUserId:
        source === 'SYSTEM_RENEWAL'
          ? null
          : source === 'ADMIN'
            ? admin.id
            : order.userId,
    },
  })
  return order
}
async function request(
  role: 'customer' | 'admin',
  id: string,
  data: unknown,
  key: string | null = randomUUID(),
  cookie = cookies[role],
) {
  const response = await fetch(base + '/api/v1/' + role + '/orders/' + id, {
    method: 'PATCH',
    headers: {
      cookie,
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
      ...(key === null ? {} : { 'Idempotency-Key': key }),
    },
    body: JSON.stringify(data),
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
  const before = await snapshot(),
    result = await action()
  assert.equal(result.status, status, JSON.stringify(result.body))
  if (code) assert.equal(result.body.error.code, code)
  assert(
    isDeepStrictEqual(await snapshot(), before),
    'Rejected edit changed business data or history',
  )
  return result
}
function sql(input: string) {
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
  const user = async (status: User['status']) =>
    db.user.create({
      data: {
        role: 'CUSTOMER',
        status,
        ...(status === 'ACTIVE' ? await activeCredentials() : {}),
        loginEmail: randomUUID() + '@example.com',
        username: 'Public name',
        adminLabel: 'PRIVATE_LABEL',
      },
    })
  alice = await user('ACTIVE')
  bob = await user('ACTIVE')
  cookies.admin = await session(admin.id)
  cookies.customer = await session(alice.id)
  cookies.bob = await session(bob.id)
  cookies.pending = await session((await user('PENDING_ACTIVATION')).id)
  cookies.disabled = await session((await user('DISABLED')).id)
  cookies.expired = await session(alice.id, {
    expiresAt: new Date(Date.now() - 1000),
  })
  cookies.revoked = await session(alice.id, { revokedAt: new Date() })
  productId = (
    await db.product.create({
      data: {
        slug: randomUUID(),
        name: 'Current product',
        type: 'SUBSCRIPTION',
        priceFen: 1000,
        renewalPriceFen: 900,
        termLabel: 'Display only',
        servicePeriodUnit: 'MONTH',
        servicePeriodCount: 1,
        listed: true,
        formSchema: schema,
      },
    })
  ).id
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

test('PATCH requires persisted active role-specific Sessions and existing CSRF protections', async () => {
  const order = await fixture()
  for (const role of ['customer', 'admin'] as const) {
    for (const cookie of [
      '',
      COOKIE_NAME + '=invalid',
      cookies.pending,
      cookies.disabled,
      cookies.expired,
      cookies.revoked,
    ])
      await rejected(
        () => request(role, order.id, input(), randomUUID(), cookie),
        401,
      )
    await rejected(
      () =>
        request(
          role,
          order.id,
          input(),
          randomUUID(),
          cookies[role === 'admin' ? 'customer' : 'admin'],
        ),
      role === 'admin' ? 403 : 404,
    )
  }
  const before = await snapshot()
  const response = await fetch(base + '/api/v1/customer/orders/' + order.id, {
    method: 'PATCH',
    headers: { cookie: cookies.customer, 'content-type': 'application/json' },
    body: JSON.stringify(input()),
  })
  assert.equal(response.status, 403)
  assert(isDeepStrictEqual(await snapshot(), before))
})

test('CUSTOMER ownership is enforced in path and query; missing and foreign IDs both return safe 404', async () => {
  const other = await fixture({
    userId: bob.id,
    paymentStatus: 'PAID',
    fulfillmentStatus: 'PROCESSING',
  })
  const missing = await rejected(
    () => request('customer', randomUUID(), input()),
    404,
    'NOT_FOUND',
  )
  const foreign = await rejected(
    () => request('customer', other.id + '?userId=' + bob.id, input()),
    404,
    'NOT_FOUND',
  )
  assert.equal(missing.body.error.message, foreign.body.error.message)
  const own = await fixture({ source: 'USER' })
  assert.equal(
    (await request('customer', own.id + '?userId=' + bob.id, input())).status,
    200,
  )
  assert.equal(
    (await db.order.findUniqueOrThrow({ where: { id: own.id } })).userId,
    alice.id,
  )
  await rejected(
    () => request('admin', randomUUID(), input()),
    404,
    'NOT_FOUND',
  )
})

test('strict edit DTOs require expectedVersion/formData/key and reject managed/private fields', async () => {
  const order = await fixture()
  for (const role of ['customer', 'admin'] as const) {
    for (const invalid of [
      { formData: original },
      { expectedVersion: 1 },
      { ...input(), expectedVersion: 0 },
      { ...input(), expectedVersion: '1' },
      { ...input(), formData: null },
    ])
      await rejected(
        () => request(role, order.id, invalid),
        400,
        'INVALID_INPUT',
      )
    for (const field of [
      'internalNote',
      'userId',
      'productId',
      'source',
      'version',
      'hidden',
      'createdAt',
      'paidAt',
      'paymentStatus',
      'servicePeriodCountSnapshot',
      'formSchemaSnapshot',
    ])
      await rejected(
        () => request(role, order.id, { ...input(), [field]: 'forged' }),
        400,
        'INVALID_INPUT',
      )
    for (const key of [null, 'bad,key', 'x'.repeat(129)])
      await rejected(
        () => request(role, order.id, input(), key),
        400,
        'INVALID_IDEMPOTENCY_KEY',
      )
  }
  for (const field of ['amountFen', 'priceAdjustmentReason'])
    await rejected(
      () => request('customer', order.id, { ...input(), [field]: 0 }),
      400,
      'INVALID_INPUT',
    )
})

test('complete frozen-form replacement drops omitted optional data without filling defaults or consulting Product', async () => {
  const order = await fixture({ source: 'USER' })
  await db.product.update({
    where: { id: productId },
    data: {
      archivedAt: new Date(),
      listed: false,
      name: 'Changed catalog',
      priceFen: 999,
      formSchema: {
        version: 1,
        fields: [
          { id: 'new', type: 'text', label: 'New field', required: true },
        ],
      },
    },
  })
  const next = { ...input().formData }
  delete (next as Partial<typeof next>).note
  const result = await request('customer', order.id, {
    expectedVersion: 1,
    formData: next,
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.body.order.formData, next)
  assert.equal(Object.hasOwn(result.body.order.formData, 'note'), false)
  assert.deepEqual(result.body.order.formSchemaSnapshot, {
    version: 1,
    fields: schema.fields.map(({ defaultValue, ...field }) => {
      if (field.id === 'note')
        assert.equal(defaultValue, 'Never fill implicitly')
      return { ...field, hint: '' }
    }),
  })
  assert.equal(result.body.order.productNameSnapshot, 'Frozen product')
  await rejected(
    () =>
      request('customer', order.id, {
        expectedVersion: 2,
        formData: { new: 'current catalog' },
      }),
    400,
    'INVALID_INPUT',
  )
})

test('both roles enforce required values, all eight types, options and unknown fields while accepting credential-like text', async () => {
  const order = await fixture()
  const invalid = [
    { ...original, account: '' },
    { ...original, account: 123 },
    { ...original, email: 'invalid' },
    { ...original, note: 1 },
    { ...original, select: 'other' },
    { ...original, radio: 'other' },
    { ...original, checkbox: ['c', 'c'] },
    { ...original, number: '2' },
    { ...original, date: '2027-02-29' },
    { ...original, unknown: 'rejected' },
    {},
  ]
  for (const role of ['customer', 'admin'] as const)
    for (const formData of invalid)
      await rejected(
        () => request(role, order.id, { expectedVersion: 1, formData }),
        400,
        'INVALID_INPUT',
      )
  for (const role of ['customer', 'admin'] as const) {
    const secret = await fixture({
      formSchemaSnapshot: {
        version: 1,
        fields: [{ id: 'otp', type: 'text', label: '验证码', required: true }],
      },
      formData: {},
    })
    const accepted = await request(role, secret.id, {
      expectedVersion: 1,
      formData: { otp: 'stored-as-is' },
    })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    assert.deepEqual(accepted.body.order.formData, { otp: 'stored-as-is' })
  }
  const legacy = await fixture({
    formSchemaSnapshot: Prisma.DbNull,
    formData: Prisma.DbNull,
  })
  await rejected(
    () => request('admin', legacy.id, input()),
    400,
    'INVALID_INPUT',
  )
})

test('ADMIN changes price/form once, compares current amount rather than catalog price, and requires actual-change reasons', async () => {
  const order = await fixture({ amountFen: 800 })
  await rejected(
    () => request('admin', order.id, { ...input(), amountFen: 1000 }),
    400,
    'PRICE_ADJUSTMENT_REASON_REQUIRED',
  )
  await rejected(
    () =>
      request('admin', order.id, {
        ...input(),
        amountFen: 800,
        priceAdjustmentReason: 'unchanged amount',
      }),
    400,
    'INVALID_INPUT',
  )
  await rejected(
    () =>
      request('admin', order.id, {
        ...input(),
        priceAdjustmentReason: 'missing amount',
      }),
    400,
    'INVALID_INPUT',
  )
  for (const amountFen of [-1, 1.5, '1', 2147483648])
    await rejected(
      () => request('admin', order.id, { ...input(), amountFen }),
      400,
      'INVALID_INPUT',
    )
  const first = await request('admin', order.id, { ...input(), amountFen: 800 })
  assert.equal(first.status, 200)
  assert.equal(first.body.order.version, 2)
  const second = await request('admin', order.id, {
    expectedVersion: 2,
    formData: first.body.order.formData,
    amountFen: 1200,
    priceAdjustmentReason: '  approved markup  ',
  })
  assert.equal(second.status, 200)
  assert.equal(second.body.order.version, 3)
  assert.equal(second.body.order.priceSnapshotFen, 1000)
  const third = await request('admin', order.id, {
    expectedVersion: 3,
    formData: original,
    amountFen: 700,
    priceAdjustmentReason: 'approved discount',
  })
  assert.equal(third.status, 200)
  assert.equal(third.body.order.version, 4)
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    4,
  )
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 3)
})

test('effective no-ops including reordered object keys leave all state and history unchanged', async () => {
  const order = await fixture()
  const reordered = Object.fromEntries(Object.entries(original).reverse())
  for (const role of ['admin', 'customer'] as const)
    await rejected(
      () =>
        request(role, order.id, {
          expectedVersion: 1,
          formData: reordered,
          ...(role === 'admin' ? { amountFen: 1000 } : {}),
        }),
      400,
      'INVALID_INPUT',
    )
})

test('stale expectedVersion is rejected without history; different actors have independent key namespaces', async () => {
  const key = randomUUID()
  for (const role of ['customer', 'admin'] as const) {
    const order = await fixture()
    assert.equal((await request(role, order.id, input(), key)).status, 200)
    await rejected(
      () => request(role, order.id, input('stale')),
      409,
      'VERSION_CONFLICT',
    )
  }
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
test('role DTOs use exact allowlists; V2 preserves frozen fields, original deadline, V1 and sanitized actor-specific history', async () => {
  for (const role of ['customer', 'admin'] as const) {
    const order = await fixture({
        source: role === 'customer' ? 'USER' : 'ADMIN',
      }),
      before = await snapshot()
    const v1 = await db.orderRevision.findFirstOrThrow({
      where: { orderId: order.id, version: 1 },
    })
    const result = await request(role, order.id, input())
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.headers.get('cache-control'), 'no-store')
    const dto = result.body.order
    assert.deepEqual(
      Object.keys(dto).sort(),
      [
        ...customerKeys,
        ...(role === 'admin'
          ? ['internalNote', 'customer', 'creator', 'cancellationReason']
          : []),
      ].sort(),
    )
    if (role === 'admin') {
      assert.deepEqual(
        Object.keys(dto.customer).sort(),
        [
          'id',
          'username',
          'adminLabel',
          'loginEmail',
          'notificationEmail',
        ].sort(),
      )
      assert.deepEqual(
        Object.keys(dto.creator).sort(),
        ['source', 'adminId', 'userId'].sort(),
      )
    } else assert(!JSON.stringify(dto).includes('PRIVATE'))
    assert.equal(
      dto.expiresAt,
      new Date(order.createdAt.getTime() + 86400000).toISOString(),
    )
    const updated = await db.order.findUniqueOrThrow({
      where: { id: order.id },
    })
    for (const field of Object.keys(order) as (keyof typeof order)[]) {
      if (!['formData', 'version', 'updatedAt'].includes(field))
        assert.deepEqual(updated[field], order[field], field)
    }
    assert.equal(updated.version, 2)
    assert.deepEqual(
      await db.orderRevision.findUniqueOrThrow({ where: { id: v1.id } }),
      v1,
    )
    const v2 = await db.orderRevision.findFirstOrThrow({
      where: { orderId: order.id, version: 2 },
    })
    assert.deepEqual(v2.snapshotJson, buildOrderSnapshot(updated))
    assert.equal(v2.actorUserId, role === 'admin' ? admin.id : alice.id)
    assert.equal(v2.actorType, role === 'admin' ? 'ADMIN' : 'USER')
    const event = await db.orderEvent.findFirstOrThrow({
      where: { orderId: order.id },
    })
    assert.equal(event.eventType, 'NOTE')
    assert.equal(event.actorType, v2.actorType)
    assert.equal(event.actorAdminId, role === 'admin' ? admin.id : null)
    assert.equal(event.actorUserId, role === 'customer' ? alice.id : null)
    assert.equal((event.fromStateJson as { version: number }).version, 1)
    assert.equal((event.toStateJson as { version: number }).version, 2)
    const after = await snapshot()
    assert.equal(
      after.AdminAuditLog.length,
      before.AdminAuditLog.length + (role === 'admin' ? 1 : 0),
    )
    assert.equal(
      after.IdempotencyRecord.length,
      before.IdempotencyRecord.length + 1,
    )
    const logs = JSON.stringify([
      event,
      ...(await db.adminAuditLog.findMany({ where: { entityId: order.id } })),
    ])
    assert(!logs.includes('changed-account'))
    assert(!logs.includes('PRIVATE_ORDER_NOTE'))
    assert(!logs.includes('contact@example.com'))
  }
})

test('ADMIN zero conversion atomically completes one edit without inventing payment or subscription records', async () => {
  const order = await fixture(),
    before = await snapshot(),
    key = randomUUID()
  const data = { ...input(), amountFen: 0, priceAdjustmentReason: 'Gift' }
  const result = await request('admin', order.id, data, key)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.order.version, 2)
  assert.equal(result.body.order.paymentStatus, 'NOT_REQUIRED')
  assert.equal(result.body.order.fulfillmentStatus, 'PROCESSING')
  assert.equal(result.body.order.paidAt, null)
  assert.equal(result.body.order.paymentConfirmedAt, null)
  assert.equal(result.body.order.remainingSeconds, 0)
  const after = await snapshot()
  for (const table of [
    'PaymentTransaction',
    'Subscription',
    'SubscriptionEvent',
  ])
    assert.deepEqual(after[table], before[table])
  for (const table of [
    'OrderRevision',
    'OrderEvent',
    'AdminAuditLog',
    'IdempotencyRecord',
  ])
    assert.equal(after[table].length, before[table].length + 1)
  assert.deepEqual(
    (await request('admin', order.id, data, key)).body,
    result.body,
  )
  await rejected(
    () => request('admin', order.id, { ...input('again'), expectedVersion: 2 }),
    409,
    'ORDER_NOT_EDITABLE',
  )
  await rejected(
    () =>
      request('customer', order.id, { ...input('again'), expectedVersion: 2 }),
    409,
    'ORDER_NOT_EDITABLE',
  )
})

test('paid, cancelled, processing, completed, timestamp facts, zero-price and expired states reject both roles', async () => {
  const now = new Date()
  const variants: Partial<Prisma.OrderUncheckedCreateInput>[] = [
    ...(
      ['PAID', 'PENDING_VERIFICATION', 'REFUND_PENDING', 'REFUNDED'] as const
    ).map((paymentStatus) => ({ paymentStatus })),
    ...(['PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED'] as const).map(
      (fulfillmentStatus) => ({ fulfillmentStatus }),
    ),
    { paidAt: now },
    { paymentConfirmedAt: now },
    { fulfilledAt: now },
    { cancelledAt: now },
    {
      paymentStatus: 'NOT_REQUIRED',
      fulfillmentStatus: 'PROCESSING',
      amountFen: 0,
    },
    { createdAt: new Date(Date.now() - 86400000) },
    { createdAt: new Date(Date.now() - 90000000) },
  ]
  for (const variant of variants) {
    const order = await fixture(variant)
    for (const role of ['customer', 'admin'] as const)
      await rejected(
        () => request(role, order.id, input()),
        409,
        'ORDER_NOT_EDITABLE',
      )
  }
})

test('hidden SYSTEM_RENEWAL orders are immutable; customer requests uniformly use 404', async () => {
  const now = new Date(),
    day = 86400000
  const subscription = await db.subscription.create({
    data: {
      userId: alice.id,
      productId,
      sourceType: 'ADMIN',
      createdByAdminId: admin.id,
      productNameSnapshot: 'Legacy subscription',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 1000,
      termSnapshot: 'Display',
      startedAt: new Date(now.getTime() - day),
      expiresAt: new Date(now.getTime() + day),
      renewalPriceFen: 900,
    },
  })
  const order = await fixture({
    source: 'SYSTEM_RENEWAL',
    kind: 'RENEWAL',
    hidden: true,
    subscriptionId: subscription.id,
    paymentStatus: 'PAID',
    fulfillmentStatus: 'COMPLETED',
    paidAt: now,
    paymentConfirmedAt: now,
    fulfilledAt: now,
    renewalForPeriodStartAt: new Date(now.getTime() - day),
    renewalPeriodStartAt: now,
    renewalPeriodEndAt: new Date(now.getTime() + day),
    billingAnchorSnapshotAt: now,
    billingTimezoneSnapshot: 'Asia/Shanghai',
    billingRevisionSnapshot: 1,
    renewalRequestKeyHash: createHash('sha256')
      .update(randomUUID())
      .digest('hex'),
    renewalRequestHash: createHash('sha256').update(randomUUID()).digest('hex'),
  })
  await rejected(
    () => request('admin', order.id, input()),
    409,
    'ORDER_NOT_EDITABLE',
  )
  await rejected(() => request('customer', order.id, input()), 404, 'NOT_FOUND')
  await rejected(
    () => request('customer', order.id, input(), randomUUID(), cookies.bob),
    404,
    'NOT_FOUND',
  )
})

test('any existing transaction prevents zero conversion; confirmed facts also block ordinary core edits', async () => {
  for (const status of ['PENDING', 'CONFIRMED'] as const) {
    const order = await fixture()
    await db.paymentTransaction.create({
      data: {
        orderId: order.id,
        kind: 'PAYMENT',
        channel: 'CASH',
        amountFen: 1000,
        status,
        occurredAt: new Date(),
        createdByAdminId: admin.id,
        ...(status === 'CONFIRMED'
          ? { confirmedAt: new Date(), confirmedByAdminId: admin.id }
          : {}),
      },
    })
    await rejected(
      () =>
        request('admin', order.id, {
          ...input(),
          amountFen: 0,
          priceAdjustmentReason: 'Gift',
        }),
      409,
      'ORDER_NOT_EDITABLE',
    )
    if (status === 'CONFIRMED')
      for (const role of ['customer', 'admin'] as const)
        await rejected(
          () => request(role, order.id, input()),
          409,
          'ORDER_NOT_EDITABLE',
        )
  }
})

test('sequential idempotency replays the first DTO after later edits and rejects different payload, version, order and operation', async () => {
  const order = await fixture(),
    key = randomUUID(),
    first = await request('admin', order.id, input(), key)
  assert.equal(first.status, 200)
  const second = await request('admin', order.id, {
    ...input('later'),
    expectedVersion: 2,
    amountFen: 0,
    priceAdjustmentReason: 'Gift',
  })
  assert.equal(second.status, 200)
  const before = await snapshot()
  const reordered = {
    formData: Object.fromEntries(Object.entries(input().formData).reverse()),
    expectedVersion: 1,
  }
  assert.deepEqual(
    (await request('admin', order.id, reordered, key)).body,
    first.body,
  )
  assert(isDeepStrictEqual(await snapshot(), before))
  for (const data of [input('different'), { ...input(), expectedVersion: 2 }])
    await rejected(
      () => request('admin', order.id, data, key),
      409,
      'IDEMPOTENCY_CONFLICT',
    )
  await rejected(
    () => request('admin', randomUUID(), input(), key),
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
  assert.equal(record.operation, 'ADMIN_ORDER_EDIT')
  assert.deepEqual(record.responseJson, first.body)
  assert(!JSON.stringify(record).includes(key))
  const response = await fetch(base + '/api/v1/admin/orders', {
    method: 'POST',
    headers: {
      cookie: cookies.admin,
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      userId: alice.id,
      productId,
      amountFen: 1000,
      formData: original,
    }),
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'IDEMPOTENCY_CONFLICT')
})

test('true concurrent same-key edits replay one complete success for each role', async () => {
  for (const role of ['customer', 'admin'] as const) {
    const order = await fixture(),
      key = randomUUID(),
      before = await snapshot()
    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(role, order.id, input(), key)),
    )
    assert(
      results.every((r) => r.status === 200),
      JSON.stringify(results.map((r) => r.body)),
    )
    assert(results.every((r) => isDeepStrictEqual(r.body, results[0].body)))
    const after = await snapshot()
    for (const table of ['OrderRevision', 'OrderEvent', 'IdempotencyRecord'])
      assert.equal(after[table].length, before[table].length + 1)
    assert.equal(
      after.AdminAuditLog.length,
      before.AdminAuditLog.length + (role === 'admin' ? 1 : 0),
    )
    assert.equal(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).version,
      2,
    )
  }
})

test('true concurrent different keys on one expectedVersion have exactly one winner and no stale side effects', async () => {
  const order = await fixture(),
    before = await snapshot()
  const results = await Promise.all([
    request('admin', order.id, input('admin edit')),
    request('customer', order.id, input('customer edit')),
  ])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  assert.equal(
    results.find((r) => r.status === 409)!.body.error.code,
    'VERSION_CONFLICT',
  )
  const after = await snapshot()
  for (const table of ['OrderRevision', 'OrderEvent', 'IdempotencyRecord'])
    assert.equal(after[table].length, before[table].length + 1)
  assert.equal(
    after.AdminAuditLog.length,
    before.AdminAuditLog.length + (results[0].status === 200 ? 1 : 0),
  )
  assert.equal(
    (await db.order.findUniqueOrThrow({ where: { id: order.id } })).version,
    2,
  )
})

test('true concurrent different intents sharing a key return one success and one idempotency conflict', async () => {
  const order = await fixture(),
    before = await snapshot(),
    key = randomUUID()
  const results = await Promise.all(
    ['first', 'second'].map((value) =>
      request('customer', order.id, input(value), key),
    ),
  )
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
  assert.equal(
    results.find((r) => r.status === 409)!.body.error.code,
    'IDEMPOTENCY_CONFLICT',
  )
  const after = await snapshot()
  for (const table of ['OrderRevision', 'OrderEvent', 'IdempotencyRecord'])
    assert.equal(after[table].length, before[table].length + 1)
})

test('failures at UPDATE, Revision, Event, Audit and idempotency insertion fully roll back form, money, zero transition and history', async () => {
  for (const role of ['admin', 'customer'] as const) {
    for (const table of [
      'Order',
      'OrderRevision',
      'OrderEvent',
      ...(role === 'admin' ? ['AdminAuditLog'] : []),
      'IdempotencyRecord',
    ]) {
      const order = await fixture(),
        key = randomUUID()
      const data = {
        ...input(),
        ...(role === 'admin'
          ? { amountFen: 0, priceAdjustmentReason: 'Gift' }
          : {}),
      }
      sql(
        `CREATE TRIGGER Edit_test_failure BEFORE ${table === 'Order' ? 'UPDATE' : 'INSERT'} ON \`${table}\` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ISOLATED_EDIT_FAILURE';`,
      )
      try {
        await rejected(() => request(role, order.id, data, key), 503)
      } finally {
        sql('DROP TRIGGER Edit_test_failure;')
      }
      const retry = await request(role, order.id, data, key)
      assert.equal(retry.status, 200, JSON.stringify(retry.body))
      assert.equal(retry.body.order.version, 2)
      assert.equal(
        await db.orderRevision.count({ where: { orderId: order.id } }),
        2,
      )
    }
  }
})

test('waiting for a locked order rechecks database expiry rather than using request-arrival time', async () => {
  const order = await fixture()
  let unlock!: () => void, ready!: () => void
  const gate = new Promise<void>((r) => {
      unlock = r
    }),
    acquired = new Promise<void>((r) => {
      ready = r
    })
  const writer = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${order.id} FOR UPDATE`
    ready()
    await gate
    await tx.$executeRaw`UPDATE \`Order\` SET createdAt = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 24 HOUR), version = version + 1 WHERE id = ${order.id}`
  })
  await acquired
  let settled = false
  const pending = request('customer', order.id, input()).then((r) => {
    settled = true
    return r
  })
  try {
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(settled, false)
  } finally {
    unlock()
  }
  await writer
  const result = await pending
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'ORDER_NOT_EDITABLE')
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 0)
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    1,
  )
  assert.equal(
    (await db.order.findUniqueOrThrow({ where: { id: order.id } })).version,
    2,
  )
})

test('both order editors accept 64 KiB and retain the original short revision', async () => {
  const frozen = { version: 1, fields: longTextFields }
  const formData = formDataAtLimit()
  assert.equal(jsonBytes(formData), 65_536)
  for (const role of ['customer', 'admin'] as const) {
    const old = await fixture({
      formSchemaSnapshot: frozen,
      formData: { note: '历史短文本' },
    })
    const reject = await request(role, old.id, {
      expectedVersion: 1,
      formData: { ...formData, extra: formData.extra + 'x' },
    })
    assert.equal(reject.status, 400)
    assert.match(reject.body.error.message, /填写信息不能超过 64 KiB/)
    const unchanged = await db.order.findUniqueOrThrow({
      where: { id: old.id },
    })
    assert.deepEqual(unchanged.formData, old.formData)
    assert.equal(unchanged.version, 1)
    const updated = await request(role, old.id, {
      expectedVersion: 1,
      formData,
    })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.order.version, 2)
    assert.deepEqual(updated.body.order.formData, formData)
    const revisions = await db.orderRevision.findMany({
      where: { orderId: old.id },
      orderBy: { version: 'asc' },
    })
    const stored = await db.order.findUniqueOrThrow({ where: { id: old.id } })
    assert.deepEqual(stored.formSchemaSnapshot, frozen)
    assert.deepEqual(
      revisions.map((revision) => revision.snapshotJson),
      [buildOrderSnapshot(old), buildOrderSnapshot(stored)],
    )
  }
})
