import { onUnmounted, ref } from 'vue'
import type { CustomerOrder } from '../../api/customer-orders'
import { productFormSchema } from '../../../../backend/src/contracts/product-form'
import { formDataSchema } from '../../../../backend/src/contracts/form-data'
import type { FormData } from '../../api/subscriptions'

export const orderPresets = [
  { label: '全部', query: {} },
  { label: '待付款', query: { paymentStatus: 'UNPAID' } },
  { label: '付款待核实', query: { paymentStatus: 'PENDING_VERIFICATION' } },
  { label: '处理中', query: { fulfillmentStatus: 'PROCESSING' } },
  { label: '已完成', query: { fulfillmentStatus: 'COMPLETED' } },
  { label: '已取消', query: { fulfillmentStatus: 'CANCELLED' } },
  {
    label: '待退款',
    query: { paymentStatus: 'REFUND_PENDING', fulfillmentStatus: 'CANCELLED' },
  },
  {
    label: '已退款',
    query: { paymentStatus: 'REFUNDED', fulfillmentStatus: 'CANCELLED' },
  },
] as const

export const customerPaymentLabels = {
  UNPAID: '待付款',
  PENDING_VERIFICATION: '付款待核实',
  PAID: '已付款',
  REFUND_PENDING: '待退款',
  REFUNDED: '已退款',
  NOT_REQUIRED: '无需付款',
}

export function orderStatus(order: CustomerOrder) {
  const payment = order.paymentStatus
  switch (order.fulfillmentStatus) {
    case 'COMPLETED':
      return '已完成'
    case 'PROCESSING':
      if (payment === 'PAID' || payment === 'NOT_REQUIRED') return '处理中'
      break
    case 'NOT_STARTED':
      if (payment === 'UNPAID') return '待付款'
      if (payment === 'PENDING_VERIFICATION') return '付款待核实'
      break
    case 'CANCELLED':
      if (payment === 'REFUND_PENDING') return '待退款'
      if (payment === 'REFUNDED') return '已退款'
      if (payment === 'UNPAID' || payment === 'NOT_REQUIRED') return '已取消'
  }
  return '状态待确认'
}

export function canCancel(order: CustomerOrder) {
  return (
    (order.kind === 'INITIAL' || order.kind === 'ONE_TIME') &&
    order.fulfillmentStatus === 'NOT_STARTED' &&
    (order.paymentStatus === 'UNPAID' ||
      order.paymentStatus === 'PENDING_VERIFICATION') &&
    !order.paidAt &&
    !order.paymentConfirmedAt &&
    !order.cancelledAt &&
    !order.fulfilledAt
  )
}

export function paymentTimeLeft(
  order: CustomerOrder,
  receivedAt: number,
  now: number,
) {
  if (
    !canCancel(order) ||
    order.paymentStatus !== 'UNPAID' ||
    order.amountFen <= 0
  )
    return 0
  return Math.max(
    0,
    order.remainingSeconds - Math.floor(Math.max(0, now - receivedAt) / 1000),
  )
}

export function countdown(seconds: number) {
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

export function useOrderClock() {
  const now = ref(performance.now())
  const id = window.setInterval(() => {
    now.value = performance.now()
  }, 1000)
  onUnmounted(() => window.clearInterval(id))
  return now
}

export function timeline(order: CustomerOrder) {
  const confirmed = Boolean(order.paymentConfirmedAt)
  return [
    { label: '订单创建', at: order.createdAt },
    { label: '实际付款发生', at: confirmed ? order.paidAt : null },
    { label: '商家确认收款', at: order.paymentConfirmedAt },
    { label: '服务完成', at: order.fulfilledAt },
    { label: '订单取消', at: order.cancelledAt },
  ]
    .filter((item): item is { label: string; at: string } => !!item.at)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

export function safeFrozenForm(order: CustomerOrder) {
  const schema = productFormSchema.safeParse(order.formSchemaSnapshot)
  if (!schema.success) return null
  const data = formDataSchema(schema.data).safeParse(order.formData ?? {})
  if (!data.success) return null
  return { schema: schema.data, data: data.data as FormData }
}

export function useNarrowOrderDialog() {
  const query = window.matchMedia('(max-width: 640px)')
  const mobile = ref(query.matches)
  const sync = () => {
    mobile.value = query.matches
  }
  query.addEventListener('change', sync)
  onUnmounted(() => query.removeEventListener('change', sync))
  return mobile
}
