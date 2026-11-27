import { afterEach, expect, test, vi } from 'vitest'
import { shallowRef } from 'vue'
import type { PurchaseProduct } from '../../api/catalog'
import {
  customerOrderLocation,
  parseOrderId,
  type CustomerOrder,
} from '../../api/customer-orders'
import { usePurchaseCheckout } from './purchase-checkout'

const product: PurchaseProduct = {
  id: '292ae1f7-1196-4ca6-82d5-2839869ec6c9',
  slug: 'test-service',
  name: 'Test service',
  description: 'Test description',
  coverImageUrl: null,
  type: 'ONE_TIME',
  priceFen: 9900,
  renewalPriceFen: null,
  termLabel: 'One time',
  servicePeriodUnit: null,
  servicePeriodCount: null,
  updatedAt: '2026-11-21T10:00:00.123Z',
  formSchema: {
    version: 1,
    fields: [
      {
        id: 'account',
        label: '账号标识',
        required: true,
        type: 'text',
        hint: '',
      },
    ],
  },
}
const order: CustomerOrder = {
  id: 'ff1ac50a-ca00-4577-bcb5-cf25276324fc',
  orderNo: 'TEST-ORDER',
  version: 1,
  kind: 'ONE_TIME',
  productId: product.id,
  productNameSnapshot: product.name,
  productDescriptionSnapshot: product.description,
  productTypeSnapshot: product.type,
  priceSnapshotFen: product.priceFen,
  termSnapshot: product.termLabel,
  servicePeriodUnitSnapshot: null,
  servicePeriodCountSnapshot: null,
  renewalPriceSnapshotFen: null,
  formSchemaSnapshot: product.formSchema,
  formData: { account: ' profile ' },
  amountFen: 9900,
  contactEmailSnapshot: 'fictional@example.com',
  targetIdentifier: null,
  paymentStatus: 'UNPAID',
  fulfillmentStatus: 'NOT_STARTED',
  createdAt: '2026-11-21T10:01:00.000Z',
  paidAt: null,
  paymentConfirmedAt: null,
  fulfilledAt: null,
  cancelledAt: null,
  expiresAt: '2026-11-22T10:01:00.000Z',
  remainingSeconds: 86400,
}
const success = () => Response.json({ order }, { status: 201 })
const error = (status: number, code: string) =>
  Response.json({ error: { code, message: code } }, { status })

function setup() {
  const current = shallowRef(product)
  const checkout = usePurchaseCheckout(current)
  const fetch = vi.fn<(path: string, init: RequestInit) => Promise<Response>>()
  vi.stubGlobal('fetch', fetch)
  const prepare = () => {
    checkout.values.value = { account: ' profile ' }
    checkout.check()
  }
  return { current, checkout, fetch, prepare }
}

afterEach(() => vi.unstubAllGlobals())

test('requires local validation and invalidates review when edited', async () => {
  const { checkout, fetch, prepare } = setup()
  await checkout.submit()
  checkout.check()
  expect(checkout.phase.value).toBe('edit')
  expect(checkout.errors.value).toEqual(['账号标识 · 请填写必填项'])
  checkout.values.value = { account: 'API key: fictional-input-only' }
  checkout.check()
  expect(checkout.errors.value).toEqual([])
  expect(checkout.phase.value).toBe('review')
  expect(checkout.review.value).toEqual({
    account: 'API key: fictional-input-only',
  })
  expect(fetch).not.toHaveBeenCalled()
  prepare()
  expect(checkout.phase.value).toBe('review')
  expect(checkout.review.value).toEqual(order.formData)
  checkout.edit()
  expect(checkout.review.value).toBeUndefined()
  prepare()
  checkout.values.value.account = 'new profile'
  expect(checkout.phase.value).toBe('edit')
  expect(checkout.review.value).toBeUndefined()
  await checkout.submit()
  expect(fetch).not.toHaveBeenCalled()
})

test('submits the three normalized fields exactly once, retaining rounded-trip version and full DTO', async () => {
  const { checkout, fetch, prepare } = setup()
  let finish!: (response: Response) => void
  fetch.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  prepare()
  const pending = checkout.submit()
  expect(checkout.phase.value).toBe('submitting')
  checkout.edit()
  expect(checkout.phase.value).toBe('submitting')
  await checkout.submit()
  expect(fetch).toHaveBeenCalledTimes(1)
  const [path, config] = fetch.mock.calls[0]!
  expect(path).toBe('/api/v1/customer/orders')
  expect(config.method).toBe('POST')
  expect(config.signal).toBeInstanceOf(AbortSignal)
  expect(
    parseOrderId(new Headers(config.headers).get('Idempotency-Key')),
  ).toBeTruthy()
  expect(JSON.parse(String(config.body))).toEqual({
    productId: product.id,
    expectedProductUpdatedAt: '2026-11-21T10:00:00.123Z',
    formData: order.formData,
  })
  finish(success())
  expect(await pending).toBe('created')
  expect(checkout.confirmed.value).toEqual(order)
  expect(customerOrderLocation(checkout.confirmed.value!.id)).toEqual({
    path: '/account/orders',
    query: { orderId: order.id },
  })
  await checkout.submit()
  expect(fetch).toHaveBeenCalledTimes(1)
})

test.each([
  ['network', () => Promise.reject(new TypeError('Network failed'))],
  [
    'timeout',
    () => Promise.reject(new DOMException('Timeout', 'TimeoutError')),
  ],
  ['server error', async () => error(503, 'UNAVAILABLE')],
  ['malformed JSON', async () => new Response('{', { status: 201 })],
  [
    'missing DTO',
    async () => Response.json({ unexpected: true }, { status: 201 }),
  ],
  [
    'invalid ID',
    async () =>
      Response.json({ order: { ...order, id: '/foreign' } }, { status: 201 }),
  ],
  [
    'incomplete order',
    async () =>
      Response.json(
        { order: { ...order, expiresAt: undefined } },
        { status: 201 },
      ),
  ],
] as const)(
  'unknown %s outcome keeps original key and body',
  async (_label, first) => {
    const { checkout, fetch, prepare } = setup()
    fetch.mockImplementationOnce(first).mockResolvedValueOnce(success())
    prepare()
    await checkout.submit()
    expect(checkout.phase.value).toBe('uncertain')
    checkout.values.value = { account: 'different' }
    checkout.edit()
    checkout.check()
    expect(checkout.phase.value).toBe('uncertain')
    expect(await checkout.submit()).toBe('created')
    expect(fetch).toHaveBeenCalledTimes(2)
    const firstConfig = fetch.mock.calls[0]![1]
    const retryConfig = fetch.mock.calls[1]![1]
    expect(firstConfig.body === retryConfig.body).toBe(true)
    expect(
      new Headers(firstConfig.headers).get('Idempotency-Key') ===
        new Headers(retryConfig.headers).get('Idempotency-Key'),
    ).toBe(true)
  },
)

test('PRODUCT_CHANGED discards the intent and requires explicit review of the refreshed product', async () => {
  const { current, checkout, fetch, prepare } = setup()
  fetch
    .mockResolvedValueOnce(error(409, 'PRODUCT_CHANGED'))
    .mockResolvedValueOnce(success())
  prepare()
  expect(await checkout.submit()).toBe('changed')
  expect(checkout.values.value).toEqual({})
  expect(checkout.review.value).toBeUndefined()
  current.value = { ...product, updatedAt: '2026-11-21T10:00:01.456Z' }
  await checkout.submit()
  expect(fetch).toHaveBeenCalledTimes(1)
  prepare()
  expect(await checkout.submit()).toBe('created')
  const first = fetch.mock.calls[0]![1]
  const second = fetch.mock.calls[1]![1]
  expect(
    new Headers(first.headers).get('Idempotency-Key') !==
      new Headers(second.headers).get('Idempotency-Key'),
  ).toBe(true)
  expect(JSON.parse(String(second.body)).expectedProductUpdatedAt).toBe(
    current.value.updatedAt,
  )
})

test('known business errors leave the checkout in edit mode', async () => {
  const { checkout, fetch, prepare } = setup()
  fetch.mockResolvedValueOnce(error(403, 'ACCOUNT_NOT_ELIGIBLE'))
  prepare()
  await checkout.submit()
  expect(checkout.phase.value).toBe('edit')
  expect(checkout.message.value).toBe('ACCOUNT_NOT_ELIGIBLE')
})

test('accepts a single UUID and rejects malformed detail queries', () => {
  expect(parseOrderId(order.id)).toBe(order.id)
  for (const invalid of [
    null,
    undefined,
    '',
    ' ' + order.id,
    order.id + '\n',
    '/foreign',
    [order.id],
    [order.id, order.id],
    'f'.repeat(256),
  ]) {
    expect(parseOrderId(invalid)).toBeUndefined()
  }
})
