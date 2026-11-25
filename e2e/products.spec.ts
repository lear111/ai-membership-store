import {
  expect,
  test,
  type Page,
  type Locator,
  type BrowserContext,
} from '@playwright/test'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { integrationEnvironment } from '../backend/test/integration/support.ts'
import { createDatabase } from '../backend/src/db/client.ts'
import { longTextarea } from '../backend/test/long-text-fixture.ts'
import { pasteAtTextareaLimit } from './paste-textarea.ts'
const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
let adminCookies: Awaited<ReturnType<BrowserContext['cookies']>>
test.afterAll(async () => {
  await db.$disconnect()
})
function guardRequests(page: Page) {
  page.on('pageerror', (error) => {
    throw error
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol.startsWith('http') && url.origin !== env.APP_BASE_URL)
      throw new Error('External services are forbidden in isolated E2E.')
    const catalogRead =
      request.method() === 'GET' &&
      /^\/api\/v1\/catalog\/products(?:\/[^/]+)?$/.test(url.pathname)
    if (
      url.pathname.startsWith('/api/') &&
      !catalogRead &&
      !(
        request.method() === 'GET' &&
        url.pathname === '/api/v1/storefront/config'
      ) &&
      !/^\/api\/v1\/(auth\/(login|me|logout)|admin\/(users|settings(?:\/wechat-(?:payment|qr))?|products(?:\/[^/]+(?:\/archive)?)?))$/.test(
        url.pathname,
      )
    )
      throw new Error('Out-of-scope API request.')
  })
}

// Authenticate through the real UI once per worker. Each test still gets an
// independent browser context; no auth bypass or production rate-limit changes.
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: env.APP_BASE_URL })
  try {
    const page = await context.newPage()
    guardRequests(page)
    await page.goto('/admin/login')
    await page
      .getByRole('textbox', { name: '登录邮箱', exact: true })
      .fill(env.ADMIN_EMAIL)
    await page.getByLabel('密码', { exact: true }).fill(env.ADMIN_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page).toHaveURL('/admin/users')
    adminCookies = await context.cookies()
  } finally {
    await context.close()
  }
})

test.beforeEach(async ({ page, context }) => {
  guardRequests(page)
  await context.addCookies(adminCookies)
  await page.goto('/admin/users')
  await expect(page).toHaveURL('/admin/users')
})
async function create(page: Page, name: string, configurePeriod = true) {
  await page.goto('/admin/products')
  await page.getByRole('button', { name: '添加商品', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加商品', exact: true })
  await dialog
    .getByRole('textbox', { name: '商品名称', exact: true })
    .fill(name)
  await dialog
    .getByRole('textbox', { name: '售价（元）', exact: true })
    .fill('12.34')
  await dialog
    .getByRole('textbox', { name: '续费价格（元）', exact: true })
    .fill('9.99')
  if (configurePeriod) {
    await choose(
      page,
      dialog.getByRole('combobox', { name: '服务周期单位', exact: true }),
      '自然月（MONTH）',
    )
    await dialog
      .getByRole('spinbutton', { name: '服务周期数量', exact: true })
      .fill('1')
  }
  return dialog
}
async function save(page: Page, dialog: Locator) {
  const response = page.waitForResponse(
    (r) =>
      /\/api\/v1\/admin\/products(?:\/[^/]+)?$/.test(
        new URL(r.url()).pathname,
      ) && ['POST', 'PATCH'].includes(r.request().method()),
  )
  await dialog.getByRole('button', { name: '保存商品', exact: true }).click()
  const result = await response
  expect(result.ok()).toBe(true)
  await expect(dialog).not.toBeVisible()
  return result
}
async function choose(page: Page, locator: Locator, label: string) {
  await locator.press('ArrowDown')
  await page.getByRole('option', { name: label, exact: true }).click()
}
test('new subscriptions require an explicit structured period and retain it after refresh', async ({
  page,
}) => {
  test.setTimeout(90000)
  for (const [unit, label, count] of [
    ['DAY', '固定天数（DAY）', 7],
    ['MONTH', '自然月（MONTH）', 12],
    ['YEAR', '自然年（YEAR）', 1],
  ] as const) {
    const name = 'Explicit-period-' + randomUUID()
    const dialog = await create(page, name, false)
    const unitInput = dialog.getByRole('combobox', {
      name: '服务周期单位',
      exact: true,
    })
    const countInput = dialog.getByRole('spinbutton', {
      name: '服务周期数量',
      exact: true,
    })
    await expect(unitInput).toHaveValue('')
    await expect(countInput).toHaveValue('')
    await dialog.getByRole('button', { name: '保存商品', exact: true }).click()
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: '请选择服务周期单位并填写正整数周期数量' }),
    ).toBeVisible()
    await expect(dialog).toBeVisible()
    await choose(page, unitInput, label)
    await countInput.fill(String(count))
    const response = await save(page, dialog)
    expect(response.request().postDataJSON()).toMatchObject({
      servicePeriodUnit: unit,
      servicePeriodCount: count,
    })
    const product = (await response.json()).product
    await page.reload()
    await page
      .getByRole('textbox', { name: '搜索商品', exact: true })
      .fill(name)
    await page.getByRole('button', { name: '查询', exact: true }).click()
    const row = page.locator('tbody tr').filter({ hasText: name })
    await expect(row).toContainText(`${count} ${unit}`)
    await row.getByRole('button', { name: '详情', exact: true }).click()
    await expect(
      page.getByRole('dialog', { name: '商品详情', exact: true }),
    ).toContainText(`${count} ${unit}`)
    const stored = await db.product.findUniqueOrThrow({
      where: { id: product.id },
    })
    expect([stored.servicePeriodUnit, stored.servicePeriodCount]).toEqual([
      unit,
      count,
    ])
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
})

test('legacy null periods remain editable without inference and can be explicitly completed', async ({
  page,
}) => {
  const product = await db.product.create({
    data: {
      slug: 'legacy-period-' + randomUUID(),
      name: 'Legacy-period-' + randomUUID(),
      type: 'SUBSCRIPTION',
      priceFen: 1234,
      renewalPriceFen: 999,
      termLabel: '30 天（仅展示）',
    },
  })
  await page.goto('/admin/products')
  await page
    .getByRole('textbox', { name: '搜索商品', exact: true })
    .fill(product.name)
  await page.getByRole('button', { name: '查询', exact: true }).click()
  const row = page.locator('tbody tr').filter({ hasText: product.name })
  await expect(row).toContainText('尚未配置结构化周期')
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑商品', exact: true })
  await expect(dialog.getByRole('status')).toContainText('尚未配置结构化周期')
  await expect(
    dialog.getByRole('combobox', { name: '服务周期单位', exact: true }),
  ).toHaveValue('')
  await expect(
    dialog.getByRole('spinbutton', { name: '服务周期数量', exact: true }),
  ).toHaveValue('')
  await dialog
    .getByRole('textbox', { name: '商品说明', exact: true })
    .fill('只修改说明')
  const unrelated = await save(page, dialog)
  expect(unrelated.request().postDataJSON()).not.toHaveProperty(
    'servicePeriodUnit',
  )
  expect(unrelated.request().postDataJSON()).not.toHaveProperty(
    'servicePeriodCount',
  )
  expect((await unrelated.json()).product).toMatchObject({
    servicePeriodUnit: null,
    servicePeriodCount: null,
  })
  await page.reload()
  await page
    .getByRole('textbox', { name: '搜索商品', exact: true })
    .fill(product.name)
  await page.getByRole('button', { name: '查询', exact: true }).click()
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  await choose(
    page,
    dialog.getByRole('combobox', { name: '服务周期单位', exact: true }),
    '自然月（MONTH）',
  )
  await dialog.getByRole('button', { name: '保存商品', exact: true }).click()
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: '请选择服务周期单位并填写正整数周期数量' }),
  ).toBeVisible()
  await expect(dialog).toBeVisible()
  await dialog
    .getByRole('spinbutton', { name: '服务周期数量', exact: true })
    .fill('1')
  const completed = await save(page, dialog)
  expect((await completed.json()).product).toMatchObject({
    servicePeriodUnit: 'MONTH',
    servicePeriodCount: 1,
    termLabel: product.termLabel,
  })
  const stored = await db.product.findUniqueOrThrow({
    where: { id: product.id },
  })
  expect([
    stored.servicePeriodUnit,
    stored.servicePeriodCount,
    stored.description,
  ]).toEqual(['MONTH', 1, '只修改说明'])
})

test('changing product types clears one-time periods and requires new subscription configuration', async ({
  page,
}) => {
  const name = 'Type-period-' + randomUUID()
  let dialog = await create(page, name)
  await save(page, dialog)
  await page.getByRole('textbox', { name: '搜索商品', exact: true }).fill(name)
  await page.getByRole('button', { name: '查询', exact: true }).click()
  const row = page.locator('tbody tr').filter({ hasText: name })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '编辑商品', exact: true })
  await choose(
    page,
    dialog.getByRole('combobox', { name: '商品类型', exact: true }),
    '一次性服务',
  )
  await expect(
    dialog.getByRole('combobox', { name: '服务周期单位', exact: true }),
  ).toHaveCount(0)
  await expect(
    dialog.getByRole('spinbutton', { name: '服务周期数量', exact: true }),
  ).toHaveCount(0)
  const once = await save(page, dialog)
  expect(once.request().postDataJSON()).toMatchObject({
    type: 'ONE_TIME',
    servicePeriodUnit: null,
    servicePeriodCount: null,
    renewalPriceFen: null,
  })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  await choose(
    page,
    dialog.getByRole('combobox', { name: '商品类型', exact: true }),
    '订阅服务',
  )
  await expect(
    dialog.getByRole('combobox', { name: '服务周期单位', exact: true }),
  ).toHaveValue('')
  await dialog.getByRole('button', { name: '保存商品', exact: true }).click()
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: '请选择服务周期单位并填写正整数周期数量' }),
  ).toBeVisible()
  await choose(
    page,
    dialog.getByRole('combobox', { name: '服务周期单位', exact: true }),
    '自然年（YEAR）',
  )
  await dialog
    .getByRole('spinbutton', { name: '服务周期数量', exact: true })
    .fill('1')
  await dialog
    .getByRole('textbox', { name: '续费价格（元）', exact: true })
    .fill('9.99')
  const renewed = await save(page, dialog)
  expect((await renewed.json()).product).toMatchObject({
    type: 'SUBSCRIPTION',
    servicePeriodUnit: 'YEAR',
    servicePeriodCount: 1,
    renewalPriceFen: 999,
  })
})

test('real product editor saves all eight field types, stable IDs, defaults, reorder and inert preview', async ({
  page,
}, info) => {
  test.setTimeout(120000)
  const name = 'Schema-' + randomUUID()
  const dialog = await create(page, name)
  const types = [
    '单行文本',
    '邮箱',
    '多行文本',
    '下拉选择',
    '单选',
    '多选',
    '数字',
    '日期',
  ]
  const defaults = [
    '默认文本',
    'form@example.com',
    '第一行\n第二行',
    '',
    '',
    '',
    '2.5',
    '2028-02-29',
  ]
  for (let i = 0; i < types.length; i++) {
    await dialog.getByRole('button', { name: '添加字段', exact: true }).click()
    const field = dialog.locator('.form-field-editor').nth(i)
    await field
      .getByRole('textbox', { name: '字段名称', exact: true })
      .fill(i === 0 ? '<b>文本</b>' : types[i]!)
    await choose(
      page,
      field.getByRole('combobox', { name: '字段类型', exact: true }),
      types[i]!,
    )
    await field
      .getByRole('textbox', { name: '输入提示', exact: true })
      .fill('非敏感信息')
    if (i >= 3 && i <= 5) {
      await field
        .getByRole('textbox', { name: '选项名称', exact: true })
        .fill('方案 A')
      await choose(
        page,
        field.getByRole('combobox', { name: '字段默认值', exact: true }),
        '方案 A',
      )
      if (i === 5)
        await field
          .getByRole('combobox', { name: '字段默认值', exact: true })
          .press('Escape')
    } else
      await field.getByLabel('字段默认值', { exact: true }).fill(defaults[i]!)
  }
  const firstId = await dialog.locator('.field-id').first().innerText()
  await dialog
    .getByRole('button', { name: '上移字段 日期', exact: true })
    .click()
  await dialog.getByRole('button', { name: '添加字段', exact: true }).click()
  await dialog
    .getByRole('button', { name: '删除字段 新字段', exact: true })
    .click()
  await expect(dialog.locator('.form-field-editor')).toHaveCount(8)
  const preview = dialog.getByTestId('form-preview')
  await expect(preview.locator('b')).toHaveCount(0)
  await preview
    .getByRole('textbox', { name: '预览 <b>文本</b>', exact: true })
    .fill('temporary preview only')
  await expect(
    preview.getByRole('textbox', { name: '预览 邮箱', exact: true }),
  ).toHaveValue('form@example.com')
  await expect(
    preview.getByRole('radio', { name: '方案 A', exact: true }),
  ).toBeChecked()
  await expect(
    preview.getByRole('checkbox', { name: '方案 A', exact: true }),
  ).toBeChecked()
  await expect(preview.locator('input[type=number]')).toHaveValue('2.5')
  await expect(preview.locator('input[type=date]')).toHaveValue('2028-02-29')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({
    path: 'test-results/product-schema-' + info.project.name + '.png',
    fullPage: true,
  })
  await save(page, dialog)
  await page.reload()
  await page.getByRole('textbox', { name: '搜索商品', exact: true }).fill(name)
  await page.getByRole('button', { name: '查询', exact: true }).click()
  const row = page.locator('tbody tr').filter({ hasText: name })
  await expect(row).toContainText('¥12.34')
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑商品', exact: true })
  await expect(editor.locator('.field-id').first()).toHaveText(firstId)
  await expect(
    editor
      .locator('.form-field-editor')
      .nth(6)
      .getByRole('textbox', { name: '字段名称', exact: true }),
  ).toHaveValue('日期')
  await expect(
    editor
      .getByTestId('form-preview')
      .getByRole('textbox', { name: '预览 <b>文本</b>', exact: true }),
  ).toHaveValue('默认文本')
  await editor
    .getByRole('textbox', { name: '商品名称', exact: true })
    .fill(name + '-edited')
  await save(page, editor)
  const separate = await create(page, 'Empty-' + randomUUID())
  await expect(separate.locator('.form-field-editor')).toHaveCount(0)
  await separate.getByRole('button', { name: '取消', exact: true }).click()
})
test('unlisted products remain manageable; archive unlists irreversibly and retains detail', async ({
  page,
}) => {
  test.setTimeout(90000)
  const name = 'Listing-' + randomUUID()
  const dialog = await create(page, name)
  await expect(dialog.getByRole('switch')).toHaveCount(1)
  await expect(
    dialog.getByRole('switch', { name: '商品上架', exact: true }),
  ).not.toBeChecked()
  await save(page, dialog)
  const headers = {
    origin: env.APP_BASE_URL,
    'x-requested-with': 'MembershipStore',
  }
  const query =
    '/api/v1/admin/products?archived=ACTIVE&type=SUBSCRIPTION&search=' +
    encodeURIComponent(name)
  const available = await page.request.get(query)
  expect(available.status()).toBe(200)
  const product = (await available.json()).items[0]
  expect(product.listed).toBe(false)
  expect(product.archivedAt).toBeNull()
  expect(product).not.toHaveProperty('purchaseEnabled')
  expect(product).not.toHaveProperty('renewalEnabled')
  const path = '/api/v1/admin/products/' + product.id
  const row = page.locator('tbody tr').filter({ hasText: name })
  // Navigation/reload resets search. Other suites retain their protected product
  // fixtures, so the target is not necessarily on the first 20-item page.
  const findProduct = async () => {
    await page
      .getByRole('textbox', { name: '搜索商品', exact: true })
      .fill(name)
    await page.getByRole('button', { name: '查询', exact: true }).click()
    await expect(row).toBeVisible()
  }
  await findProduct()
  await expect(row.getByRole('switch')).toHaveCount(1)
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑商品', exact: true })
  await expect(editor).toBeVisible()
  await editor.getByRole('button', { name: '取消', exact: true }).click()
  const searchCatalog = async () => {
    await page.goto('/')
    await page
      .getByRole('textbox', { name: '搜索商品', exact: true })
      .fill(name)
    await page.getByRole('button', { name: '搜索', exact: true }).click()
  }
  await searchCatalog()
  const card = page.locator('.product-card').filter({ hasText: name })
  await expect(page.getByText('暂无符合条件的商品')).toBeVisible()
  await expect(card).toHaveCount(0)
  await page.goto('/admin/products')
  await findProduct()
  const listing = row.getByRole('switch', { name: name + '上架', exact: true })
  const updated = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' && new URL(r.url()).pathname === path,
  )
  await listing.locator('..').click()
  expect((await updated).status()).toBe(200)
  await expect(listing).toBeChecked()
  await page.reload()
  await findProduct()
  await expect(listing).toBeChecked()
  await searchCatalog()
  await page.getByRole('button', { name: '订阅服务', exact: true }).click()
  await expect(card).toBeVisible()
  await card
    .getByRole('link', { name: '查看详情：' + name, exact: true })
    .click()
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: '立即购买', exact: true }),
  ).toBeEnabled()
  await page.goto('/admin/products')
  await findProduct()
  await row.getByRole('button', { name: '归档', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: '归档商品', exact: true }),
  ).toContainText('不可撤销')
  await page.getByRole('button', { name: '确认归档', exact: true }).click()
  await expect(row).toContainText('已归档')
  await expect(listing).not.toBeChecked()
  await expect(listing).toBeDisabled()
  await expect(
    row.getByRole('button', { name: '编辑', exact: true }),
  ).toHaveCount(0)
  await expect(
    row.getByRole('button', { name: '归档', exact: true }),
  ).toHaveCount(0)
  const archived = (await (await page.request.get(path)).json()).product
  expect(archived.listed).toBe(false)
  expect(archived.archivedAt).toBeTruthy()
  const repeat = await page.request.post(path + '/archive', {
    headers,
    data: {},
  })
  expect(repeat.status()).toBe(200)
  expect((await repeat.json()).product.archivedAt).toBe(archived.archivedAt)
  expect(
    (
      await page.request.patch(path, { headers, data: { listed: true } })
    ).status(),
  ).toBe(409)
  expect(
    (
      await page.request.patch(path, { headers, data: { name: 'Forbidden' } })
    ).status(),
  ).toBe(409)
  expect((await (await page.request.get(query)).json()).total).toBe(0)
  await page.reload()
  await findProduct()
  await choose(
    page,
    page.getByRole('combobox', { name: '归档状态', exact: true }),
    '已归档',
  )
  await expect(row).toContainText('已归档')
  await row.getByRole('button', { name: '详情', exact: true }).click()
  const detail = page.getByRole('dialog', { name: '商品详情', exact: true })
  await expect(detail).toContainText(name)
  await expect(detail).toContainText('未上架')
  await expect(detail).toContainText('已归档')
  await searchCatalog()
  await expect(page.getByText('暂无符合条件的商品')).toBeVisible()
  await expect(card).toHaveCount(0)
})
test('settings save to database, reload with brand and reject invalid timezone', async ({
  page,
}, info) => {
  await page.goto('/admin/settings')
  await expect(
    page.getByRole('textbox', { name: '店铺名称', exact: true }),
  ).toBeEnabled()
  // Same values in both viewport projects avoid conflicting shared singleton assertions.
  await page
    .getByRole('textbox', { name: '店铺名称', exact: true })
    .fill('持久化测试商城')
  await page
    .getByRole('textbox', { name: '管理员通知邮箱', exact: true })
    .fill('notifications@example.com')
  await page.getByRole('textbox', { name: '业务时区', exact: true }).fill('UTC')
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      new URL(r.url()).pathname === '/api/v1/admin/settings',
  )
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  const savedResponse = await saved
  expect(savedResponse.status()).toBe(200)
  const payload = savedResponse.request().postDataJSON()
  expect(Object.keys(payload).sort()).toEqual([
    'ownerEmail',
    'paymentInstructions',
    'storeName',
    'timezone',
  ])
  expect(payload.paymentInstructions).toBe('')
  await expect(page.locator('.brand')).toHaveText('持久化测试商城')
  await page.reload()
  await expect(
    page.getByRole('textbox', { name: '业务时区', exact: true }),
  ).toHaveValue('UTC')
  await expect(
    page.getByRole('textbox', { name: '管理员通知邮箱', exact: true }),
  ).toHaveValue('notifications@example.com')
  await page
    .getByRole('textbox', { name: '业务时区', exact: true })
    .fill('invalid/zone')
  await page.getByRole('button', { name: '保存设置', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('请检查输入字段和格式')
  await page.screenshot({
    path: 'test-results/settings-' + info.project.name + '.png',
    fullPage: true,
  })
})
test('wechat settings upload and replace a preview, enforce enable eligibility, and persist on reload', async ({
  page,
}) => {
  await page.goto('/admin/settings')
  const panel = page.getByRole('region', { name: '收款设置' })
  await expect(page.getByLabel('商家备注', { exact: true })).toBeVisible()
  const toggle = panel.getByRole('switch', { name: '启用微信收款' })
  const switchLabel = panel.getByText('启用微信收款', { exact: true })
  await expect(toggle).toBeDisabled()
  await expect(
    panel.getByText('尚未上传微信收款码。上传后可启用。'),
  ).toBeVisible()
  const file = panel.getByLabel('微信收款码图片')
  const picture = (background: string) =>
    sharp({ create: { width: 72, height: 72, channels: 3, background } })
  await file.setInputFiles({
    name: 'fake.png',
    mimeType: 'image/png',
    buffer: Buffer.from('plain text'),
  })
  await panel.getByRole('button', { name: '上传收款码' }).click()
  await expect(panel.getByRole('alert')).toContainText('请上传有效的')
  await expect(toggle).toBeDisabled()

  await file.setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    buffer: await picture('#FFFFFF').png().toBuffer(),
  })
  await panel.getByRole('button', { name: '上传收款码' }).click()
  const preview = panel.getByRole('img', { name: '当前微信收款码' })
  await expect(preview).toBeVisible()
  await expect(toggle).toBeEnabled()
  await switchLabel.click()
  await expect(toggle).toBeChecked()
  const first = await preview.getAttribute('src')
  await file.setInputFiles({
    name: 'replacement.webp',
    mimeType: 'image/webp',
    buffer: await picture('#00FFFF').webp().toBuffer(),
  })
  await panel.getByRole('button', { name: '更换收款码' }).click()
  await expect(preview).toBeVisible()
  await expect(preview).not.toHaveAttribute('src', first!)
  await expect(toggle).toBeChecked()

  await page.reload()
  await expect(toggle).toBeChecked()
  await expect(preview).toBeVisible()
  await switchLabel.click()
  await expect(toggle).not.toBeChecked()
  await expect(preview).toBeVisible()
  await page.reload()
  await expect(preview).toBeVisible()
  await expect(toggle).not.toBeChecked()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})

test('server rejects invalid form schemas without leaking values and unauthenticated users cannot read products/settings', async ({
  page,
  context,
}) => {
  const headers = {
    origin: env.APP_BASE_URL,
    'x-requested-with': 'MembershipStore',
  }
  for (const fields of [
    [
      { id: 'same', type: 'text', label: 'A', required: false },
      { id: 'same', type: 'email', label: 'B', required: true },
    ],
    [
      {
        id: 'select',
        type: 'select',
        label: '选择',
        required: false,
        options: [],
      },
    ],
    [{ id: 'script', type: 'script', label: 'unsafe', required: false }],
  ]) {
    const response = await page.request.post('/api/v1/admin/products', {
      headers,
      data: {
        name: 'invalid schema',
        type: 'ONE_TIME',
        priceFen: 100,
        renewalPriceFen: null,
        termLabel: '一次',
        formSchema: { version: 1, fields },
      },
    })
    expect(response.status()).toBe(400)
    expect(await response.text()).not.toContain('invalid schema')
  }
  await context.clearCookies()
  expect((await page.request.get('/api/v1/admin/products')).status()).toBe(401)
  expect((await page.request.get('/api/v1/admin/settings')).status()).toBe(401)
})

test('textarea editor and preview accept a 10,000-character paste and preserve the saved default', async ({
  page,
}) => {
  const dialog = await create(page, 'Long-text-' + randomUUID())
  await dialog.getByRole('button', { name: '添加字段', exact: true }).click()
  const field = dialog.locator('.form-field-editor')
  await field.getByLabel('字段名称', { exact: true }).fill('服务说明')
  await choose(
    page,
    field.getByRole('combobox', { name: '字段类型', exact: true }),
    '多行文本',
  )
  await pasteAtTextareaLimit(
    page,
    field.getByLabel('字段默认值', { exact: true }),
    longTextarea,
  )
  const preview = dialog.getByLabel('预览 服务说明', { exact: true })
  await expect(preview).toHaveValue(longTextarea)
  const previewOnly = 'B' + longTextarea.slice(1)
  await pasteAtTextareaLimit(page, preview, previewOnly)
  const response = await save(page, dialog)
  const { product } = await response.json()
  expect(product.formSchema.fields[0].defaultValue).toBe(longTextarea)
  const read = await page.request.get('/api/v1/admin/products/' + product.id)
  expect(read.status()).toBe(200)
  expect((await read.json()).product.formSchema.fields[0].defaultValue).toBe(
    longTextarea,
  )
})
