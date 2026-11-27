import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  createAdminOrder,
  createCustomerOrder,
  creationKey,
} from '../src/modules/orders/create-schemas.ts'
import { creationForm } from '../src/modules/orders/create-form.ts'

test('creation DTOs are strict, separate identities/prices, and require explicit integer Fen', () => {
  const input = { productId: randomUUID(), formData: {} }
  const customer = {
    ...input,
    expectedProductUpdatedAt: '2024-02-29T10:00:00.123Z',
  }
  assert.deepEqual(createCustomerOrder.parse(customer), customer)
  for (const field of [
    'userId',
    'amountFen',
    'source',
    'version',
    'hidden',
    'internalNote',
    'paymentStatus',
  ])
    assert(
      !createCustomerOrder.safeParse({ ...customer, [field]: 'forged' })
        .success,
    )
  const admin = { ...input, userId: randomUUID(), amountFen: 0 }
  assert.equal(createAdminOrder.parse(admin).internalNote, null)
  assert(
    !createAdminOrder.safeParse({
      ...customer,
      userId: admin.userId,
      amountFen: 0,
    }).success,
  )
  for (const amountFen of [undefined, null, '100', -1, 1.5, 2147483648])
    assert(!createAdminOrder.safeParse({ ...admin, amountFen }).success)
  for (const priceAdjustmentReason of ['', '   ', 'x'.repeat(501)])
    assert(
      !createAdminOrder.safeParse({ ...admin, priceAdjustmentReason }).success,
    )
  assert.equal(
    createAdminOrder.parse({ ...admin, priceAdjustmentReason: ' discount ' })
      .priceAdjustmentReason,
    'discount',
  )
})

test('CUSTOMER creation requires a real UTC timestamp with exactly three fractional digits', () => {
  const input = { productId: randomUUID(), formData: {} }
  assert(!createCustomerOrder.safeParse(input).success)
  for (const expectedProductUpdatedAt of [
    '2026-02-29T10:00:00.123Z',
    '2026-11-21T24:00:00.123Z',
    '2026-11-21T10:00:00.123+00:00',
    '2026-11-21T10:00:00.123',
    '2026-11-21T10:00:00Z',
    '2026-11-21T10:00:00.1234Z',
    '2026-11-21T10:00:00.123Z ',
    1795255200123,
  ])
    assert(
      !createCustomerOrder.safeParse({ ...input, expectedProductUpdatedAt })
        .success,
    )
})

test('required idempotency key follows existing syntax without trimming or storing raw keys', () => {
  for (const key of [undefined, '', ' ', 'a,b', 'a\nb', 'x'.repeat(129)])
    assert.throws(() => creationKey(key))
  assert.equal(creationKey('a.b:c-d_1'), 'a.b:c-d_1')
})

test('order forms reuse canonical validation and keep credential-like text as ordinary answers', () => {
  const schema = {
    version: 1,
    fields: [{ id: 'account', type: 'text', label: '账号', required: true }],
  }
  assert.deepEqual(creationForm(schema, { account: 'plain-account' }), {
    account: 'plain-account',
  })
  for (const input of [
    {},
    { account: '' },
    { account: 12 },
    { account: 'ok', extra: 'unknown' },
  ])
    assert.throws(() => creationForm(schema, input))
  assert.deepEqual(creationForm(schema, { account: 'password=secret' }), {
    account: 'password=secret',
  })
  for (const label of ['Password', 'access_token', '验证码', '恢复码'])
    assert.deepEqual(
      creationForm(
        { ...schema, fields: [{ ...schema.fields[0], label }] },
        { account: 'persisted as-is' },
      ),
      { account: 'persisted as-is' },
    )
})
