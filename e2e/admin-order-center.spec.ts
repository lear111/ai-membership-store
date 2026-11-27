import { expect, test, type Page, type BrowserContext } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../backend/src/db/client.ts'
import {
  activeCredentials,
  integrationEnvironment,
} from '../backend/test/integration/support.ts'
import {
  COOKIE_NAME,
  newToken,
  tokenHash,
} from '../backend/src/modules/auth/security.ts'
const env = integrationEnvironment(),
  db = createDatabase(env.DATABASE_URL)
test.setTimeout(120000)
test.afterAll(() => db.$disconnect())
test.beforeEach(({ page }) => {
  page.on('pageerror', (error) => {
    throw error
  })
})
async function setup(
  page: Page,
  context: BrowserContext,
  subscription = true,
  active = false,
  login = false,
) {
  const marker = randomUUID().slice(0, 8)
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const customer = await db.user.create({
    data: {
      loginEmail: active ? marker + '@example.com' : null,
      username: 'Customer ' + marker,
      status: active ? 'ACTIVE' : 'PENDING_ACTIVATION',
      ...(active ? await activeCredentials() : {}),
    },
  })
  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: '商品 ' + marker,
      type: subscription ? 'SUBSCRIPTION' : 'ONE_TIME',
      priceFen: 1000,
      renewalPriceFen: subscription ? 900 : null,
      termLabel: '只供展示',
      servicePeriodUnit: subscription ? 'MONTH' : null,
      servicePeriodCount: subscription ? 1 : null,
      listed: false,
      formSchema: {
        version: 1,
        fields: [
          { id: 'account', type: 'text', label: '账号', required: true },
        ],
      },
    },
  })
  if (login) {
    await page.goto('/admin/login')
    await page.getByRole('textbox', { name: '登录邮箱' }).fill(env.ADMIN_EMAIL)
    await page.getByLabel('密码', { exact: true }).fill(env.ADMIN_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page).toHaveURL(/\/admin\/users$/)
  } else {
    const token = newToken()
    await db.session.create({
      data: {
        userId: admin.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 3600000),
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
  }
  await page.goto('/admin/orders')
  await expect(
    page.getByRole('heading', { name: '订单管理', exact: true }),
  ).toBeVisible()
  return { customer, product, admin }
}
function dialog(page: Page, name: string) {
  return page.getByRole('dialog', { name, exact: true })
}
async function create(
  page: Page,
  data: Awaited<ReturnType<typeof setup>>,
  zero = false,
) {
  await page.getByRole('button', { name: '新建订单', exact: true }).click()
  const form = dialog(page, '新建订单')
  await form
    .getByRole('combobox', { name: '选择客户' })
    .fill(data.customer.username!)
  await page
    .getByRole('option', { name: new RegExp(data.customer.username!) })
    .click()
  await form.getByRole('combobox', { name: '选择商品' }).fill(data.product.name)
  await page
    .getByRole('option', { name: new RegExp(data.product.name) })
    .click()
  await form
    .getByRole('textbox', { name: '服务信息 账号', exact: true })
    .fill('非敏感账号标识')
  if (zero) {
    await form
      .getByRole('textbox', { name: '最终应付金额（元）', exact: true })
      .fill('0')
    await form
      .getByRole('textbox', { name: '价格调整原因', exact: true })
      .fill('验收赠送')
  }
  await form.getByRole('button', { name: '创建订单', exact: true }).click()
  await expect(form).not.toBeVisible()
  await expect(
    dialog(page, '订单详情').getByRole('heading', {
      name: data.product.name,
      exact: true,
    }),
  ).toBeVisible()
  return db.order.findFirstOrThrow({
    where: { productId: data.product.id },
    orderBy: { createdAt: 'desc' },
  })
}
async function action(page: Page, name: string) {
  await dialog(page, '订单详情')
    .getByRole('button', { name, exact: true })
    .click()
  return dialog(
    page,
    name === '标记退款失败'
      ? '退款标记失败'
      : name === '标记付款失败'
        ? '付款标记失败'
        : name,
  )
}
async function submit(page: Page, form: ReturnType<typeof dialog>) {
  await form.getByRole('button', { name: '确认提交', exact: true }).click()
  await expect(form).not.toBeVisible()
  await expect(
    dialog(page, '订单详情').getByText('正在读取订单…', { exact: true }),
  ).not.toBeVisible()
}
async function note(page: Page, text: string) {
  const form = await action(page, '编辑内部备注')
  await form.getByRole('textbox', { name: '内部备注（仅管理员）' }).fill(text)
  await submit(page, form)
  await expect(
    dialog(page, '订单详情').getByRole('heading', { name: '订单事件时间线' }),
  ).toBeVisible()
}
async function record(page: Page, amount = '10.00') {
  const form = await action(page, '登记付款')
  await form.getByRole('textbox', { name: '实际付款金额（元）' }).fill(amount)
  await submit(page, form)
}
async function pay(page: Page) {
  await record(page)
  const form = await action(page, '确认收款')
  await form.getByText('已在外部核实实际全额收款', { exact: true }).click()
  await expect(
    form.getByRole('checkbox', { name: '已在外部核实实际全额收款' }),
  ).toBeChecked()
  await submit(page, form)
  await expect(
    dialog(page, '订单详情').locator('.order-statuses'),
  ).toContainText('已付款')
}
async function fulfill(page: Page) {
  const form = await action(page, '确认履约完成')
  await form.getByText('已确认服务实际履约完成', { exact: true }).click()
  await expect(
    form.getByRole('checkbox', { name: '已确认服务实际履约完成' }),
  ).toBeChecked()
  await submit(page, form)
  await expect(
    dialog(page, '订单详情').locator('.order-statuses'),
  ).toContainText('已完成')
}
async function cancel(page: Page) {
  const form = await action(page, '取消订单')
  await form
    .getByRole('textbox', { name: '原因（必填）' })
    .fill('无法交付，按约取消')
  await submit(page, form)
}
async function refund(page: Page) {
  const form = await action(page, '登记线下退款')
  await expect(form).toContainText('原路全额：¥10.00')
  await expect(form.getByRole('combobox', { name: '付款渠道' })).toHaveCount(0)
  await form.getByText('已在外部发起原路全额退款', { exact: true }).click()
  await expect(
    form.getByRole('checkbox', { name: '已在外部发起原路全额退款' }),
  ).toBeChecked()
  await submit(page, form)
}
async function closeDetail(page: Page) {
  await dialog(page, '订单详情')
    .getByRole('button', { name: 'Close this dialog' })
    .click()
}

test('real ADMIN login → positive paid subscription fulfillment, frozen data and notes in unpaid/paid/completed states', async ({
  page,
  context,
}) => {
  const data = await setup(page, context, true, true, true),
    order = await create(page, data)
  await note(page, '<b>未付款备注纯文本</b>')
  await expect(dialog(page, '订单详情').locator('b')).toHaveCount(0)
  await pay(page)
  await note(page, '已付款备注')
  await expect(
    dialog(page, '订单详情').getByRole('button', {
      name: '登记线下退款',
      exact: true,
    }),
  ).toHaveCount(0)
  await db.product.update({
    where: { id: data.product.id },
    data: { name: 'Changed current catalog', priceFen: 9999 },
  })
  await fulfill(page)
  const subscription = await db.subscription.findUniqueOrThrow({
    where: { sourceOrderId: order.id },
  })
  expect(subscription.productNameSnapshot).toBe(data.product.name)
  await expect(dialog(page, '订单详情')).toContainText(subscription.id)
  await expect(dialog(page, '订单详情')).toContainText('ORDER / ACTIVE / 1')
  await note(page, '完成后备注')
  await note(page, '')
  await expect(
    dialog(page, '订单详情').getByText('暂无内部备注', { exact: true }),
  ).toBeVisible()
  expect(await db.orderRevision.count({ where: { orderId: order.id } })).toBe(8)
})
test('pending customer + unlisted product: zero subscription appears in PROCESSING queue and one-time fulfillment has no subscription', async ({
  page,
  context,
}) => {
  const data = await setup(page, context),
    order = await create(page, data, true)
  await closeDetail(page)
  await page.getByRole('button', { name: '待履约', exact: true }).click()
  await page
    .getByRole('textbox', { name: '搜索订单', exact: true })
    .fill(data.product.name)
  await page.getByRole('button', { name: '查询订单', exact: true }).click()
  expect(order.orderNo).toMatch(/^[1-9][0-9]{8}$/)
  const row = page
    .locator('tbody tr')
    .filter({ hasText: order.orderNo.match(/.{3}/g)!.join(' ') })
  await expect(row).toContainText('无需付款')
  await row.getByRole('button', { name: '查看详情' }).click()
  await fulfill(page)
  expect(
    await db.paymentTransaction.count({ where: { orderId: order.id } }),
  ).toBe(0)
  expect(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
  ).toBe(1)
  await closeDetail(page)
  const one = await setup(page, context, false),
    oneOrder = await create(page, one, true)
  await fulfill(page)
  expect(
    await db.subscription.count({ where: { sourceOrderId: oneOrder.id } }),
  ).toBe(0)
  await expect(
    dialog(page, '订单详情').getByText('无关联订阅', { exact: true }),
  ).toBeVisible()
})
test('paid cancellation → failed refund attempt → full retry and actual refund confirmation, terminal notes remain editable', async ({
  page,
  context,
}) => {
  const data = await setup(page, context, false),
    order = await create(page, data)
  await pay(page)
  await cancel(page)
  await expect(
    dialog(page, '订单详情').locator('.order-statuses'),
  ).toContainText('待退款')
  await note(page, '取消后备注')
  await refund(page)
  let form = await action(page, '标记退款失败')
  await form.getByRole('button', { name: '确认提交' }).click()
  await expect(form.getByRole('alert')).toContainText('必须填写原因')
  await form.getByRole('textbox', { name: '原因（必填）' }).fill('外部退款失败')
  await submit(page, form)
  await refund(page)
  form = await action(page, '确认退款到账')
  await form.getByText('已核实客户实际收到全额退款', { exact: true }).click()
  await expect(
    form.getByRole('checkbox', { name: '已核实客户实际收到全额退款' }),
  ).toBeChecked()
  await submit(page, form)
  await expect(
    dialog(page, '订单详情').locator('.order-statuses'),
  ).toContainText('已退款')
  await note(page, '退款完成备注')
  expect(
    await db.paymentTransaction.count({
      where: { orderId: order.id, kind: 'REFUND', status: 'FAILED' },
    }),
  ).toBe(1)
  expect(
    await db.paymentTransaction.count({
      where: { orderId: order.id, kind: 'REFUND', status: 'CONFIRMED' },
    }),
  ).toBe(1)
})
test('mismatched and multiple pending payments cannot confirm until failures are explicitly recorded', async ({
  page,
  context,
}) => {
  const data = await setup(page, context, false),
    order = await create(page, data)
  await record(page, '9.00')
  await expect(
    dialog(page, '订单详情').getByRole('button', {
      name: '确认收款',
      exact: true,
    }),
  ).toBeDisabled()
  await record(page, '10.00')
  const buttons = dialog(page, '订单详情').getByRole('button', {
    name: '确认收款',
    exact: true,
  })
  await expect(buttons).toHaveCount(2)
  for (const button of await buttons.all()) await expect(button).toBeDisabled()
  const mismatch = dialog(page, '订单详情')
    .locator('tr')
    .filter({ hasText: '金额不符' })
  await mismatch.getByRole('button', { name: '标记付款失败' }).click()
  const form = dialog(page, '付款标记失败')
  await form.getByRole('button', { name: '确认提交' }).click()
  await expect(form.getByRole('alert')).toContainText('必须填写原因')
  await form
    .getByRole('textbox', { name: '原因（必填）' })
    .fill('金额不符已核对')
  await submit(page, form)
  const confirm = await action(page, '确认收款')
  await confirm.getByText('已在外部核实实际全额收款', { exact: true }).click()
  await expect(
    confirm.getByRole('checkbox', { name: '已在外部核实实际全额收款' }),
  ).toBeChecked()
  await submit(page, confirm)
  expect(
    (await db.order.findUniqueOrThrow({ where: { id: order.id } }))
      .paymentStatus,
  ).toBe('PAID')
})
test('edit uses frozen form, handles version conflict, then zero conversion and cancellation without refund', async ({
  page,
  context,
}) => {
  const data = await setup(page, context),
    order = await create(page, data)
  await db.product.update({
    where: { id: data.product.id },
    data: { formSchema: { version: 1, fields: [] }, priceFen: 9999 },
  })
  let form = await action(page, '编辑订单')
  await expect(
    form.getByRole('textbox', { name: '服务信息 账号' }),
  ).toBeVisible()
  // A second real HTTP writer changes the version while the UI form is open.
  const other = await page.request.patch(
    '/api/v1/admin/orders/' + order.id + '/internal-note',
    {
      headers: {
        'x-requested-with': 'MembershipStore',
        origin: env.APP_BASE_URL,
        'Idempotency-Key': randomUUID(),
      },
      data: { expectedVersion: 1, internalNote: '另一管理员修改' },
    },
  )
  expect(other.status()).toBe(200)
  await form
    .getByRole('textbox', { name: '服务信息 账号' })
    .fill('更新完整表单')
  await form.getByRole('button', { name: '保存订单' }).click()
  await expect(form).not.toBeVisible()
  await expect(dialog(page, '订单详情')).toContainText('订单版本已变化')
  form = await action(page, '编辑订单')
  await form
    .getByRole('textbox', { name: '服务信息 账号' })
    .fill('更新完整表单')
  await form.getByRole('textbox', { name: '最终应付金额（元）' }).fill('0')
  await form.getByRole('button', { name: '保存订单' }).click()
  await expect(form.getByRole('alert')).toContainText('价格调整原因')
  await form.getByRole('textbox', { name: '价格调整原因' }).fill('改为赠送')
  await form.getByRole('button', { name: '保存订单' }).click()
  await expect(form).not.toBeVisible()
  await expect(
    dialog(page, '订单详情').locator('.order-statuses'),
  ).toContainText('无需付款')
  await cancel(page)
  expect(
    await db.paymentTransaction.count({ where: { orderId: order.id } }),
  ).toBe(0)
  expect(
    await db.subscription.count({ where: { sourceOrderId: order.id } }),
  ).toBe(0)
})
test('unknown response retries exact body/key once; list errors/empty/filter states and mobile viewport fit', async ({
  page,
  context,
}) => {
  const data = await setup(page, context),
    order = await create(page, data, true)
  let originalBody = '',
    originalKey = '',
    calls = 0
  await page.route('**/api/v1/admin/orders/*/internal-note', async (route) => {
    calls++
    if (calls === 1) {
      originalBody = route.request().postData()!
      originalKey = route.request().headers()['idempotency-key']!
      await route.fetch()
      await route.abort('connectionreset')
    } else {
      expect(route.request().postData()).toBe(originalBody)
      expect(route.request().headers()['idempotency-key']).toBe(originalKey)
      await route.continue()
    }
  })
  const form = await action(page, '编辑内部备注')
  await form
    .getByRole('textbox', { name: '内部备注（仅管理员）' })
    .fill('相同请求重试')
  await form.getByRole('button', { name: '确认提交' }).click()
  await expect(form.getByRole('button', { name: '重试原请求' })).toBeVisible()
  await form.getByRole('button', { name: '重试原请求' }).click()
  await expect(form).not.toBeVisible()
  expect(
    await db.orderEvent.count({
      where: { orderId: order.id, eventType: 'NOTE' },
    }),
  ).toBe(1)
  await closeDetail(page)
  await page
    .getByRole('textbox', { name: '搜索订单' })
    .fill('definitely missing ' + randomUUID())
  await page.getByRole('button', { name: '查询订单' }).click()
  await expect(page.getByText('暂无符合条件的订单')).toBeVisible()
  await page.route('**/api/v1/admin/orders?**', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { message: '隔离错误状态' } },
    }),
  )
  await page.getByRole('button', { name: '查询订单' }).click()
  await expect(page.getByRole('alert')).toContainText('隔离错误状态')
  await page.unroute('**/api/v1/admin/orders?**')
  await page.getByRole('textbox', { name: '搜索订单' }).fill(data.product.name)
  await page.getByRole('button', { name: '重试订单列表' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  for (const name of [
    '全部',
    '待付款',
    '待核实付款',
    '待履约',
    '已完成',
    '已取消',
    '已退款',
  ])
    await page.getByRole('button', { name, exact: true }).click()
  await page.getByRole('button', { name: '全部', exact: true }).click()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page
    .locator('tbody tr')
    .getByRole('button', { name: '查看详情' })
    .click()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})
test('CUSTOMER persisted session cannot open ADMIN workspace or admin-only evidence, timeline or notes', async ({
  page,
  context,
}) => {
  const data = await setup(page, context, false, true),
    order = await create(page, data)
  const token = newToken()
  await db.session.create({
    data: {
      userId: data.customer.id,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + 3600000),
    },
  })
  await context.clearCookies()
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      url: env.APP_BASE_URL,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
  await page.goto('/admin/orders')
  await expect(page).toHaveURL(/\/profile$/)
  for (const suffix of ['/events', '/payment-transactions', '/refunds'])
    expect(
      (
        await page.request.get('/api/v1/admin/orders/' + order.id + suffix)
      ).status(),
    ).toBe(403)
  expect(
    (
      await page.request.patch(
        '/api/v1/admin/orders/' + order.id + '/internal-note',
        {
          headers: {
            'x-requested-with': 'MembershipStore',
            origin: env.APP_BASE_URL,
            'Idempotency-Key': randomUUID(),
          },
          data: { expectedVersion: 1, internalNote: 'forbidden' },
        },
      )
    ).status(),
  ).toBe(403)
  const own = await page.request.get('/api/v1/customer/orders/' + order.id)
  expect(own.status()).toBe(200)
  expect((await own.json()).order).not.toHaveProperty('internalNote')
})

test('server pagination and independent product/kind filters keep dense tables inside the viewport', async ({
  page,
  context,
}) => {
  const data = await setup(page, context, false, true)
  for (let i = 0; i < 23; i++)
    await db.order.create({
      data: {
        orderNo: 'PAGE-' + randomUUID().replaceAll('-', ''),
        userId: data.customer.id,
        productId: data.product.id,
        source: 'ADMIN',
        createdByAdminId: data.admin.id,
        kind: 'ONE_TIME',
        productTypeSnapshot: 'ONE_TIME',
        productNameSnapshot: data.product.name,
        termSnapshot: 'Frozen only',
        amountFen: 1000,
        contactEmailSnapshot: data.customer.loginEmail,
        priceSnapshotFen: 1000,
        formSchemaSnapshot: data.product.formSchema!,
        formData: { account: 'Safe pagination fixture' },
      },
    })
  await page.getByRole('textbox', { name: '搜索订单' }).fill(data.product.name)
  await page.getByText('全部商品类型', { exact: true }).click()
  await page.getByRole('option', { name: '一次性商品', exact: true }).click()
  await page.getByText('全部订单类型', { exact: true }).click()
  await page.getByRole('option', { name: '一次性', exact: true }).click()
  await page.getByRole('button', { name: '查询订单', exact: true }).click()
  await expect(page.getByText('共 23 笔订单', { exact: true })).toBeVisible()
  await expect(page.locator('tbody tr')).toHaveCount(20)
  await page
    .locator('.order-pagination')
    .getByRole('button', { name: 'Go to next page' })
    .click()
  await expect(page.locator('tbody tr')).toHaveCount(3)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: 'test-results/t20-' + test.info().project.name + '.png',
    fullPage: true,
  })
})

test('catalog forms labeled with credential words stay ordinary inputs', async ({
  page,
  context,
}) => {
  const data = await setup(page, context, false, true)
  await db.product.update({
    where: { id: data.product.id },
    data: {
      formSchema: {
        version: 1,
        fields: [
          { id: 'account', type: 'text', label: '验证码', required: true },
        ],
      },
    },
  })
  await page.getByRole('button', { name: '新建订单', exact: true }).click()
  const form = dialog(page, '新建订单')
  await form
    .getByRole('combobox', { name: '选择客户' })
    .fill(data.customer.username!)
  await page
    .getByRole('option', { name: new RegExp(data.customer.username!) })
    .click()
  await form.getByRole('combobox', { name: '选择商品' }).fill(data.product.name)
  await page
    .getByRole('option', { name: new RegExp(data.product.name) })
    .click()
  const input = form.getByRole('textbox', { name: '服务信息 验证码' })
  await expect(input).toBeVisible()
  await input.fill('fixture-code')
  await form.getByRole('button', { name: '创建订单' }).click()
  await expect
    .poll(() => db.order.count({ where: { productId: data.product.id } }))
    .toBe(1)
})

test('refund entry requires an explicit rollback offset and persists each selected instant', async ({
  page,
  context,
}) => {
  const settings = await db.appSettings.findUniqueOrThrow({ where: { id: 1 } })
  await db.appSettings.update({
    where: { id: 1 },
    data: { timezone: 'America/Los_Angeles' },
  })
  try {
    const { customer, product, admin } = await setup(page, context, false, true)
    const paidAt = new Date('2025-03-07T12:00:00.000Z')
    const paymentConfirmedAt = new Date('2025-03-07T12:01:00.000Z')
    const order = await db.order.create({
      data: {
        orderNo: 'DST-' + randomUUID().replaceAll('-', ''),
        userId: customer.id,
        productId: product.id,
        createdByAdminId: admin.id,
        source: 'ADMIN',
        kind: 'ONE_TIME',
        productTypeSnapshot: 'ONE_TIME',
        productNameSnapshot: product.name,
        termSnapshot: product.termLabel,
        amountFen: 1000,
        contactEmailSnapshot: customer.loginEmail,
        createdAt: new Date('2025-03-07T11:00:00.000Z'),
        paymentStatus: 'REFUND_PENDING',
        fulfillmentStatus: 'CANCELLED',
        paidAt,
        paymentConfirmedAt,
        cancelledAt: new Date('2025-03-07T13:00:00.000Z'),
        cancellationReason: '验收：服务无法交付',
      },
    })
    await db.paymentTransaction.create({
      data: {
        orderId: order.id,
        kind: 'PAYMENT',
        channel: 'CASH',
        status: 'CONFIRMED',
        amountFen: order.amountFen,
        occurredAt: paidAt,
        confirmedAt: paymentConfirmedAt,
        createdByAdminId: admin.id,
        confirmedByAdminId: admin.id,
      },
    })
    await page.getByRole('textbox', { name: '搜索订单' }).fill(order.orderNo)
    await page.getByRole('button', { name: '查询订单', exact: true }).click()
    await page
      .locator('tbody tr')
      .filter({ hasText: order.orderNo })
      .getByRole('button', { name: '查看详情' })
      .click()

    const wallTime = '2025-11-02T01:30:12.345'
    const earlier = '2025-11-02T08:30:12.345Z'
    const later = '2025-11-02T09:30:12.345Z'
    const refunds = () =>
      db.paymentTransaction.findMany({
        where: { orderId: order.id, kind: 'REFUND' },
        orderBy: { occurredAt: 'asc' },
      })
    async function openRefund() {
      const form = await action(page, '登记线下退款')
      await form.getByText('已在外部发起原路全额退款', { exact: true }).click()
      return form
    }
    const form = await openRefund()
    const time = form.getByLabel('实际发生时间', { exact: true })
    const offset = form.getByRole('combobox', { name: '回拨时段的 UTC 偏移' })
    const save = form.getByRole('button', { name: '确认提交', exact: true })
    await time.fill('2025-03-09T02:30')
    await save.click()
    await expect(form.getByRole('alert')).toContainText(
      '该时区不存在此日期或时间',
    )
    await expect(offset).toHaveCount(0)
    await time.fill(wallTime)
    await expect(offset.getByRole('option')).toHaveText([
      '请选择实际发生的那一次',
      '第 1 次（UTC-07:00）',
      '第 2 次（UTC-08:00）',
    ])
    await offset.selectOption(earlier)
    await time.fill('2025-11-02T01:31:12.345')
    await time.fill(wallTime)
    await expect(offset).toHaveValue('')
    await save.click()
    await expect(form.getByRole('alert')).toContainText(
      '请选择回拨时段的实际 UTC 偏移',
    )
    expect(await refunds()).toHaveLength(0)

    await offset.selectOption(earlier)
    await submit(page, form)
    expect(
      (await refunds()).map((row) => row.occurredAt.toISOString()),
    ).toEqual([earlier])

    const fail = await action(page, '标记退款失败')
    await fail
      .getByRole('textbox', { name: '原因（必填）' })
      .fill('验收：记录下一次尝试')
    await submit(page, fail)

    const retry = await openRefund()
    await retry.getByLabel('实际发生时间', { exact: true }).fill(wallTime)
    await retry
      .getByRole('combobox', { name: '回拨时段的 UTC 偏移' })
      .selectOption(later)
    await submit(page, retry)
    expect(
      (await refunds()).map((row) => [
        row.occurredAt.toISOString(),
        row.status,
      ]),
    ).toEqual([
      [earlier, 'FAILED'],
      [later, 'PENDING'],
    ])
  } finally {
    await db.appSettings.update({
      where: { id: 1 },
      data: { timezone: settings.timezone, updatedAt: settings.updatedAt },
    })
  }
})
