import { test } from 'node:test'
import assert from 'node:assert/strict'
import { productFormSchema } from '../src/contracts/product-form.ts'
import { parseFormData } from '../src/contracts/form-data.ts'
import * as schemas from '../src/modules/subscriptions/schemas.ts'
import { startExpiryScheduler } from '../src/modules/subscriptions/scheduler.ts'
import { transaction } from '../src/db/transaction.ts'
import { Prisma, type PrismaClient } from '../src/generated/prisma/client.ts'

test('serializable transactions retry MySQL raw-query deadlocks with a bound and do not retry audit failures', async () => {
  for (const [code, meta, expectedAttempts] of [
    ['P2034', {}, 4],
    ['P2010', { code: '1213' }, 4],
    ['P2010', { code: '1205' }, 4],
    [
      'P2010',
      {
        driverAdapterError: {
          cause: { originalCode: '1213', kind: 'TransactionWriteConflict' },
        },
      },
      4,
    ],
    [
      'P2010',
      {
        driverAdapterError: { cause: { originalCode: '1205', kind: 'mysql' } },
      },
      4,
    ],
    ['P2010', { code: '1644' }, 1],
  ] as const) {
    let attempts = 0
    const error = new Prisma.PrismaClientKnownRequestError(
      'test database failure',
      { code, meta, clientVersion: 'test' },
    )
    const db = {
      $transaction: async () => {
        attempts++
        throw error
      },
    } as unknown as PrismaClient
    await assert.rejects(
      transaction(db, async () => 'not committed'),
      (caught) => caught === error,
    )
    assert.equal(attempts, expectedAttempts)
  }
})

const schema = productFormSchema.parse({
  version: 1,
  fields: [
    { id: 'text', type: 'text', label: 'Text', required: true },
    { id: 'email', type: 'email', label: 'Email', required: true },
    { id: 'textarea', type: 'textarea', label: 'Note', required: true },
    {
      id: 'select',
      type: 'select',
      label: 'Select',
      required: true,
      options: [{ value: 'a', label: 'A' }],
    },
    {
      id: 'radio',
      type: 'radio',
      label: 'Radio',
      required: true,
      options: [{ value: 'b', label: 'B' }],
    },
    {
      id: 'checkbox',
      type: 'checkbox',
      label: 'Checkbox',
      required: true,
      options: [{ value: 'c', label: 'C' }],
    },
    { id: 'number', type: 'number', label: 'Number', required: true },
    { id: 'date', type: 'date', label: 'Date', required: true },
  ],
})
const valid = {
  text: 'non-sensitive',
  email: 'contact@example.com',
  textarea: '<script>literal text</script>',
  select: 'a',
  radio: 'b',
  checkbox: ['c'],
  number: 0,
  date: '2028-02-29',
}
test('all eight form values validate by stable ID without coercion or executing text', () => {
  assert.deepEqual(parseFormData(schema, valid), valid)
  for (const [key, value] of Object.entries({
    text: '',
    email: 'invalid',
    textarea: 'x'.repeat(10_001),
    select: 'unknown',
    radio: 'a',
    checkbox: ['c', 'c'],
    number: '0',
    date: '2027-02-29',
  })) {
    assert.throws(() => parseFormData(schema, { ...valid, [key]: value }), key)
    const absent = { ...valid } as Record<string, unknown>
    delete absent[key]
    assert.throws(() => parseFormData(schema, absent), 'required ' + key)
  }
  assert.throws(() => parseFormData(schema, { ...valid, unknown: 'rejected' }))
  assert.throws(() => parseFormData(schema, { ...valid, number: Infinity }))
  assert.throws(() => parseFormData(schema, { ...valid, checkbox: [] }))
  assert.deepEqual(parseFormData({ version: 1, fields: [] }, {}), {})
})
test('subscription input rejects privileged fields, invalid fen, dates, keys and missing concurrency/reason', () => {
  const input = {
    userId: '00000000-0000-4000-8000-000000000001',
    productId: '00000000-0000-4000-8000-000000000002',
    startedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    renewalPriceFen: 0,
    formData: {},
  }
  assert(schemas.createSubscription.safeParse(input).success)
  for (const key of [
    'sourceType',
    'status',
    'createdByAdminId',
    'user',
    'productNameSnapshot',
    'priceSnapshotFen',
    'formSchemaSnapshot',
    'version',
  ])
    assert(
      !schemas.createSubscription.safeParse({ ...input, [key]: 'injected' })
        .success,
    )
  for (const price of [-1, 1.1, 2147483648])
    assert(
      !schemas.createSubscription.safeParse({
        ...input,
        renewalPriceFen: price,
      }).success,
    )
  assert(
    !schemas.createSubscription.safeParse({
      ...input,
      expiresAt: input.startedAt,
    }).success,
  )
  assert(!schemas.editSubscription.safeParse({ note: 'x' }).success)
  assert(
    !schemas.editSubscription.safeParse({ version: 1, reason: 'reason' })
      .success,
  )
  assert(
    !schemas.editSubscription.safeParse({ version: 1, reason: '', note: 'x' })
      .success,
  )
  assert(!schemas.idempotencyKey.safeParse('invalid key').success)
})
test('scheduler prevents overlapping runs and waits for its current batch during stop', async () => {
  let calls = 0,
    release = () => {}
  const stop = startExpiryScheduler(
    async () => {
      calls++
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return 0
    },
    () => assert.fail('Unexpected error'),
  )
  assert.equal(calls, 1)
  const stopping = stop()
  release()
  await stopping
  assert.equal(calls, 1)
})
