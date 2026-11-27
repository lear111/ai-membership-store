import { expect, test } from 'vitest'
import type { CustomerOrder } from '../../api/customer-orders'
import {
  canCancel,
  orderStatus,
  paymentTimeLeft,
  safeFrozenForm,
  timeline,
} from './customer-order-state'

const order: CustomerOrder = {
  id: 'fixture',
  orderNo: 'T21',
  version: 1,
  productId: 'product',
  kind: 'ONE_TIME',
  productNameSnapshot: 'Frozen',
  productDescriptionSnapshot: null,
  productTypeSnapshot: 'ONE_TIME',
  priceSnapshotFen: 100,
  termSnapshot: 'Fixture',
  servicePeriodUnitSnapshot: null,
  servicePeriodCountSnapshot: null,
  renewalPriceSnapshotFen: null,
  contactEmailSnapshot: 'customer@example.com',
  targetIdentifier: null,
  amountFen: 100,
  paymentStatus: 'UNPAID',
  fulfillmentStatus: 'NOT_STARTED',
  formSchemaSnapshot: {
    version: 1,
    fields: [
      { id: 'account', type: 'text', label: '账号', required: true, hint: '' },
    ],
  },
  formData: { account: 'safe' },
  createdAt: '2026-11-01T08:00:00.000Z',
  expiresAt: '2026-11-02T08:00:00.000Z',
  paidAt: null,
  paymentConfirmedAt: null,
  fulfilledAt: null,
  cancelledAt: null,
  remainingSeconds: 2,
}

test('countdown derives exclusively from server seconds and elapsed monotonic time', () => {
  expect(paymentTimeLeft(order, 100, 1100)).toBe(1)
  expect(paymentTimeLeft(order, 100, 3000)).toBe(0)
  expect(paymentTimeLeft(order, 100, 0)).toBe(2)
  expect(paymentTimeLeft({ ...order, remainingSeconds: 0 }, 100, 100)).toBe(0)
  expect(canCancel({ ...order, remainingSeconds: 0 })).toBe(true)
  expect(
    paymentTimeLeft(
      { ...order, paymentStatus: 'PENDING_VERIFICATION' },
      100,
      100,
    ),
  ).toBe(0)
  expect(paymentTimeLeft({ ...order, amountFen: 0 }, 100, 100)).toBe(0)
})

test('legacy transactions, refund statuses and zero orders never gain a payable timer', () => {
  const zero = {
    ...order,
    amountFen: 0,
    paymentStatus: 'NOT_REQUIRED',
    fulfillmentStatus: 'PROCESSING',
  } as const
  expect(orderStatus(zero)).toBe('处理中')
  expect(canCancel(zero)).toBe(false)
  const refund = {
    ...order,
    paymentStatus: 'REFUND_PENDING',
    fulfillmentStatus: 'CANCELLED',
  } as const
  expect(orderStatus(refund)).toBe('待退款')
  expect(canCancel(refund)).toBe(false)
  expect(paymentTimeLeft(refund, 100, 100)).toBe(0)
  expect(
    orderStatus({
      ...order,
      paymentStatus: 'PAID',
      fulfillmentStatus: 'NOT_STARTED',
    }),
  ).toBe('状态待确认')
})

test('timeline has no unconfirmed payment timestamp or invented refund node', () => {
  const paidAt = '2026-11-01T08:30:00.000Z'
  const paymentConfirmedAt = '2026-11-01T09:40:00.000Z'
  expect(timeline({ ...order, paidAt }).map((entry) => entry.label)).toEqual([
    '订单创建',
  ])
  expect(
    timeline({
      ...order,
      paidAt,
      paymentConfirmedAt,
      cancelledAt: '2026-11-01T10:00:00.000Z',
      paymentStatus: 'REFUNDED',
      fulfillmentStatus: 'CANCELLED',
    }).map((entry) => entry.label),
  ).toEqual(['订单创建', '实际付款发生', '商家确认收款', '订单取消'])
})

test('frozen form display and editing reject undeclared properties but keep credential-like labels and values', () => {
  expect(safeFrozenForm(order)?.data).toEqual({ account: 'safe' })
  expect(
    safeFrozenForm({ ...order, formData: { account: 'OTP: fictional' } })?.data,
  ).toEqual({ account: 'OTP: fictional' })
  expect(
    safeFrozenForm({
      ...order,
      formData: { account: 'safe', extra: 'unknown' },
    }),
  ).toBeNull()
  expect(
    safeFrozenForm({
      ...order,
      formSchemaSnapshot: {
        version: 1,
        fields: [
          {
            id: 'account',
            type: 'text',
            label: '密码',
            required: true,
            hint: '',
          },
        ],
      },
    })?.schema.fields[0].label,
  ).toBe('密码')
})
