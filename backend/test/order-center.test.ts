import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderEventDto } from '../src/modules/orders/events.ts'
import { updateInternalNote } from '../src/modules/orders/center-schemas.ts'

test('internal note is a required strict key with bounded normalized text and version', () => {
  assert.deepEqual(
    updateInternalNote.parse({ expectedVersion: 1, internalNote: '  ' }),
    { expectedVersion: 1, internalNote: null },
  )
  assert.equal(
    updateInternalNote.parse({ expectedVersion: 1, internalNote: '  x  ' })
      .internalNote,
    'x',
  )
  for (const input of [
    { expectedVersion: 1 },
    { expectedVersion: 1, internalNote: 0 },
    { expectedVersion: 1, internalNote: 'x'.repeat(2001) },
    { expectedVersion: 2147483648, internalNote: null },
    { expectedVersion: 1, internalNote: null, version: 1 },
  ])
    assert(!updateInternalNote.safeParse(input).success)
})
test('timeline omits malformed values, unknown/mismatched operations and non-operation-specific fields', () => {
  const row = {
    id: 'id',
    eventType: 'NOTE' as const,
    actorType: 'SYSTEM' as const,
    createdAt: new Date(),
    note: '<script>plain</script>',
    actorAdmin: null,
    actorUser: null,
    fromStateJson: null,
    toStateJson: {
      operation: 'ORDER_EDITED',
      version: 'bad',
      internalNote: 'PRIVATE',
      amountFen: -1,
      passwordHash: 'SECRET',
    },
  }
  assert.deepEqual(orderEventDto(row).summary, {})
  assert.equal(orderEventDto(row).actorDisplayName, '系统')
  assert.equal(
    orderEventDto({
      ...row,
      toStateJson: { operation: 'PAYMENT_CONFIRMED', version: 2 },
    }).operation,
    null,
  )
  assert.equal(
    orderEventDto({ ...row, toStateJson: { operation: 'SECRET' } }).operation,
    null,
  )
  assert.equal(
    orderEventDto({ ...row, toStateJson: ['SECRET'] }).operation,
    null,
  )
  assert.deepEqual(
    orderEventDto({
      ...row,
      toStateJson: { operation: 'ORDER_EDITED', version: 2, amountFen: 0 },
    }).summary,
    { versionAfter: 2, amountFenAfter: 0 },
  )
})
test('timeline actor names honor role-specific label precedence and legacy creation events', () => {
  const actor = {
    adminLabel: 'Private label',
    username: 'Public name',
    loginEmail: 'prefix@example.com',
  }
  const row = {
    id: 'id',
    eventType: 'ORDER_CREATED' as const,
    actorType: 'ADMIN' as const,
    createdAt: new Date(),
    note: null,
    actorAdmin: actor,
    actorUser: actor,
    fromStateJson: null,
    toStateJson: { version: 1, amountFen: 0, paymentStatus: 'NOT_REQUIRED' },
  }
  assert.equal(orderEventDto(row).actorDisplayName, 'Private label')
  assert.equal(
    orderEventDto({ ...row, actorType: 'USER' }).actorDisplayName,
    'Public name',
  )
  assert.equal(
    orderEventDto({
      ...row,
      actorType: 'USER',
      actorUser: { ...actor, username: null },
    }).actorDisplayName,
    'prefix',
  )
  assert.equal(orderEventDto(row).operation, 'ORDER_CREATED')
  assert.deepEqual(orderEventDto(row).summary, {
    versionAfter: 1,
    paymentStatusAfter: 'NOT_REQUIRED',
    amountFenAfter: 0,
  })
})
