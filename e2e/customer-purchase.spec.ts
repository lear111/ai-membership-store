import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { Prisma } from '../backend/src/generated/prisma/client.ts'
import { createDatabase } from '../backend/src/db/client.ts'
import {
  COOKIE_NAME,
  hashPassword,
  newToken,
  tokenHash,
} from '../backend/src/modules/auth/security.ts'
import { purchaseSchema } from '../backend/test/integration/purchase-fixture.ts'
import {
  activeCredentials,
  integrationEnvironment,
} from '../backend/test/integration/support.ts'

import {
  formDataAtLimit,
  longTextFields,
} from '../backend/test/long-text-fixture.ts'
import { pasteAtTextareaLimit } from './paste-textarea.ts'
const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const fixturePassword = 'FictionalPurchaseFixture456!'
const purchaseApi = '/api/v1/customer/products/'
const ordersApi = '/api/v1/customer/orders'
test.afterAll(() => db.$disconnect())

async function product(overrides: Partial<Prisma.ProductCreateInput> = {}) {
  const slug = 'purchase-' + randomUUID()
  return db.product.create({
    data: {
      slug,
      name: '购买验收 ' + slug.slice(-8),
      description: '<b>商品介绍</b>',
      type: 'SUBSCRIPTION',
      priceFen: 9900,
      renewalPriceFen: 8800,
      termLabel: '按月服务',
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
      listed: true,
      formSchema: purchaseSchema,
      ...overrides,
    },
  })
}

async function customer(login = false) {
  return db.user.create({
    data: {
      loginEmail: randomUUID() + '@purchase.example',
      role: 'CUSTOMER',
      status: 'ACTIVE',
      ...(await activeCredentials()),
      ...(login ? { passwordHash: await hashPassword(fixturePassword) } : {}),
    },
  })
}

async function signInSession(context: BrowserContext, userId: string) {
  const token = newToken()
  const session = await db.session.create({
    data: {
      userId,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  })
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      url: env.APP_BASE_URL,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
  return session.id
}

const input = (page: Page, label: string) =>
  page.getByLabel('服务信息 ' + label, { exact: true })
const buy = (page: Page) =>
  page.getByRole('button', { name: '立即购买', exact: true })
const check = (page: Page) =>
  page.getByRole('button', { name: '检查填写信息', exact: true })

async function expectLogin(page: Page, destination: string) {
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/login' &&
      url.searchParams.get('redirect') === destination,
  )
}

async function logIn(page: Page, email: string, password = fixturePassword) {
  await page.getByLabel('登录邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

test('guest buys from detail and returns to the same product after real login', async ({
  page,
}) => {
  const [item, user] = await Promise.all([product(), customer(true)])
  const destination = '/purchase/' + item.slug
  const reads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith(purchaseApi)) reads.push(path)
  })
  await page.goto('/products/' + item.slug)
  await expect(buy(page)).toBeEnabled()
  await expect(input(page, '账号标识')).toHaveCount(0)
  expect(reads).toEqual([])
  await buy(page).click()
  await expectLogin(page, destination)
  expect(reads).toEqual([])
  await db.product.update({ where: { id: item.id }, data: { priceFen: 4900 } })
  await logIn(page, user.loginEmail!)
  await expect(page).toHaveURL(destination)
  await expect(input(page, '账号标识')).toBeVisible()
  await expect(page.getByRole('heading', { name: item.name })).toBeVisible()
  await expect(page.locator('.purchase-content')).toContainText('49.00')
  await expect(page.locator('.purchase-content')).toContainText('88.00')
  await expect(page.locator('.purchase-content')).toContainText('1 个月')
  await expect(page.locator('.purchase-content')).toContainText(
    item.description!,
  )
  await expect(page.locator('.product-description b')).toHaveCount(0)
  expect(reads).toEqual([purchaseApi + item.slug])
})

test('ADMIN storefront login resumes the destination, including after expiry and logout', async ({
  page,
  context,
}) => {
  const [item, admin] = await Promise.all([
    product(),
    db.user.findUniqueOrThrow({ where: { loginEmail: env.ADMIN_EMAIL } }),
  ])
  const destination = '/purchase/' + item.slug
  const reads: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith(purchaseApi)) reads.push(path)
  })
  await page.goto(destination)
  await expectLogin(page, destination)
  await logIn(page, admin.loginEmail!, env.ADMIN_PASSWORD)
  await expect(page).toHaveURL(destination)
  await expect(input(page, '账号标识')).toBeVisible()
  expect(reads).toEqual([purchaseApi + item.slug])
  await expect(page.getByRole('link', { name: /管理控制台/ })).toBeVisible()
  const activeCookie = (await context.cookies()).find(
    (entry) => entry.name === COOKIE_NAME,
  )
  await db.session.update({
    where: { tokenHash: tokenHash(activeCookie!.value) },
    data: { expiresAt: new Date(Date.now() - 1000) },
  })
  await page.goto('/subscriptions')
  await expectLogin(page, '/subscriptions')
  await logIn(page, admin.loginEmail!, env.ADMIN_PASSWORD)
  await expect(page).toHaveURL('/subscriptions')
  await page.goto('/profile')
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL('/login')
  await page.goto('/account/orders')
  await expectLogin(page, '/account/orders')
})

test('login rejects external, traversal and encoded redirect destinations', async ({
  page,
  context,
}) => {
  const user = await customer(true)
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === env.APP_BASE_URL
      ? route.continue()
      : route.abort(),
  )
  for (const target of [
    'https://evil.example',
    '//evil.example',
    '/purchase/../admin',
    '/purchase/a%2Fb',
  ]) {
    await page.goto('/login?' + new URLSearchParams({ redirect: target }))
    await logIn(page, user.loginEmail!)
    await expect(page).toHaveURL('/profile')
  }
})

test('signed-in buyer sees eight empty inputs and checks values locally', async ({
  page,
  context,
}) => {
  const [item, user] = await Promise.all([product(), customer()])
  await signInSession(context, user.id)
  const requests: string[] = []
  let checkedInputs = false
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (checkedInputs && path.startsWith('/api/')) requests.push(path)
  })
  await page.goto('/products/' + item.slug)
  await buy(page).click()
  await expect(page).toHaveURL('/purchase/' + item.slug)
  const handle = input(page, '账号标识')
  await expect(handle).toBeVisible()
  for (const label of ['账号标识', '联系邮箱', '补充说明', '数量', '起始日期'])
    await expect(input(page, label)).toHaveValue('')
  const region = page.getByRole('combobox', { name: '服务信息 地区' })
  const radio = page.getByRole('radio', { name: '邮件' })
  const checkbox = page.getByRole('checkbox', { name: '学习' })
  await expect(region).toBeVisible()
  await expect(page.locator('.purchase-form')).not.toContainText('亚洲')
  await expect(radio).not.toBeChecked()
  await expect(checkbox).not.toBeChecked()
  await expect(
    page.getByText('<b>请输入公开标识</b>', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.purchase-form b')).toHaveCount(0)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)

  checkedInputs = true
  await check(page).click()
  await expect(page.getByRole('alert')).toContainText('账号标识 · 请填写必填项')
  await handle.fill('API key: fictional-input-only')
  await input(page, '联系邮箱').fill('invalid-email')
  await input(page, '数量').fill('9007199254740992')
  await check(page).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('账号标识 · 不得填写认证凭证')
  await expect(alert).toContainText('联系邮箱 · 请输入有效的邮箱地址')
  await expect(alert).toContainText('数量 · 请输入有效范围内的数字')
  await expect(alert).not.toContainText('fictional-input-only')

  await handle.fill('public-profile')
  await input(page, '联系邮箱').fill('fixture@example.com')
  await input(page, '补充说明').fill('可公开的补充说明')
  await input(page, '数量').fill('2.5')
  await input(page, '起始日期').fill('2028-02-29')
  await region.press('ArrowDown')
  await page.getByRole('option', { name: '亚洲', exact: true }).click()
  await page.getByText('邮件', { exact: true }).click()
  await page.getByText('学习', { exact: true }).click()
  await expect(radio).toBeChecked()
  await expect(checkbox).toBeChecked()
  await check(page).click()
  await expect(page.getByRole('heading', { name: '核对订单' })).toBeVisible()
  await expect(page.locator('.review-fields')).toContainText('亚洲')
  await expect(page.locator('.review-fields')).toContainText('邮件')
  await expect(page.locator('.review-fields')).toContainText('学习')
  expect(requests).toEqual([])
  expect(await db.order.count({ where: { userId: user.id } })).toBe(0)
})

test('leaving purchase discards the draft and a different product loads its own form', async ({
  page,
  context,
}) => {
  const [first, second, user] = await Promise.all([
    product(),
    product({
      formSchema: {
        version: 1,
        fields: [
          { id: 'next', type: 'text', label: '另一商品标识', required: true },
        ],
      },
    }),
    customer(),
  ])
  await signInSession(context, user.id)
  await page.goto('/purchase/' + first.slug)
  const marker = 'memory-only-draft-' + randomUUID()
  await input(page, '账号标识').fill(marker)
  expect(
    await page.evaluate(
      (text) =>
        [localStorage, sessionStorage].some((storage) =>
          Object.values(storage).some((value) => value.includes(text)),
        ),
      marker,
    ),
  ).toBe(false)
  expect(page.url()).not.toContain(marker)
  await page.getByRole('link', { name: '返回商品详情' }).click()
  await buy(page).click()
  await expect(input(page, '账号标识')).toHaveValue('')
  await page.getByRole('link', { name: '返回商品详情' }).click()
  await page.getByRole('link', { name: '返回商品目录' }).click()
  await page
    .getByRole('textbox', { name: '搜索商品', exact: true })
    .fill(second.name)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await page
    .getByRole('link', { name: '查看详情：' + second.name, exact: true })
    .click()
  await buy(page).click()
  await expect(page).toHaveURL('/purchase/' + second.slug)
  await expect(input(page, '另一商品标识')).toHaveValue('')
  await expect(input(page, '账号标识')).toHaveCount(0)
})

test('purchase renders no form while loading or when the product is unavailable', async ({
  page,
  context,
}) => {
  const [item, unsafe, user] = await Promise.all([
    product(),
    product({
      formSchema: {
        version: 1,
        fields: [
          {
            id: 'password',
            type: 'text',
            label: '不能公开的字段',
            required: true,
          },
        ],
      },
    }),
    customer(),
  ])
  await signInSession(context, user.id)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    (url) => url.pathname === purchaseApi + item.slug,
    async (route) => {
      await gate
      await route.continue()
    },
  )
  try {
    await page.goto('/purchase/' + item.slug)
    await expect(page.getByText('正在加载购买信息…')).toBeVisible()
    await expect(check(page)).toHaveCount(0)
  } finally {
    release()
  }
  await expect(check(page)).toBeVisible()
  await page.goto('/purchase/' + unsafe.slug)
  await expect(page.getByRole('alert')).toContainText(
    '此商品的服务表单暂不可用',
  )
  await expect(input(page, '不能公开的字段')).toHaveCount(0)
  await expect(check(page)).toHaveCount(0)
  await page.goto('/purchase/missing-product')
  await expect(page.getByRole('alert')).toContainText('商品不存在')
  await expect(check(page)).toHaveCount(0)
})

test('revocation between the route guard and purchase GET returns to login with the same path', async ({
  page,
  context,
}) => {
  const [item, user] = await Promise.all([product(), customer()])
  const sessionId = await signInSession(context, user.id)
  await page.route(
    (url) => url.pathname === purchaseApi + item.slug,
    async (route) => {
      await db.session.update({
        where: { id: sessionId },
        data: { revokedAt: new Date() },
      })
      await route.continue()
    },
    { times: 1 },
  )
  await page.goto('/purchase/' + item.slug)
  await expectLogin(page, '/purchase/' + item.slug)
  await expect(check(page)).toHaveCount(0)
})

const confirmOrder = (page: Page) =>
  page.getByRole('button', { name: '确认下单', exact: true })
const detail = (page: Page) =>
  page.getByRole('dialog', { name: '订单详情', exact: true })

async function review(page: Page, account = 'public-checkout-fixture') {
  await input(page, '账号标识').fill(account)
  await check(page).click()
  await expect(confirmOrder(page)).toBeVisible()
}

async function expectCreatedDetail(
  page: Page,
  order: { id: string; orderNo: string },
) {
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/account/orders' &&
      url.searchParams.get('orderId') === order.id &&
      [...url.searchParams.keys()].length === 1,
  )
  expect(order.orderNo).toMatch(/^[1-9][0-9]{8}$/)
  await expect(detail(page)).toContainText(
    order.orderNo.match(/.{3}/g)!.join(' '),
  )
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
}

async function expectPersistedOrder(
  userId: string,
  amountFen: number,
  key: string,
) {
  const orders = await db.order.findMany({ where: { userId } })
  expect(orders).toHaveLength(1)
  const [order] = orders
  expect(order).toMatchObject({ amountFen, source: 'USER', version: 1 })
  const [revisions, events, idempotency, payments, subscriptions, audits] =
    await Promise.all([
      db.orderRevision.findMany({ where: { orderId: order!.id } }),
      db.orderEvent.findMany({ where: { orderId: order!.id } }),
      db.idempotencyRecord.findMany({ where: { actorUserId: userId } }),
      db.paymentTransaction.count({ where: { orderId: order!.id } }),
      db.subscription.count({ where: { userId } }),
      db.adminAuditLog.count({ where: { entityId: order!.id } }),
    ])
  expect(revisions).toHaveLength(1)
  expect(revisions[0]).toMatchObject({
    version: 1,
    actorUserId: userId,
    actorType: 'USER',
  })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    eventType: 'ORDER_CREATED',
    actorUserId: userId,
  })
  expect(idempotency).toHaveLength(1)
  expect(
    idempotency[0]?.keyHash === createHash('sha256').update(key).digest('hex'),
  ).toBe(true)
  expect([payments, subscriptions, audits]).toEqual([0, 0, 0])
  return order!
}

test('guest opens the catalog, signs in, reviews, and creates exactly one payable order', async ({
  page,
}) => {
  const [item, user] = await Promise.all([product(), customer(true)])
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let posts = 0
  let key = ''
  let postBody: unknown
  await page.route(
    (url) => url.pathname === ordersApi,
    async (route) => {
      const request = route.request()
      if (request.method() === 'POST') {
        posts++
        key = request.headers()['idempotency-key']!
        postBody = request.postDataJSON()
        await gate
      }
      await route.continue()
    },
  )
  try {
    await page.goto('/')
    await page
      .getByRole('textbox', { name: '搜索商品', exact: true })
      .fill(item.name)
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await page
      .getByRole('link', { name: '查看详情：' + item.name, exact: true })
      .click()
    await buy(page).click()
    await expectLogin(page, '/purchase/' + item.slug)
    await logIn(page, user.loginEmail!)
    await review(page, 'discarded-review')
    await page.getByRole('button', { name: '返回修改' }).click()
    await expect(confirmOrder(page)).toHaveCount(0)
    await review(page, ' public-checkout-fixture ')
    await expect(page.locator('.purchase-content')).toContainText('应付金额')
    await expect(page.locator('.purchase-content')).toContainText('99.00')
    await expect(page.locator('.review-fields')).toContainText(
      'public-checkout-fixture',
    )
    await expectNoOverflow(page)
    await confirmOrder(page).evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await expect(page.getByText('正在提交订单…')).toBeVisible()
    await expect(confirmOrder(page)).toBeDisabled()
    await expect(page.getByRole('button', { name: '返回修改' })).toBeDisabled()
  } finally {
    release()
  }
  await expect(detail(page)).toContainText(item.name)
  expect(posts).toBe(1)
  expect(postBody).toEqual({
    productId: item.id,
    expectedProductUpdatedAt: item.updatedAt.toISOString(),
    formData: { handle: ' public-checkout-fixture ' },
  })
  const order = await expectPersistedOrder(user.id, item.priceFen, key)
  await expectCreatedDetail(page, order)
  expect(order.formData).toEqual({ handle: ' public-checkout-fixture ' })
  expect(order).toMatchObject({
    paymentStatus: 'UNPAID',
    fulfillmentStatus: 'NOT_STARTED',
  })
  await expect(detail(page)).toContainText('待付款')
  await expect(
    detail(page).getByRole('heading', { name: '微信扫码付款' }),
  ).toBeVisible()
  await expect(detail(page).locator('.customer-countdown')).toBeVisible()
  await expectNoOverflow(page)
})

test('a zero-amount order opens its detail without a payment prompt', async ({
  page,
  context,
}) => {
  const [item, user] = await Promise.all([product({ priceFen: 0 }), customer()])
  await signInSession(context, user.id)
  await page.goto('/purchase/' + item.slug)
  await review(page)
  const posted = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === ordersApi &&
      request.method() === 'POST',
  )
  await confirmOrder(page).click()
  const key = (await posted).headers()['idempotency-key']!
  await expect(detail(page)).toContainText(item.name)
  const order = await expectPersistedOrder(user.id, 0, key)
  await expectCreatedDetail(page, order)
  expect(order).toMatchObject({
    paymentStatus: 'NOT_REQUIRED',
    fulfillmentStatus: 'PROCESSING',
    paidAt: null,
    paymentConfirmedAt: null,
  })
  await expect(detail(page)).toContainText('处理中')
  await expect(
    detail(page).getByRole('heading', { name: '微信扫码付款' }),
  ).toHaveCount(0)
  await expect(detail(page).locator('.customer-countdown')).toHaveCount(0)
})

test('changed product discards the old draft and requires explicit new confirmation', async ({
  page,
  context,
}) => {
  const [item, user] = await Promise.all([product(), customer()])
  await signInSession(context, user.id)
  const keys: string[] = []
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname === ordersApi &&
      request.method() === 'POST'
    )
      keys.push(request.headers()['idempotency-key']!)
  })
  await page.goto('/purchase/' + item.slug)
  await review(page)
  await db.product.update({
    where: { id: item.id },
    data: {
      priceFen: 12300,
      servicePeriodCount: 2,
      updatedAt: new Date(item.updatedAt.getTime() + 1),
    },
  })
  await confirmOrder(page).click()
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: '商品信息已更新，请重新核对价格和服务信息后下单。' }),
  ).toBeVisible()
  await expect(input(page, '账号标识')).toHaveValue('')
  await expect(confirmOrder(page)).toHaveCount(0)
  await expect(page.locator('.purchase-content')).toContainText('123.00')
  await expect(page.locator('.purchase-content')).toContainText('2 个月')
  expect(await db.order.count({ where: { userId: user.id } })).toBe(0)
  expect(
    await db.idempotencyRecord.count({ where: { actorUserId: user.id } }),
  ).toBe(0)
  expect(keys).toHaveLength(1)
  await review(page)
  await confirmOrder(page).click()
  await expect(detail(page)).toContainText(item.name)
  expect(keys).toHaveLength(2)
  expect(keys[0] !== keys[1]).toBe(true)
  const order = await expectPersistedOrder(user.id, 12300, keys[1]!)
  expect(order.servicePeriodCountSnapshot).toBe(2)
  await expectCreatedDetail(page, order)
})

for (const archive of [false, true]) {
  test(`product ${archive ? 'archived' : 'unlisted'} during review becomes unavailable`, async ({
    page,
    context,
  }) => {
    const [item, user] = await Promise.all([product(), customer()])
    await signInSession(context, user.id)
    await page.goto('/purchase/' + item.slug)
    await review(page)
    await db.product.update({
      where: { id: item.id },
      data: {
        listed: false,
        archivedAt: archive ? new Date() : null,
        updatedAt: new Date(item.updatedAt.getTime() + 1),
      },
    })
    await confirmOrder(page).click()
    await expect(page.getByRole('alert')).toContainText('商品不可购买')
    await expect(page.getByRole('link', { name: '返回商品目录' })).toBeVisible()
    await expect(check(page)).toHaveCount(0)
    await expect(confirmOrder(page)).toHaveCount(0)
    expect(await db.order.count({ where: { userId: user.id } })).toBe(0)
    expect(
      await db.idempotencyRecord.count({ where: { actorUserId: user.id } }),
    ).toBe(0)
  })
}

test('retry after the response is lost replays the same committed order', async ({
  page,
  context,
}) => {
  const [item, user] = await Promise.all([product(), customer()])
  await signInSession(context, user.id)
  const attempts: { body: string | null; key: string }[] = []
  await page.route(
    (url) => url.pathname === ordersApi,
    async (route) => {
      const request = route.request()
      if (request.method() !== 'POST') return route.continue()
      attempts.push({
        body: request.postData(),
        key: request.headers()['idempotency-key']!,
      })
      if (attempts.length !== 1) return route.continue()
      const response = await route.fetch()
      expect(response.status()).toBe(201)
      await route.abort()
    },
  )
  await page.goto('/purchase/' + item.slug)
  await review(page)
  await confirmOrder(page).click()
  await expect(page.getByRole('alert')).toContainText('订单结果尚未确认')
  await expect(confirmOrder(page)).toHaveCount(0)
  await expect(check(page)).toHaveCount(0)
  const original = await expectPersistedOrder(
    user.id,
    item.priceFen,
    attempts[0]!.key,
  )
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('可能无法重试原请求')
    await dialog.dismiss()
  })
  await page.getByRole('link', { name: '返回商品详情' }).click()
  await expect(page).toHaveURL('/purchase/' + item.slug)
  await page.getByRole('button', { name: '重试原请求' }).click()
  await expectCreatedDetail(page, original)
  expect(attempts).toHaveLength(2)
  expect(attempts[0]?.body === attempts[1]?.body).toBe(true)
  expect(attempts[0]?.key === attempts[1]?.key).toBe(true)
  expect(
    (await expectPersistedOrder(user.id, item.priceFen, attempts[0]!.key)).id,
  ).toBe(original.id)
})

test('ADMIN retries a lost storefront order response, claims payment, and sees the fulfilled subscription', async ({
  page,
  context,
}) => {
  const [item, admin] = await Promise.all([
    product(),
    db.user.findUniqueOrThrow({ where: { loginEmail: env.ADMIN_EMAIL } }),
  ])
  await signInSession(context, admin.id)
  const adminRequest = (path: string, method: string, data: object | Buffer) =>
    page.request.fetch('/api/v1/admin' + path, {
      method,
      data,
      headers: {
        Origin: env.APP_BASE_URL,
        'X-Requested-With': 'MembershipStore',
        'Idempotency-Key': randomUUID(),
        'Content-Type': Buffer.isBuffer(data)
          ? 'application/octet-stream'
          : 'application/json',
      },
    })
  const qr = await sharp({
    create: { width: 128, height: 128, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer()
  expect((await adminRequest('/settings/wechat-qr', 'PUT', qr)).status()).toBe(
    200,
  )
  expect(
    (
      await adminRequest('/settings/wechat-payment', 'PATCH', { enabled: true })
    ).status(),
  ).toBe(200)
  const attempts: { body: string | null; key: string }[] = []
  await page.route(
    (url) => url.pathname === ordersApi,
    async (route) => {
      const request = route.request()
      if (request.method() !== 'POST') return route.continue()
      attempts.push({
        body: request.postData(),
        key: request.headers()['idempotency-key']!,
      })
      if (attempts.length !== 1) return route.continue()
      const accepted = await route.fetch()
      expect(accepted.status()).toBe(201)
      await route.abort()
    },
  )

  await page.goto('/products/' + item.slug)
  await buy(page).click()
  await expect(page).toHaveURL('/purchase/' + item.slug)
  await review(page)
  await confirmOrder(page).click()
  await expect(page.getByRole('alert')).toContainText('订单结果尚未确认')
  await page.getByRole('button', { name: '重试原请求' }).click()
  const order = await db.order.findFirstOrThrow({
    where: { userId: admin.id, productId: item.id },
  })
  await expectCreatedDetail(page, order)
  await expectNoOverflow(page)
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
  expect(attempts[0]!.key).not.toBe('')
  expect(await db.order.count({ where: { productId: item.id } })).toBe(1)
  expect(order).toMatchObject({
    userId: admin.id,
    source: 'ADMIN',
    createdByAdminId: admin.id,
    createdByUserId: null,
    amountFen: item.priceFen,
  })
  await expect(
    detail(page).getByRole('img', { name: '微信收款二维码' }),
  ).toBeVisible()
  await detail(page)
    .getByRole('button', { name: '我已付款', exact: true })
    .click()
  await page.getByRole('button', { name: '提交付款核实', exact: true }).click()
  await expect(detail(page)).toContainText('已提交付款核实')

  const receipt = await adminRequest(
    '/orders/' + order.id + '/payment-transactions',
    'POST',
    {
      expectedVersion: 2,
      amountFen: item.priceFen,
      channel: 'WECHAT',
      occurredAt: new Date(Date.now() - 1000).toISOString(),
    },
  )
  expect(receipt.status()).toBe(201)
  const { paymentTransaction } = await receipt.json()
  const confirmed = await adminRequest(
    '/payment-transactions/' + paymentTransaction.id + '/confirm',
    'POST',
    {
      expectedVersion: 3,
    },
  )
  expect(confirmed.status()).toBe(200)
  const fulfilled = await adminRequest(
    '/orders/' + order.id + '/fulfill',
    'POST',
    { expectedVersion: 4 },
  )
  expect(fulfilled.status()).toBe(200)
  const { subscription } = await fulfilled.json()

  await page.goto('/account/orders')
  await expect(page.getByRole('heading', { name: '我的订单' })).toBeVisible()
  await page.getByRole('link', { name: /^(我的订阅|订阅)$/ }).click()
  await expect(page).toHaveURL('/subscriptions')
  const card = page.locator('.subscription-card').filter({ hasText: item.name })
  await card.getByRole('button', { name: '详情', exact: true }).click()
  await expect(
    page
      .getByRole('dialog', { name: '订阅详情' })
      .getByRole('link', { name: order.orderNo }),
  ).toHaveAttribute('href', '/account/orders?orderId=' + order.id)
  expect(
    (
      await db.subscription.findUniqueOrThrow({
        where: { id: subscription.id },
      })
    ).userId,
  ).toBe(admin.id)
  await expectNoOverflow(page)
})

async function createHiddenOrder(
  item: Awaited<ReturnType<typeof product>>,
  user: Awaited<ReturnType<typeof customer>>,
) {
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const start = new Date('2026-09-01T00:00:00Z')
  const renewal = new Date('2026-10-01T00:00:00Z')
  const subscription = await db.subscription.create({
    data: {
      sourceType: 'ADMIN',
      createdByAdminId: admin.id,
      userId: user.id,
      productId: item.id,
      productNameSnapshot: item.name,
      productTypeSnapshot: 'SUBSCRIPTION',
      priceSnapshotFen: item.priceFen,
      termSnapshot: item.termLabel,
      startedAt: start,
      expiresAt: renewal,
      renewalPriceFen: item.renewalPriceFen!,
    },
  })
  return db.order.create({
    data: {
      orderNo: 'HIDDEN-' + randomUUID().slice(0, 8),
      source: 'SYSTEM_RENEWAL',
      kind: 'RENEWAL',
      hidden: true,
      subscriptionId: subscription.id,
      userId: user.id,
      productId: item.id,
      productNameSnapshot: 'Hidden test renewal name',
      productTypeSnapshot: 'SUBSCRIPTION',
      termSnapshot: item.termLabel,
      servicePeriodUnitSnapshot: 'MONTH',
      servicePeriodCountSnapshot: 1,
      amountFen: 8800,
      contactEmailSnapshot: user.loginEmail,
      paymentStatus: 'PAID',
      fulfillmentStatus: 'COMPLETED',
      paidAt: renewal,
      paymentConfirmedAt: renewal,
      fulfilledAt: renewal,
      renewalForPeriodStartAt: start,
      renewalPeriodStartAt: renewal,
      renewalPeriodEndAt: new Date('2026-11-01T00:00:00Z'),
      billingAnchorSnapshotAt: start,
      billingTimezoneSnapshot: 'Asia/Shanghai',
      billingRevisionSnapshot: 1,
      renewalRequestKeyHash: randomBytes(32).toString('hex'),
      renewalRequestHash: randomBytes(32).toString('hex'),
    },
  })
}

test('detail links use own-order API authorization and stay in sync with browser history', async ({
  page,
  context,
}) => {
  const [item, user, outsider] = await Promise.all([
    product(),
    customer(),
    customer(),
  ])
  const makeOrder = (owner: typeof user) =>
    db.order.create({
      data: {
        orderNo: 'DIRECT-' + randomUUID().slice(0, 8),
        userId: owner.id,
        source: 'USER',
        createdByUserId: owner.id,
        productId: item.id,
        kind: 'INITIAL',
        productNameSnapshot: 'Detail test ' + owner.id.slice(-8),
        productTypeSnapshot: 'SUBSCRIPTION',
        servicePeriodUnitSnapshot: 'MONTH',
        servicePeriodCountSnapshot: 1,
        termSnapshot: item.termLabel,
        amountFen: item.priceFen,
        contactEmailSnapshot: owner.loginEmail,
      },
    })
  const [own, foreign, hidden] = await Promise.all([
    makeOrder(user),
    makeOrder(outsider),
    createHiddenOrder(item, user),
  ])
  await signInSession(context, user.id)
  const detailRequests: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith(ordersApi + '/')) detailRequests.push(path)
  })
  for (const query of [
    'orderId=x',
    'orderId=',
    `orderId=${own.id}&orderId=${own.id}`,
  ]) {
    const before = detailRequests.length
    await page.goto('/account/orders?' + query)
    await expect(
      page.getByText(own.orderNo + ' · 首次订阅', { exact: true }),
    ).toBeVisible()
    await expect(detail(page)).toHaveCount(0)
    expect(detailRequests).toHaveLength(before)
  }
  for (const order of [
    foreign,
    hidden,
    { id: randomUUID(), productNameSnapshot: '' },
  ]) {
    await page.goto('/account/orders?orderId=' + order.id)
    await expect(detail(page)).toContainText('订单不存在。')
    expect(detailRequests.at(-1)).toBe(ordersApi + '/' + order.id)
    if (order.productNameSnapshot)
      await expect(detail(page)).not.toContainText(order.productNameSnapshot)
    await detail(page)
      .getByRole('button', { name: 'Close this dialog' })
      .click()
    await expect(page).toHaveURL('/account/orders')
  }
  await page.goto('/orders?keep=1')
  await page.getByRole('button', { name: '查看详情' }).click()
  await expect(page).toHaveURL('/orders?keep=1&orderId=' + own.id)
  await expect(detail(page)).toContainText(own.orderNo)
  await page.goBack()
  await expect(page).toHaveURL('/orders?keep=1')
  await expect(detail(page)).toHaveCount(0)
  await page.goForward()
  await expect(detail(page)).toContainText(own.orderNo)
  await detail(page).getByRole('button', { name: 'Close this dialog' }).click()
  await expect(page).toHaveURL('/orders?keep=1')
})

test('checkout pastes 10,000 characters and reports the UTF-8 aggregate error before accepting the exact boundary', async ({
  page,
  context,
}) => {
  const formSchema = { version: 1 as const, fields: longTextFields }
  const [item, user] = await Promise.all([product({ formSchema }), customer()])
  await signInSession(context, user.id)
  await page.goto('/purchase/' + item.slug)
  const data = formDataAtLimit()
  await pasteAtTextareaLimit(page, input(page, 'note'), data.note)
  await input(page, 'context').fill(data.context)
  await input(page, 'extra').fill(data.extra + 'x')
  await check(page).click()
  await expect(page.getByRole('alert')).toContainText('填写信息不能超过 64 KiB')
  await expect(confirmOrder(page)).toHaveCount(0)
  await input(page, 'extra').fill(data.extra)
  await check(page).click()
  await expect(confirmOrder(page)).toBeVisible()
  await expectNoOverflow(page)
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === ordersApi &&
        r.request().method() === 'POST',
    ),
    confirmOrder(page).click(),
  ])
  expect(response.status()).toBe(201)
  const { order } = await response.json()
  await expectCreatedDetail(page, order)
  expect(order.formData).toEqual(data)
  const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } })
  expect(stored.formData).toEqual(data)
})
