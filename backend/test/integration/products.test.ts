import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { formSchemaAtLimit, jsonBytes } from '../long-text-fixture.ts'
import { createApp } from '../../src/app.ts'
import { createDatabase, checkDatabase } from '../../src/db/client.ts'
import { activeCredentials, integrationEnvironment } from './support.ts'
import { productService } from '../../src/modules/products/service.ts'
import { settingsService } from '../../src/modules/settings/service.ts'
import { createProduct } from '../../src/modules/products/schemas.ts'
import {
  tokenHash,
  COOKIE_NAME,
  newToken,
} from '../../src/modules/auth/security.ts'
const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
let server: Server,
  base: string,
  cookie = '',
  adminId = '',
  productId = ''
const original = {
  name: 'Persisted product',
  type: 'SUBSCRIPTION',
  priceFen: 1234,
  renewalPriceFen: 999,
  termLabel: '供应商确认周期',
  servicePeriodUnit: 'MONTH',
  servicePeriodCount: 1,
}
const formSchema = {
  version: 1,
  fields: [
    {
      id: 'text_id',
      type: 'text',
      label: '<b>literal label</b>',
      required: true,
      hint: 'safe hint',
      defaultValue: 'original',
    },
    {
      id: 'email_id',
      type: 'email',
      label: '邮箱',
      required: false,
      defaultValue: 'fixture@example.com',
    },
    {
      id: 'area_id',
      type: 'textarea',
      label: '说明',
      required: false,
      defaultValue: 'line1\nline2',
    },
    {
      id: 'select_id',
      type: 'select',
      label: '方案',
      required: false,
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      defaultValue: 'a',
    },
    {
      id: 'radio_id',
      type: 'radio',
      label: '选项',
      required: false,
      options: [{ label: 'R', value: 'r' }],
      defaultValue: 'r',
    },
    {
      id: 'check_id',
      type: 'checkbox',
      label: '多选',
      required: false,
      options: [{ label: 'C', value: 'c' }],
      defaultValue: ['c'],
    },
    {
      id: 'number_id',
      type: 'number',
      label: '数量',
      required: false,
      defaultValue: 2.5,
    },
    {
      id: 'date_id',
      type: 'date',
      label: '日期',
      required: false,
      defaultValue: '2028-02-29',
    },
  ],
}
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  session = cookie,
  extra: Record<string, string> = {},
) {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      origin: env.APP_BASE_URL,
      'x-requested-with': 'MembershipStore',
      'content-type': 'application/json',
      cookie: session,
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return {
    status: response.status,
    body: await response.json(),
    headers: response.headers,
  }
}
async function start() {
  server = createApp(() => checkDatabase(db), { database: db, env }).listen(
    0,
    '127.0.0.1',
  )
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  base = 'http://127.0.0.1:' + address.port
}
const stop = () =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
before(async () => {
  await start()
  const login = await request(
    '/auth/login',
    'POST',
    { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD },
    '',
  )
  assert.equal(login.status, 200)
  cookie = login.headers.get('set-cookie')!.split(';')[0]!
  adminId = login.body.user.id
})
after(async () => {
  if (server) await stop()
  await db.$disconnect()
})
test('every product/settings endpoint requires ADMIN session and mutations require CSRF protection', async () => {
  const token = newToken()
  const customer = await db.user.create({
    data: {
      adminLabel: 'Permission fixture',
      loginEmail: randomUUID() + '@example.com',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      ...(await activeCredentials()),
    },
  })
  await db.session.create({
    data: {
      userId: customer.id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 60000),
    },
  })
  for (const [path, method] of [
    ['/products', 'GET'],
    ['/products', 'POST'],
    ['/products/' + randomUUID(), 'GET'],
    ['/products/' + randomUUID(), 'PATCH'],
    ['/products/' + randomUUID() + '/archive', 'POST'],
    ['/settings', 'GET'],
    ['/settings', 'PATCH'],
  ]) {
    assert.equal(
      (
        await request(
          '/admin' + path,
          method,
          method === 'GET' ? undefined : {},
          '',
        )
      ).status,
      401,
    )
    assert.equal(
      (
        await request(
          '/admin' + path,
          method,
          method === 'GET' ? undefined : {},
          COOKIE_NAME + '=' + token,
        )
      ).status,
      403,
    )
  }
  assert.equal(
    (
      await request('/admin/products', 'POST', original, cookie, {
        origin: 'http://evil.invalid',
      })
    ).status,
    403,
  )
})
test('create stores all field types with safe defaults, independent schema, integer prices and sorting', async () => {
  const created = await request('/admin/products', 'POST', {
    ...original,
    formSchema,
    sortOrder: 7,
  })
  assert.equal(created.status, 201)
  const p = created.body.product
  productId = p.id
  assert.deepEqual(
    [p.priceFen, p.renewalPriceFen, p.listed, p.targetField],
    [1234, 999, false, 'NONE'],
  )
  assert.equal(p.archivedAt, null)
  assert(!('purchaseEnabled' in p))
  assert(!('renewalEnabled' in p))
  assert.equal(p.formSchema.fields.length, 8)
  assert.match(p.slug, /^product-/)
  const other = await request('/admin/products', 'POST', {
    ...original,
    name: 'Separate schema',
    sortOrder: 2,
  })
  assert.deepEqual(other.body.product.formSchema, { version: 1, fields: [] })
  const list = await request('/admin/products?search=schema&pageSize=1')
  assert.equal(list.body.items[0].id, other.body.product.id)
  assert.equal(list.body.total, 1)
  const ordered = await request('/admin/products?archived=ACTIVE&pageSize=100')
  const ids = ordered.body.items.map((item: { id: string }) => item.id)
  assert(ids.indexOf(other.body.product.id) < ids.indexOf(p.id))
  assert.equal(
    (await request('/admin/products/' + p.id, 'PATCH', { sortOrder: 1 }))
      .status,
    200,
  )
  const reordered = await request(
    '/admin/products?archived=ACTIVE&pageSize=100',
  )
  const reorderedIds = reordered.body.items.map(
    (item: { id: string }) => item.id,
  )
  assert(
    reorderedIds.indexOf(p.id) < reorderedIds.indexOf(other.body.product.id),
  )
  assert.equal(
    (await request('/admin/products?search=Persisted')).body.items[0].id,
    p.id,
  )
  assert.equal(
    (
      await db.adminAuditLog.findFirstOrThrow({
        where: { entityId: p.id, action: 'PRODUCT_CREATED' },
      })
    ).actorAdminId,
    adminId,
  )
})
test('server rejects invalid prices, types, fields, options, defaults, IDs and query inputs', async () => {
  for (const patch of [
    { priceFen: 1.2 },
    { priceFen: -1 },
    { priceFen: 2147483648 },
    { priceFen: '1234' },
    { type: 'UNKNOWN' },
    { renewalPriceFen: null },
    { type: 'ONE_TIME', renewalPriceFen: 1 },
    {
      formSchema: {
        version: 1,
        fields: [formSchema.fields[0], formSchema.fields[0]],
      },
    },
    {
      formSchema: {
        version: 1,
        fields: [{ ...formSchema.fields[3], options: [] }],
      },
    },
    {
      formSchema: {
        version: 1,
        fields: [{ ...formSchema.fields[3], defaultValue: 'missing' }],
      },
    },
    {
      formSchema: {
        version: 1,
        fields: [{ ...formSchema.fields[0], type: 'script' }],
      },
    },
    {
      formSchema: {
        version: 1,
        fields: [{ ...formSchema.fields[0], html: '<script>unsafe</script>' }],
      },
    },
    { targetField: 'EMAIL' },
    { archivedAt: new Date().toISOString() },
    { purchaseEnabled: false },
    { purchaseEnabled: true },
    { renewalEnabled: false },
    { renewalEnabled: true },
  ])
    assert.equal(
      (await request('/admin/products', 'POST', { ...original, ...patch }))
        .status,
      400,
    )
  assert.equal(
    (
      await request('/admin/products', 'POST', {
        ...original,
        formSchema: {
          version: 1,
          fields: Array.from({ length: 21 }, (_, i) => ({
            ...formSchema.fields[0],
            id: 'field_' + i,
          })),
        },
      })
    ).status,
    400,
  )
  assert.equal((await request('/admin/products?listed=1')).status, 400)
  assert.equal((await request('/admin/products?unknown=1')).status, 400)
  assert.equal((await request('/admin/products/' + randomUUID())).status, 404)
  assert.equal((await request('/admin/products/not-an-id')).status, 400)
  assert.equal(
    (await request('/admin/products/' + productId, 'PATCH', {})).status,
    400,
  )
  assert.equal(
    (
      await request('/admin/products/' + productId, 'PATCH', {
        type: 'ONE_TIME',
        servicePeriodUnit: 'MONTH',
        servicePeriodCount: 1,
      })
    ).status,
    400,
  )
  const one = await request('/admin/products', 'POST', {
    ...original,
    type: 'ONE_TIME',
    renewalPriceFen: null,
    servicePeriodUnit: null,
    servicePeriodCount: null,
  })
  assert.equal(one.status, 201)
  assert.equal(
    (
      await request('/admin/products/' + one.body.product.id, 'PATCH', {
        renewalEnabled: true,
      })
    ).status,
    400,
  )
})
test('listing controls catalog visibility while unlisted unarchived products remain available to administrators', async () => {
  const orders = await db.order.count(),
    subscriptions = await db.subscription.count()
  for (const listed of [false, true, false]) {
    const updated = await request('/admin/products/' + productId, 'PATCH', {
      listed,
    })
    assert.equal(updated.status, 200)
    assert.equal(updated.body.product.listed, listed)
    const p = (await request('/admin/products/' + productId)).body.product
    assert.equal(p.listed, listed)
    assert.equal(p.archivedAt, null)
    const catalog = await request(
      '/admin/products?listed=true&archived=ACTIVE&search=Persisted',
    )
    assert.equal(catalog.body.total, listed ? 1 : 0)
    // Future ADMIN offline selectors must not filter on listed; no order/subscription writes here.
    for (const type of ['', '&type=SUBSCRIPTION']) {
      const available = await request(
        '/admin/products?archived=ACTIVE&search=Persisted' + type,
      )
      assert(
        available.body.items.some(
          (item: { id: string }) => item.id === productId,
        ),
      )
      if (type)
        assert(
          available.body.items.every(
            (item: { type: string }) => item.type === 'SUBSCRIPTION',
          ),
        )
    }
  }
  for (const field of ['purchaseEnabled', 'renewalEnabled'])
    for (const value of [false, true])
      assert.equal(
        (
          await request('/admin/products/' + productId, 'PATCH', {
            [field]: value,
          })
        ).status,
        400,
      )
  assert.equal(await db.order.count(), orders)
  assert.equal(await db.subscription.count(), subscriptions)
})
test('editing configuration and archiving preserve accounts, invitations, sessions and immutable order/subscription history', async () => {
  const users = await db.user.findMany(),
    sessions = await db.session.findMany(),
    invitations = await db.invitationToken.findMany()
  const user = users.find((u) => u.role === 'CUSTOMER')!
  const order = await db.order.create({
    data: {
      orderNo: 'PRODUCT-HISTORY',
      source: 'ADMIN',
      userId: user.id,
      productId,
      kind: 'INITIAL',
      productNameSnapshot: original.name,
      productTypeSnapshot: 'SUBSCRIPTION',
      termSnapshot: 'Confirmed old term',
      servicePeriodUnitSnapshot: 'DAY',
      servicePeriodCountSnapshot: 30,
      amountFen: 1234,
      contactEmailSnapshot: user.loginEmail,
      createdByAdminId: adminId,
    },
  })
  const sub = await db.subscription.create({
    data: {
      userId: user.id,
      productId,
      sourceType: 'ADMIN',
      productNameSnapshot: 'Frozen subscription',
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: 1234,
      termSnapshot: 'Frozen term',
      targetIdentifier: 'history@example.com',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      renewalPriceFen: 999,
      createdByAdminId: adminId,
    },
  })
  const result = await request('/admin/products/' + productId, 'PATCH', {
    name: 'Changed current name',
    priceFen: 5678,
    servicePeriodUnit: 'YEAR',
    servicePeriodCount: 2,
    listed: true,
    formSchema: { version: 1, fields: [...formSchema.fields].reverse() },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.product.formSchema.fields[0].id, 'date_id')
  const firstArchive = await request(
    '/admin/products/' + productId + '/archive',
    'POST',
    {},
  )
  assert.equal(firstArchive.status, 200)
  const repeatedArchive = await request(
    '/admin/products/' + productId + '/archive',
    'POST',
    {},
  )
  assert.equal(repeatedArchive.status, 200)
  assert.equal(
    repeatedArchive.body.product.archivedAt,
    firstArchive.body.product.archivedAt,
  )
  const archived = (await request('/admin/products/' + productId)).body.product
  assert.equal(archived.listed, false)
  assert(archived.archivedAt)
  const archiveAudit = await db.adminAuditLog.findFirstOrThrow({
    where: { entityId: productId, action: 'PRODUCT_ARCHIVED' },
  })
  assert.deepEqual(archiveAudit.beforeJson, { listed: true, archivedAt: null })
  assert.deepEqual(archiveAudit.afterJson, {
    listed: false,
    archivedAt: archived.archivedAt,
  })
  assert.equal(
    (await request('/admin/products/' + productId, 'PATCH', { listed: true }))
      .status,
    409,
  )
  assert.equal(
    (
      await request('/admin/products/' + productId, 'PATCH', {
        archivedAt: null,
      })
    ).status,
    400,
  )
  assert.equal(
    await db.adminAuditLog.count({
      where: { entityId: productId, action: 'PRODUCT_ARCHIVED' },
    }),
    1,
  )
  assert.equal(
    (
      await request('/admin/products/' + productId, 'PATCH', {
        name: 'Forbidden',
      })
    ).status,
    409,
  )
  assert.equal(
    (
      await request(
        '/admin/products?archived=ACTIVE&search=Changed%20current%20name',
      )
    ).body.total,
    0,
  )
  assert.equal(
    (
      await request(
        '/admin/products?archived=ARCHIVED&search=Changed%20current%20name',
      )
    ).body.total,
    1,
  )
  assert.equal(
    (await request('/admin/products/' + productId, 'DELETE', {})).status,
    404,
  )
  assert.deepEqual(
    await db.order.findUniqueOrThrow({ where: { id: order.id } }),
    order,
  )
  assert.deepEqual(
    await db.subscription.findUniqueOrThrow({ where: { id: sub.id } }),
    sub,
  )
  assert.deepEqual(await db.user.findMany(), users)
  assert.deepEqual(await db.session.findMany(), sessions)
  assert.deepEqual(await db.invitationToken.findMany(), invitations)
})
test('archive is atomic with its audit and concurrent duplicate archives keep the same timestamp', async () => {
  for (const listed of [false, true]) {
    const created = await request('/admin/products', 'POST', {
      ...original,
      listed,
    })
    assert.equal(created.status, 201)
    const id = created.body.product.id
    await assert.rejects(
      productService(db).archive(id, adminId, 'x'.repeat(100)),
    )
    const unchanged = (await request('/admin/products/' + id)).body.product
    assert.equal(unchanged.listed, listed)
    assert.equal(unchanged.archivedAt, null)
    const results = await Promise.all([
      request('/admin/products/' + id + '/archive', 'POST', {}),
      request('/admin/products/' + id + '/archive', 'POST', {}),
    ])
    for (const result of results) {
      assert.equal(result.status, 200)
      assert.equal(result.body.product.listed, false)
      assert.equal(
        result.body.product.archivedAt,
        results[0]!.body.product.archivedAt,
      )
    }
    assert.equal(
      await db.adminAuditLog.count({
        where: { entityId: id, action: 'PRODUCT_ARCHIVED' },
      }),
      1,
    )
    assert.equal(
      (await request('/admin/products/' + id, 'PATCH', { listed: true }))
        .status,
      409,
    )
  }
})
test('settings persist only allowed fields, leave admin identity unchanged and audit writes roll back atomically', async () => {
  const admin = await db.user.findUniqueOrThrow({ where: { id: adminId } })
  for (const input of [
    { storeName: '' },
    { ownerEmail: 'bad' },
    { timezone: 'Unknown/Zone' },
    { timezone: '+08:00' },
    { smtpPassword: 'never' },
    { paymentKey: 'never' },
    {},
  ])
    assert.equal((await request('/admin/settings', 'PATCH', input)).status, 400)
  const input = {
    storeName: 'Persisted settings',
    ownerEmail: 'notifications@example.com',
    timezone: 'UTC',
    paymentInstructions: 'Private order payment instructions',
  }
  assert.equal((await request('/admin/settings', 'PATCH', input)).status, 200)
  const saved = (await request('/admin/settings')).body.settings
  assert.equal(saved.storeName, input.storeName)
  assert.equal(saved.ownerEmail, input.ownerEmail)
  assert.equal(saved.timezone, input.timezone)
  assert.equal(saved.paymentInstructions, input.paymentInstructions)
  const publicConfig = await request('/storefront/config', 'GET', undefined, '')
  assert.equal(publicConfig.status, 200)
  assert.deepEqual(publicConfig.body, { storeName: input.storeName })
  assert.equal(publicConfig.headers.get('cache-control'), 'no-store')
  assert.equal(publicConfig.headers.get('set-cookie'), null)
  assert.equal(
    (
      await request(
        '/storefront/config',
        'PATCH',
        { storeName: 'Public write' },
        '',
      )
    ).status,
    404,
  )
  assert.deepEqual(
    await db.user.findUniqueOrThrow({ where: { id: adminId } }),
    admin,
  )
  const count = await db.product.count()
  await assert.rejects(
    productService(db).create(
      createProduct.parse({ ...original, name: 'Must roll back' }),
      adminId,
      'x'.repeat(100),
    ),
  )
  assert.equal(await db.product.count(), count)
  await assert.rejects(
    settingsService(db).edit(
      { storeName: 'Must roll back' },
      adminId,
      'x'.repeat(100),
    ),
  )
  assert.equal(
    (await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })).storeName,
    input.storeName,
  )
  const audit = await db.adminAuditLog.findFirstOrThrow({
    where: { action: 'SETTINGS_UPDATED' },
  })
  assert(!JSON.stringify(audit.afterJson).includes(input.ownerEmail))
})
test('HTTP product creation validates all period units, complete pairs and integer counts', async () => {
  for (const [servicePeriodUnit, servicePeriodCount] of [
    ['DAY', 7],
    ['MONTH', 1],
    ['MONTH', 12],
    ['YEAR', 1],
  ]) {
    const result = await request('/admin/products', 'POST', {
      ...original,
      name: 'Period-' + randomUUID(),
      servicePeriodUnit,
      servicePeriodCount,
    })
    assert.equal(result.status, 201)
    const id = result.body.product.id
    for (const p of [
      result.body.product,
      (await request('/admin/products/' + id)).body.product,
      (await request('/admin/products?search=' + result.body.product.name)).body
        .items[0],
      await db.product.findUniqueOrThrow({ where: { id } }),
    ]) {
      assert.equal(p.servicePeriodUnit, servicePeriodUnit)
      assert.equal(p.servicePeriodCount, servicePeriodCount)
      assert.equal(p.termLabel, original.termLabel)
    }
  }
  const withoutPeriod = {
    name: original.name,
    type: original.type,
    priceFen: original.priceFen,
    renewalPriceFen: original.renewalPriceFen,
    termLabel: original.termLabel,
  }
  const before = [await db.product.count(), await db.adminAuditLog.count()]
  for (const fields of [
    {},
    { servicePeriodUnit: 'DAY' },
    { servicePeriodCount: 1 },
    { servicePeriodUnit: null, servicePeriodCount: null },
    ...[0, -1, 1.5, 2147483648, '1', true].map((servicePeriodCount) => ({
      servicePeriodUnit: 'DAY',
      servicePeriodCount,
    })),
    { servicePeriodUnit: 'WEEK', servicePeriodCount: 1 },
  ])
    assert.equal(
      (
        await request('/admin/products', 'POST', {
          ...withoutPeriod,
          ...fields,
        })
      ).status,
      400,
    )
  assert.deepEqual(
    [await db.product.count(), await db.adminAuditLog.count()],
    before,
  )
})

test('legacy unknown periods allow unrelated edits, never infer termLabel and require an explicit complete pair', async () => {
  const legacy = await db.product.create({
    data: {
      slug: 'legacy-' + randomUUID(),
      name: 'Unknown period fixture',
      type: 'SUBSCRIPTION',
      priceFen: 123,
      renewalPriceFen: 99,
      termLabel: '30 天 / 1 个月 / 1 年仅展示',
    },
  })
  const path = '/admin/products/' + legacy.id
  const detail = await request(path)
  assert.equal(detail.body.product.servicePeriodUnit, null)
  assert.equal(detail.body.product.servicePeriodCount, null)
  assert.equal(
    (await request(path, 'PATCH', { name: 'Still unknown', listed: true }))
      .status,
    200,
  )
  const unchanged = await db.product.findUniqueOrThrow({
    where: { id: legacy.id },
  })
  assert.equal(unchanged.servicePeriodUnit, null)
  assert.equal(unchanged.servicePeriodCount, null)
  const audits = await db.adminAuditLog.count()
  for (const fields of [
    { servicePeriodUnit: 'MONTH' },
    { servicePeriodCount: 12 },
    { servicePeriodUnit: 'MONTH', servicePeriodCount: null },
    { servicePeriodUnit: null, servicePeriodCount: 12 },
    { servicePeriodUnit: null, servicePeriodCount: null },
  ]) {
    assert.equal((await request(path, 'PATCH', fields)).status, 400)
    assert.deepEqual(
      await db.product.findUniqueOrThrow({ where: { id: legacy.id } }),
      unchanged,
    )
  }
  assert.equal(await db.adminAuditLog.count(), audits)
  const completed = await request(path, 'PATCH', {
    servicePeriodUnit: 'MONTH',
    servicePeriodCount: 12,
  })
  assert.equal(completed.status, 200)
  assert.equal(completed.body.product.servicePeriodUnit, 'MONTH')
  assert.equal(completed.body.product.servicePeriodCount, 12)
  const saved = await db.product.findUniqueOrThrow({ where: { id: legacy.id } })
  assert.equal(saved.termLabel, legacy.termLabel)
  assert.equal(
    (
      await request(path, 'PATCH', {
        servicePeriodUnit: null,
        servicePeriodCount: null,
      })
    ).status,
    400,
  )
  await assert.rejects(
    productService(db).edit(
      legacy.id,
      { servicePeriodUnit: 'YEAR', servicePeriodCount: 2 },
      adminId,
      'x'.repeat(100),
    ),
  )
  assert.deepEqual(
    await db.product.findUniqueOrThrow({ where: { id: legacy.id } }),
    saved,
  )
})

test('HTTP type transitions validate merged records and clear one-time renewal prices and periods', async () => {
  const once = {
    name: 'Type transition',
    type: 'ONE_TIME',
    priceFen: 100,
    renewalPriceFen: null,
    termLabel: '展示说明',
  }
  for (const fields of [
    { servicePeriodUnit: 'DAY', servicePeriodCount: 1 },
    { servicePeriodUnit: 'DAY', servicePeriodCount: null },
    { servicePeriodUnit: null, servicePeriodCount: 1 },
  ])
    assert.equal(
      (await request('/admin/products', 'POST', { ...once, ...fields })).status,
      400,
    )
  const created = await request('/admin/products', 'POST', {
    ...once,
    servicePeriodUnit: null,
    servicePeriodCount: null,
  })
  assert.equal(created.status, 201)
  const path = '/admin/products/' + created.body.product.id
  assert.equal(created.body.product.servicePeriodUnit, null)
  assert.equal(created.body.product.servicePeriodCount, null)
  for (const patch of [
    { type: 'SUBSCRIPTION' },
    { type: 'SUBSCRIPTION', renewalPriceFen: 99 },
    { type: 'SUBSCRIPTION', servicePeriodUnit: 'YEAR', servicePeriodCount: 1 },
    { servicePeriodUnit: 'DAY', servicePeriodCount: 1 },
  ])
    assert.equal((await request(path, 'PATCH', patch)).status, 400)
  const subscription = await request(path, 'PATCH', {
    type: 'SUBSCRIPTION',
    renewalPriceFen: 99,
    servicePeriodUnit: 'YEAR',
    servicePeriodCount: 1,
  })
  assert.equal(subscription.status, 200)
  assert.equal(subscription.body.product.renewalPriceFen, 99)
  assert.equal(
    (
      await request(path, 'PATCH', {
        type: 'ONE_TIME',
        servicePeriodUnit: 'YEAR',
        servicePeriodCount: 1,
      })
    ).status,
    400,
  )
  const reverted = await request(path, 'PATCH', { type: 'ONE_TIME' })
  assert.equal(reverted.status, 200)
  for (const field of [
    'servicePeriodUnit',
    'servicePeriodCount',
    'renewalPriceFen',
  ])
    assert.equal(reverted.body.product[field], null)
  assert.equal((await request(path)).body.product.termLabel, once.termLabel)
})

test('new API instance and database connection read persisted product/schema/settings with existing session', async () => {
  const period = await request('/admin/products', 'POST', {
    ...original,
    name: 'Reconnected period',
    servicePeriodUnit: 'YEAR',
    servicePeriodCount: 2,
  })
  assert.equal(period.status, 201)
  await db.product.create({
    data: {
      slug: 'restart-persistence',
      name: 'Restart proof',
      type: 'ONE_TIME',
      priceFen: 100,
      termLabel: '一次',
      formSchema: { version: 1, fields: [] },
    },
  })
  await stop()
  await db.$disconnect()
  await start()
  const list = await request('/admin/products?search=Restart')
  assert.equal(list.status, 200)
  assert.equal(list.body.total, 1)
  assert.equal(list.body.items[0].servicePeriodUnit, null)
  assert.equal(list.body.items[0].servicePeriodCount, null)
  const persisted = (await request('/admin/products/' + period.body.product.id))
    .body.product
  assert.equal(persisted.servicePeriodUnit, 'YEAR')
  assert.equal(persisted.servicePeriodCount, 2)
  assert.equal(
    (await request('/admin/settings')).body.settings.storeName,
    'Persisted settings',
  )
})

test('product creation and editing enforce the UTF-8 schema cap and persist accepted defaults', async () => {
  const formSchema = formSchemaAtLimit()
  assert.equal(jsonBytes(formSchema), 65_536)
  const created = await request('/admin/products', 'POST', {
    ...original,
    name: 'Long form ' + randomUUID(),
    formSchema,
  })
  assert.equal(created.status, 201)
  assert.deepEqual(created.body.product.formSchema, formSchema)
  const path = '/admin/products/' + created.body.product.id
  const first = formSchema.fields[0]!
  first.defaultValue = 'B' + first.defaultValue.slice(1)
  const updated = await request(path, 'PATCH', { formSchema })
  assert.equal(updated.status, 200)
  assert.deepEqual(updated.body.product.formSchema, formSchema)

  const oversized = structuredClone(formSchema)
  oversized.fields[2]!.defaultValue += 'x'
  assert.equal(jsonBytes(oversized), 65_537)
  for (const [url, method, input] of [
    ['/admin/products', 'POST', { ...original, formSchema: oversized }],
    [path, 'PATCH', { formSchema: oversized }],
  ] as const) {
    const rejected = await request(url, method, input)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.body.error.code, 'INVALID_INPUT')
    assert.match(rejected.body.error.message, /表单配置不能超过 64 KiB/)
  }
  const read = await request(path)
  assert.equal(read.status, 200)
  assert.deepEqual(read.body.product.formSchema, formSchema)
})
