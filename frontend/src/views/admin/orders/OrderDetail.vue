<script setup lang="ts">
import { adminName } from '../../../stores/user-name'
import LinkedText from '../../../components/LinkedText.vue'
import { ElTag } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import {
  readOrder,
  readEvents,
  readEvidence,
  type OrderDetail,
  type Evidence,
  type OrderEvent,
} from '../../../api/orders'
import { productFormSchema } from '../../../../../backend/src/contracts/product-form'
import ProductFormInputs from '../../../components/ProductFormInputs.vue'
import OrderNumber from '../../../components/OrderNumber.vue'
import OrderAction, { type Action } from './OrderAction.vue'
import OrderForm from './OrderForm.vue'
import {
  orderActions,
  paymentLabels,
  fulfillmentLabels,
  kindLabels,
  channelLabels,
  businessDate,
} from './state'
import { settings } from '../../../stores/settings'
import { money } from '../../../stores/format'
const props = defineProps<{ id: string }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const order = ref<OrderDetail>(),
  error = ref(''),
  loading = ref(false),
  message = ref('')
const payments = ref<Evidence[]>([]),
  refunds = ref<Evidence[]>([]),
  events = ref<OrderEvent[]>([])
const allPayments = ref<Evidence[]>([]),
  allRefunds = ref<Evidence[]>([]),
  verified = ref(false)
const paymentPage = ref(1),
  refundPage = ref(1),
  eventPage = ref(1)
const paymentTotal = ref(0),
  refundTotal = ref(0),
  eventTotal = ref(0)
const action = ref<Action>(),
  target = ref<Evidence>(),
  editing = ref(false)
const schema = computed(() => {
  const parsed = productFormSchema.safeParse(order.value?.formSchemaSnapshot)
  return parsed.success ? parsed.data : null
})
const complete = computed(
  () =>
    verified.value ||
    (paymentTotal.value <= payments.value.length &&
      refundTotal.value <= refunds.value.length),
)
const actions = computed(() =>
  order.value
    ? orderActions(
        order.value,
        verified.value ? allPayments.value : payments.value,
        verified.value ? allRefunds.value : refunds.value,
        complete.value,
      )
    : null,
)
const confirmed = computed(() =>
  (verified.value ? allPayments.value : payments.value).find(
    (p) => p.status === 'CONFIRMED',
  ),
)
const activePayments = computed(
  () =>
    (verified.value ? allPayments.value : payments.value).filter(
      (p) => p.status === 'PENDING',
    ).length,
)
const date = (value: string | null) =>
  businessDate(value, settings.state.value.timezone)
const operationLabels: Record<string, string> = {
  ORDER_CREATED: '创建订单',
  ORDER_EDITED: '编辑订单',
  ORDER_CANCELLED: '取消订单',
  ORDER_FULFILLED: '履约完成',
  ORDER_INTERNAL_NOTE_UPDATED: '更新内部备注',
  PAYMENT_RECORDED: '登记付款',
  CUSTOMER_PAYMENT_CLAIMED: '客户提交付款核实',
  ADMIN_SELF_PAYMENT_CLAIMED: '管理员申请本人订单核实',
  PAYMENT_CONFIRMED: '确认收款',
  PAYMENT_FAILED: '付款失败',
  REFUND_RECORDED: '登记退款',
  REFUND_CONFIRMED: '退款到账',
  REFUND_FAILED: '退款失败',
}
const summaryLabels: Record<string, string> = {
  version: '版本',
  amountFen: '金额（分）',
  paymentStatus: '付款状态',
  fulfillmentStatus: '履约状态',
  transactionId: '交易记录',
  transactionStatus: '交易状态',
  channel: '渠道',
  transactionKind: '交易类型',
  fulfilledAt: '履约时间',
  subscriptionId: '订阅',
  cancelledAt: '取消时间',
  internalNote: '内部备注',
}
function summaryLabel(key: string) {
  return (
    (summaryLabels[key.replace(/Before$|After$/, '')] ?? key) +
    (key.endsWith('Before')
      ? '（之前）'
      : key.endsWith('After')
        ? '（之后）'
        : '')
  )
}
let sequence = 0
async function load() {
  const current = ++sequence
  loading.value = true
  error.value = ''
  verified.value = false
  try {
    const detail = await readOrder(props.id)
    const ordinary =
      ['USER', 'ADMIN'].includes(detail.order.creator.source ?? '') &&
      ['INITIAL', 'ONE_TIME'].includes(detail.order.kind)
    const empty = { items: [] as Evidence[], total: 0 }
    const [p, r, e] = await Promise.all([
      ordinary ? readEvidence(props.id, 'payments', paymentPage.value) : empty,
      ordinary ? readEvidence(props.id, 'refunds', refundPage.value) : empty,
      readEvents(props.id, eventPage.value),
    ])
    if (current !== sequence) return
    order.value = detail.order
    payments.value = p.items
    paymentTotal.value = p.total
    refunds.value = r.items
    refundTotal.value = r.total
    events.value = e.items
    eventTotal.value = e.total
  } catch (e) {
    if (current === sequence)
      error.value = e instanceof Error ? e.message : '详情读取失败'
  } finally {
    if (current === sequence) loading.value = false
  }
}
async function verifyEvidence() {
  loading.value = true
  error.value = ''
  try {
    const collect = async (kind: 'payments' | 'refunds') => {
      const rows: Evidence[] = []
      for (let page = 1; ; page++) {
        const result = await readEvidence(props.id, kind, page, 100)
        rows.push(...result.items)
        if (rows.length >= result.total) break
      }
      return rows
    }
    allPayments.value = await collect('payments')
    allRefunds.value = await collect('refunds')
    verified.value = true
  } catch {
    error.value = '交易核对失败，请重试；业务操作保持禁用'
  } finally {
    loading.value = false
  }
}
function open(a: Action, row?: Evidence) {
  action.value = a
  target.value = row
}
async function changed() {
  action.value = undefined
  editing.value = false
  paymentPage.value = 1
  refundPage.value = 1
  eventPage.value = 1
  await load()
  emit('changed')
}
async function stale() {
  message.value =
    '订单版本已变化，已刷新详情。请核对后重新操作，旧请求不会自动重放。'
  await changed()
}
onMounted(load)
</script>
<template>
  <ElDialog
    :model-value="true"
    title="订单详情"
    width="1100px"
    class="order-dialog"
    :close-on-click-modal="false"
    :close-on-press-escape="!action && !editing"
    :show-close="!action && !editing"
    @close="emit('close')"
  >
    <p v-if="error" class="form-error" role="alert">
      {{ error }} <ElButton @click="load">重试详情</ElButton>
    </p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="loading" role="status">正在读取订单…</p>
    <template v-if="order && !error">
      <div class="order-detail-heading">
        <div>
          <h2>{{ order.productNameSnapshot }}</h2>
          <p>
            <OrderNumber :order-no="order.orderNo" />
            · {{ kindLabels[order.kind] }} · 版本
            {{ order.version }}
          </p>
        </div>
        <strong>{{ money(order.amountFen) }}</strong>
      </div>
      <div class="order-statuses">
        <ElTag>{{ paymentLabels[order.paymentStatus] }}</ElTag><ElTag
          type="info"
          >{{ fulfillmentLabels[order.fulfillmentStatus] }}</ElTag
        >
      </div>
      <div class="order-detail-grid">
        <section class="panel">
          <h3>客户与商品快照</h3>
          <dl class="order-facts">
            <dt>客户</dt>
            <dd>{{ adminName(order.customer) }}</dd>
            <dt>联系邮箱</dt>
            <dd>{{ order.contactEmailSnapshot ?? '未记录' }}</dd>
            <dt>客户登录邮箱</dt>
            <dd>{{ order.customer.loginEmail ?? '待绑定邮箱' }}</dd>
            <dt>商品说明</dt>
            <dd>
              <LinkedText :text="order.productDescriptionSnapshot || '—'" />
            </dd>
            <dt>商品类型</dt>
            <dd>{{ order.productTypeSnapshot }}</dd>
            <dt>原价快照</dt>
            <dd>
              {{
                order.priceSnapshotFen === null
                  ? '未记录'
                  : money(order.priceSnapshotFen)
              }}
            </dd>
            <dt>展示周期</dt>
            <dd>{{ order.termSnapshot }}</dd>
            <dt>结构化周期</dt>
            <dd>
              {{ order.servicePeriodCountSnapshot ?? '未配置' }}
              {{ order.servicePeriodUnitSnapshot }}
            </dd>
            <dt>来源</dt>
            <dd>
              {{ order.creator.source }} ·
              {{ order.creator.adminId || order.creator.userId || '系统' }}
            </dd>
          </dl>
        </section>
        <section class="panel">
          <h3>时间 · {{ settings.state.value.timezone }}</h3>
          <dl class="order-facts">
            <template
              v-for="entry in [
                { label: '创建时间', value: order.createdAt },
                { label: '原始付款截止', value: order.expiresAt },
                { label: '实际付款', value: order.paidAt },
                { label: '确认收款', value: order.paymentConfirmedAt },
                { label: '履约完成', value: order.fulfilledAt },
                { label: '取消时间', value: order.cancelledAt },
              ]"
              :key="entry.label"
              ><dt>{{ entry.label }}</dt>
              <dd>{{ date(entry.value) }}</dd></template
            >
            <dt>取消原因</dt>
            <dd>{{ order.cancellationReason || '—' }}</dd>
          </dl>
        </section>
      </div>
      <section class="panel">
        <h3>冻结服务信息</h3>
        <ElForm v-if="schema" label-position="top"
          ><ProductFormInputs
            :schema="schema"
            :model-value="order.formData || {}"
            disabled
        /></ElForm>
        <p v-else class="muted">
          历史冻结表单未配置或格式不受支持，服务信息不展示。
        </p>
      </section>
      <section class="panel">
        <h3>关联订阅</h3>
        <dl v-if="order.linkedSubscription" class="order-facts">
          <dt>订阅 ID</dt>
          <dd>{{ order.linkedSubscription.id }}</dd>
          <dt>商品快照</dt>
          <dd>{{ order.linkedSubscription.productNameSnapshot }}</dd>
          <dt>来源 / 状态 / 版本</dt>
          <dd>
            {{ order.linkedSubscription.sourceType }} /
            {{ order.linkedSubscription.status }} /
            {{ order.linkedSubscription.version }}
          </dd>
          <dt>开始 / 到期</dt>
          <dd>
            {{ date(order.linkedSubscription.startedAt) }} —
            {{ date(order.linkedSubscription.expiresAt) }}
          </dd>
        </dl>
        <p v-else>无关联订阅</p>
      </section>
      <section class="panel">
        <h3>内部备注（仅管理员）</h3>
        <p class="order-plain">{{ order.internalNote || '暂无内部备注' }}</p>
        <ElButton v-if="actions?.note" :disabled="loading" @click="open('note')"
          >编辑内部备注</ElButton
        >
      </section>
      <div class="order-actions" aria-label="订单操作">
        <ElButton
          v-if="actions?.edit && schema"
          :disabled="loading"
          @click="editing = true"
          >编辑订单</ElButton
        >
        <ElButton
          v-if="actions?.record"
          :disabled="loading"
          @click="open('record')"
          >登记付款</ElButton
        >
        <ElButton
          v-if="actions?.cancel"
          :disabled="loading"
          @click="open('cancel')"
          >取消订单</ElButton
        >
        <ElButton
          v-if="actions?.fulfill && schema"
          type="primary"
          :disabled="loading"
          @click="open('fulfill')"
          >确认履约完成</ElButton
        >
        <ElButton
          v-if="actions?.refund"
          :disabled="loading"
          @click="open('refund')"
          >登记线下退款</ElButton
        >
        <p v-if="!complete">
          为避免遗漏其他待核实记录，业务操作暂不可用。<ElButton
            :loading="loading"
            @click="verifyEvidence"
            >核对全部交易记录</ElButton
          >
        </p>
        <p
          v-if="
            !actions?.edit &&
            !actions?.record &&
            !actions?.cancel &&
            !actions?.fulfill &&
            !actions?.refund
          "
          class="muted"
        >
          当前状态没有可用的订单生命周期操作。
        </p>
      </div>
      <section
        v-for="kind in ['payments', 'refunds'] as const"
        :key="kind"
        class="panel"
      >
        <h3>{{ kind === 'payments' ? '付款证据' : '退款记录' }}</h3>
        <div class="order-table-scroll">
          <table class="order-table">
            <thead>
              <tr>
                <th>交易 / 状态</th>
                <th>金额 / 渠道</th>
                <th>发生时间</th>
                <th>参考号 / 说明</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in kind === 'payments' ? payments : refunds"
                :key="row.id"
              >
                <td>
                  {{ row.id }}<br />{{
                    row.status === 'PENDING'
                      ? '待核实'
                      : row.status === 'CONFIRMED'
                        ? '已确认'
                        : '失败'
                  }}
                </td>
                <td>
                  {{ money(row.amountFen) }} · {{ channelLabels[row.channel]
                  }}<strong
                    v-if="
                      kind === 'payments' && row.amountFen !== order.amountFen
                    "
                    class="form-error"
                  >
                    金额不符，不可确认</strong
                  >
                </td>
                <td>{{ date(row.occurredAt) }}</td>
                <td class="order-plain">
                  {{ row.externalReference || '—' }}<br />{{ row.note || '—' }}
                </td>
                <td>
                  <template
                    v-if="
                      row.status === 'PENDING' &&
                      kind === 'payments' &&
                      actions?.pendingPayment
                    "
                    ><ElButton
                      :disabled="
                        loading ||
                        row.amountFen !== order.amountFen ||
                        activePayments !== 1
                      "
                      @click="open('confirm', row)"
                      >确认收款</ElButton
                    ><ElButton :disabled="loading" @click="open('fail', row)"
                      >标记付款失败</ElButton
                    ><small v-if="activePayments > 1"
                      >请先关闭其他待核实付款记录</small
                    ></template
                  >
                  <template
                    v-if="
                      row.status === 'PENDING' &&
                      kind === 'refunds' &&
                      actions?.pendingRefund
                    "
                    ><ElButton
                      :disabled="loading"
                      @click="open('confirmRefund', row)"
                      >确认退款到账</ElButton
                    ><ElButton
                      :disabled="loading"
                      @click="open('failRefund', row)"
                      >标记退款失败</ElButton
                    ></template
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!(kind === 'payments' ? payments : refunds).length">
          暂无记录
        </p>
        <ElPagination
          :current-page="kind === 'payments' ? paymentPage : refundPage"
          :page-size="20"
          :total="kind === 'payments' ? paymentTotal : refundTotal"
          layout="prev, pager, next"
          @current-change="
            (p: number) => {
              if (kind === 'payments') paymentPage = p
              else refundPage = p
              load()
            }
          "
        />
      </section>
      <section class="panel">
        <h3>订单事件时间线</h3>
        <p v-if="!events.length">暂无事件</p>
        <ol class="order-timeline">
          <li v-for="event in events" :key="event.id">
            <strong>{{
              operationLabels[event.operation || ''] || event.eventType
            }}</strong>
            · {{ event.actorDisplayName }}（{{ event.actorType }}） ·
            {{ date(event.createdAt) }}
            <p v-if="event.note" class="order-plain">{{ event.note }}</p>
            <dl class="order-facts">
              <template v-for="(value, key) in event.summary" :key="key"
                ><dt>{{ summaryLabel(key) }}</dt>
                <dd class="order-plain">
                  {{ value === null ? '空' : value }}
                </dd></template
              >
            </dl>
          </li>
        </ol>
        <ElPagination
          v-model:current-page="eventPage"
          :page-size="20"
          :total="eventTotal"
          layout="prev, pager, next"
          @current-change="load"
        />
      </section>
    </template>
  </ElDialog>
  <OrderAction
    v-if="action && order"
    :key="action"
    :order="order"
    :action="action"
    :evidence="target"
    :original-payment="confirmed"
    @close="action = undefined"
    @saved="changed"
    @stale="stale"
  />
  <OrderForm
    v-if="editing && order"
    :order="order"
    @close="editing = false"
    @saved="changed"
    @stale="stale"
  />
</template>
