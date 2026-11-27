import type { Prisma } from '../../generated/prisma/client.ts'
import {
  productFormSchema,
  projectCustomerForm,
} from '../../contracts/product-form.ts'
import { formDataSchema } from '../../contracts/form-data.ts'

// Explicit projections: never join today's Product or fetch internal order data.
export const customerOrderSelect = {
  version: true,
  id: true,
  orderNo: true,
  productId: true,
  kind: true,
  productNameSnapshot: true,
  productDescriptionSnapshot: true,
  productTypeSnapshot: true,
  priceSnapshotFen: true,
  termSnapshot: true,
  servicePeriodUnitSnapshot: true,
  servicePeriodCountSnapshot: true,
  formSchemaSnapshot: true,
  formData: true,
  amountFen: true,
  renewalPriceSnapshotFen: true,
  contactEmailSnapshot: true,
  targetIdentifier: true,
  paymentStatus: true,
  fulfillmentStatus: true,
  createdAt: true,
  paidAt: true,
  paymentConfirmedAt: true,
  fulfilledAt: true,
  cancelledAt: true,
} as const satisfies Prisma.OrderSelect

export const adminOrderSelect = {
  ...customerOrderSelect,
  internalNote: true,
  source: true,
  createdByAdminId: true,
  createdByUserId: true,
  cancellationReason: true,
  user: {
    select: {
      id: true,
      username: true,
      adminLabel: true,
      loginEmail: true,
      notificationEmail: true,
    },
  },
} as const satisfies Prisma.OrderSelect

type CustomerOrder = Prisma.OrderGetPayload<{
  select: typeof customerOrderSelect
}>
type AdminOrder = Prisma.OrderGetPayload<{ select: typeof adminOrderSelect }>

// A deadline is always derived from original creation, never from updatedAt.
// Only ordinary unpaid/unstarted orders have a payable countdown.
export function orderDeadline(
  order: Pick<
    CustomerOrder,
    | 'createdAt'
    | 'paymentStatus'
    | 'fulfillmentStatus'
    | 'cancelledAt'
    | 'paidAt'
    | 'paymentConfirmedAt'
    | 'fulfilledAt'
  >,
  now = new Date(),
) {
  const expiresAt = new Date(order.createdAt.getTime() + 24 * 60 * 60 * 1000)
  const payable =
    order.paymentStatus === 'UNPAID' &&
    order.fulfillmentStatus === 'NOT_STARTED' &&
    !order.cancelledAt &&
    !order.paidAt &&
    !order.paymentConfirmedAt &&
    !order.fulfilledAt
  return {
    expiresAt,
    remainingSeconds: payable
      ? Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000))
      : 0,
  }
}

function orderDto(order: CustomerOrder, now: Date) {
  return {
    ...orderDeadline(order, now),
    version: order.version,
    id: order.id,
    orderNo: order.orderNo,
    productId: order.productId,
    kind: order.kind,
    productNameSnapshot: order.productNameSnapshot,
    productDescriptionSnapshot: order.productDescriptionSnapshot,
    productTypeSnapshot: order.productTypeSnapshot,
    priceSnapshotFen: order.priceSnapshotFen,
    termSnapshot: order.termSnapshot,
    servicePeriodUnitSnapshot: order.servicePeriodUnitSnapshot,
    servicePeriodCountSnapshot: order.servicePeriodCountSnapshot,
    formSchemaSnapshot: order.formSchemaSnapshot,
    formData: order.formData,
    amountFen: order.amountFen,
    renewalPriceSnapshotFen: order.renewalPriceSnapshotFen,
    contactEmailSnapshot: order.contactEmailSnapshot,
    targetIdentifier: order.targetIdentifier,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    paymentConfirmedAt: order.paymentConfirmedAt,
    fulfilledAt: order.fulfilledAt,
    cancelledAt: order.cancelledAt,
  }
}

export function customerOrderDto(order: CustomerOrder, now = new Date()) {
  const dto = orderDto(order, now)
  const schema = productFormSchema.safeParse(dto.formSchemaSnapshot)
  // Suppress historical forms that cannot be parsed or whose stored values no longer match.
  const unsafe =
    (dto.formSchemaSnapshot !== null && !schema.success) ||
    (dto.formData !== null &&
      (!schema.success ||
        !formDataSchema(schema.data).safeParse(dto.formData).success))
  return {
    ...dto,
    formSchemaSnapshot:
      !unsafe && schema.success ? projectCustomerForm(schema.data) : null,
    formData: unsafe ? null : dto.formData,
    targetIdentifier: unsafe ? null : dto.targetIdentifier,
  }
}

export function adminOrderDto(order: AdminOrder, now = new Date()) {
  return {
    ...orderDto(order, now),
    internalNote: order.internalNote,
    customer: {
      id: order.user.id,
      username: order.user.username,
      adminLabel: order.user.adminLabel,
      loginEmail: order.user.loginEmail,
      notificationEmail: order.user.notificationEmail,
    },
    creator: {
      source: order.source,
      adminId: order.createdByAdminId,
      userId: order.createdByUserId,
    },
    cancellationReason: order.cancellationReason,
  }
}
