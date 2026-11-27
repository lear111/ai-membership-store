<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { ApiError } from '../../api/client'
import { OrderRequest } from '../../api/orders'
import {
  customerOrderPath,
  readCustomerOrder,
  type CustomerOrder,
  type OrderGuidance,
} from '../../api/customer-orders'
import type { FormData } from '../../api/subscriptions'
import LinkedText from '../../components/LinkedText.vue'
import OrderNumber from '../../components/OrderNumber.vue'
import ProductFormInputs from '../../components/ProductFormInputs.vue'
import CustomerWechatPayment from './CustomerWechatPayment.vue'
import { parseFormData } from '../../../../backend/src/contracts/form-data'
import { formLimitErrorMessage } from '../../../../backend/src/contracts/form-limits'
import { formValueLabel, money } from '../../stores/format'
import {
  businessDate,
  fulfillmentLabels,
  kindLabels,
} from '../admin/orders/state'
import {
  canCancel,
  customerPaymentLabels,
  orderStatus,
  paymentTimeLeft,
  safeFrozenForm,
  timeline,
  useNarrowOrderDialog,
  useOrderClock,
} from './customer-order-state'

const props = defineProps<{
  id: string
  guidance?: OrderGuidance
  guidanceFailed: boolean
}>()
const emit = defineEmits<{
  close: [id: string]
  changed: []
  retryGuidance: []
}>()
const order = shallowRef<CustomerOrder>()
const mode = ref<'detail' | 'edit' | 'cancel' | 'claim'>('detail')
const loading = ref(false)
const busy = ref(false)
const uncertain = ref(false)
const error = ref('')
const actionError = ref('')
const notice = ref('')
const draft = ref<FormData>({})
const reason = ref('')
const receivedAt = ref(0)
const clock = useOrderClock()
const mobile = useNarrowOrderDialog()
const request = new OrderRequest<CustomerOrder>()
const snapshot = computed(() =>
  order.value ? safeFrozenForm(order.value) : null,
)
const remaining = computed(() =>
  order.value ? paymentTimeLeft(order.value, receivedAt.value, clock.value) : 0,
)
const payable = computed(() => remaining.value > 0)
const hasMerchantRemark = computed(() =>
  Boolean(props.guidance?.paymentInstructions.trim()),
)
const date = (value: string) =>
  props.guidance ? businessDate(value, props.guidance.businessTimezone) : '—'

async function load() {
  loading.value = true
  error.value = ''
  order.value = undefined
  try {
    const result = await readCustomerOrder(props.id)
    receivedAt.value = performance.now()
    order.value = result.order
  } catch (cause) {
    error.value =
      cause instanceof ApiError && cause.status === 404
        ? '订单不存在。'
        : '无法读取订单详情，请重试。'
  } finally {
    loading.value = false
  }
}

function begin(action: 'edit' | 'cancel' | 'claim') {
  mode.value = action
  actionError.value = ''
  notice.value = ''
  reason.value = ''
  request.reset()
  if (action === 'edit' && snapshot.value)
    draft.value = structuredClone(snapshot.value.data)
}

async function save() {
  const current = order.value
  if (busy.value || !current) return
  actionError.value = ''
  busy.value = true
  try {
    if (uncertain.value) await request.retry()
    else if (mode.value === 'edit' && snapshot.value) {
      let formData: FormData
      try {
        formData = parseFormData(snapshot.value.schema, draft.value)
      } catch (cause) {
        actionError.value =
          formLimitErrorMessage(cause) ?? '请核对服务信息并填写所有必填项。'
        return
      }
      await request.send(customerOrderPath(current.id), 'PATCH', {
        expectedVersion: current.version,
        formData,
      })
    } else if (mode.value === 'cancel') {
      const text = reason.value.trim()
      if (text.length > 500) throw new Error('取消原因最多 500 字。')
      await request.send(customerOrderPath(current.id) + '/cancel', 'POST', {
        expectedVersion: current.version,
        ...(text ? { reason: text } : {}),
      })
    } else if (mode.value === 'claim') {
      await request.send(
        customerOrderPath(current.id) + '/payment-claim',
        'POST',
        {
          expectedVersion: current.version,
        },
      )
    } else return
    if (mode.value !== 'claim')
      notice.value =
        mode.value === 'cancel' ? '订单已取消。' : '服务信息已更新。'
    await refresh()
  } catch (cause) {
    if (
      cause instanceof ApiError &&
      [
        'VERSION_CONFLICT',
        'ORDER_NOT_EDITABLE',
        'ORDER_NOT_CANCELLABLE',
        'ORDER_NOT_PAYABLE',
      ].includes(cause.code)
    ) {
      notice.value = '订单状态或版本已变化，请核对最新详情后再操作。'
      await refresh()
    } else {
      uncertain.value =
        cause instanceof SyntaxError ||
        (cause instanceof ApiError &&
          (cause.status === 0 || cause.status >= 500))
      actionError.value =
        cause instanceof Error ? cause.message : '操作失败，请重试。'
    }
  } finally {
    busy.value = false
  }
}
async function refresh() {
  uncertain.value = false
  request.reset()
  mode.value = 'detail'
  emit('changed')
  await load()
}

onMounted(load)
</script>
<template>
  <ElDialog
    :model-value="true"
    :title="
      mode === 'edit'
        ? '修改订单'
        : mode === 'cancel'
          ? '确认取消订单'
          : mode === 'claim'
            ? '确认付款核实'
            : '订单详情'
    "
    :width="mobile ? '100%' : 'min(960px, 92vw)'"
    :fullscreen="mobile"
    :show-close="!busy && !uncertain"
    :close-on-press-escape="!busy && !uncertain"
    :close-on-click-modal="false"
    @close="emit('close', id)"
  >
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="loading" role="status">正在读取订单…</p>
    <p v-else-if="error" role="alert" class="form-error">
      {{ error }} <ElButton link @click="load">重试详情</ElButton>
    </p>
    <div v-else-if="order" class="customer-order-detail">
      <header class="order-hero">
        <div class="order-hero-main">
          <strong
            class="order-state"
            :data-payment="order.paymentStatus"
            :data-fulfillment="order.fulfillmentStatus"
            >{{ orderStatus(order) }}</strong
          >
          <h2>{{ order.productNameSnapshot }}</h2>
          <p class="order-state-details">
            <span>付款 · {{ customerPaymentLabels[order.paymentStatus] }}</span>
            <span>履约 · {{ fulfillmentLabels[order.fulfillmentStatus] }}</span>
          </p>
        </div>
        <section class="order-reference" aria-label="订单号">
          <span class="reference-label">商城订单号</span>
          <OrderNumber :order-no="order.orderNo" />
        </section>
      </header>
      <template v-if="mode === 'detail'">
        <p v-if="orderStatus(order) === '状态待确认'" class="order-notice">
          请联系商家确认订单状态。
        </p>
        <p v-if="orderStatus(order) === '付款待核实'" class="order-notice">
          已提交付款核实，请勿重复转账。管理员确认实际到账后才会处理订单。
          订单创建满 24 小时未核实可能自动取消。如已转账，请联系商家线下处理。
        </p>
        <p
          v-if="order.fulfillmentStatus === 'CANCELLED' && order.amountFen > 0"
          class="order-notice"
        >
          如已付款，请联系商家线下处理款项。
        </p>
        <CustomerWechatPayment
          v-if="payable"
          :order="order"
          :remaining="remaining"
          @claim="begin('claim')"
        />
        <section
          v-if="payable || hasMerchantRemark || guidanceFailed"
          aria-label="商家备注"
          class="merchant-remarks"
        >
          <h3>商家备注</h3>
          <p v-if="payable" class="payment-reminder">
            请在微信付款页面填写正确的付款金额和商城订单号，避免无法核实到账。
          </p>
          <p v-if="hasMerchantRemark" class="merchant-text">
            {{ guidance?.paymentInstructions }}
          </p>
          <p v-if="guidanceFailed" class="merchant-unavailable" role="alert">
            商家备注暂不可用。<ElButton link @click="emit('retryGuidance')"
              >重试读取</ElButton
            >
          </p>
        </section>
        <div class="order-detail-columns">
          <div class="order-detail-column">
            <section class="order-detail-card" aria-label="商品及价格">
              <h3>商品及价格</h3>
              <p
                v-if="order.productDescriptionSnapshot"
                class="order-description"
              >
                <LinkedText :text="order.productDescriptionSnapshot" />
              </p>
              <dl class="customer-facts">
                <div>
                  <dt>类型</dt>
                  <dd>
                    {{
                      order.productTypeSnapshot === 'SUBSCRIPTION'
                        ? '订阅商品'
                        : '一次性商品'
                    }}
                    · {{ kindLabels[order.kind] }}
                  </dd>
                </div>
                <div>
                  <dt>服务周期</dt>
                  <dd>
                    {{ order.termSnapshot
                    }}<span
                      v-if="
                        order.servicePeriodUnitSnapshot &&
                        order.servicePeriodCountSnapshot
                      "
                    >
                      · {{ order.servicePeriodCountSnapshot }}
                      {{
                        { DAY: '天', MONTH: '月', YEAR: '年' }[
                          order.servicePeriodUnitSnapshot
                        ]
                      }}</span
                    >
                  </dd>
                </div>
                <div>
                  <dt>应付金额</dt>
                  <dd class="order-price">{{ money(order.amountFen) }}</dd>
                </div>
                <div>
                  <dt>商品原价</dt>
                  <dd>
                    {{
                      order.priceSnapshotFen === null
                        ? '暂无历史原价'
                        : money(order.priceSnapshotFen)
                    }}
                  </dd>
                </div>
              </dl>
            </section>
            <section
              v-if="snapshot?.schema.fields.length || !snapshot"
              class="order-detail-card"
              aria-label="服务信息"
            >
              <h3>服务信息</h3>
              <dl v-if="snapshot" class="customer-facts">
                <div v-for="field in snapshot.schema.fields" :key="field.id">
                  <dt>{{ field.label }}</dt>
                  <dd class="plain">
                    {{ formValueLabel(field, snapshot.data[field.id]) }}
                  </dd>
                </div>
              </dl>
              <p v-else class="muted">此订单没有可显示的服务信息。</p>
            </section>
          </div>
          <div class="order-detail-column">
            <section class="order-detail-card" aria-label="联系人信息">
              <h3>联系人信息</h3>
              <dl class="customer-facts contact-facts">
                <div>
                  <dt>联系人邮箱</dt>
                  <dd>{{ order.contactEmailSnapshot ?? '未记录' }}</dd>
                </div>
              </dl>
            </section>
            <section class="order-detail-card" aria-label="订单进度">
              <h3>订单进度</h3>
              <ol class="customer-timeline">
                <li v-for="item in timeline(order)" :key="item.label">
                  <strong>{{ item.label }}</strong>
                  <time :datetime="item.at">{{ date(item.at) }}</time>
                </li>
              </ol>
              <dl class="customer-facts order-deadline">
                <div>
                  <dt>原始付款截止</dt>
                  <dd>
                    <time :datetime="order.expiresAt">{{
                      date(order.expiresAt)
                    }}</time>
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        </div>
      </template>
      <template v-else>
        <p v-if="actionError" role="alert" class="form-error">
          {{ actionError }}
        </p>
        <p v-if="uncertain" role="status">结果尚未确认，可重试原请求。</p>
        <p v-if="mode === 'claim'">
          请确认你已在微信完成付款，且付款金额和填写的商城订单号均正确。
        </p>
        <ElForm
          v-if="mode === 'edit' && snapshot"
          label-position="top"
          :disabled="busy || uncertain"
          @submit.prevent="save"
        >
          <p>修改此订单的服务信息。</p>
          <ProductFormInputs
            v-model="draft"
            :schema="snapshot.schema"
            :disabled="busy || uncertain"
          />
        </ElForm>
        <ElForm
          v-else-if="mode === 'cancel'"
          label-position="top"
          :disabled="busy || uncertain"
          @submit.prevent="save"
        >
          <p>取消后无法恢复此订单。</p>
          <p
            v-if="order.paymentStatus === 'PENDING_VERIFICATION'"
            class="inline-note"
            role="note"
          >
            取消会关闭待核实付款记录。如果已转账但尚未核实，请联系商家，在订单系统外处理款项。
          </p>
          <ElFormItem label="取消原因（可选）">
            <ElInput
              v-model="reason"
              type="textarea"
              maxlength="500"
              aria-label="取消原因（可选）"
            />
          </ElFormItem>
        </ElForm>
      </template>
    </div>
    <template
      v-if="
        mode !== 'detail' ||
        (order &&
          (canCancel(order) || (payable && snapshot?.schema.fields.length)))
      "
      #footer
    >
      <div class="customer-order-actions">
        <template v-if="mode === 'detail'">
          <ElButton
            v-if="order && payable && snapshot?.schema.fields.length"
            :disabled="busy"
            type="primary"
            @click="begin('edit')"
            >修改订单</ElButton
          >
          <ElButton
            v-if="order && canCancel(order)"
            :disabled="busy"
            @click="begin('cancel')"
            >取消订单</ElButton
          >
        </template>
        <template v-else>
          <ElButton :disabled="busy || uncertain" @click="mode = 'detail'"
            >返回详情</ElButton
          >
          <ElButton
            :loading="busy"
            :type="mode === 'cancel' ? 'danger' : 'primary'"
            @click="save"
          >
            {{
              uncertain
                ? '重试原请求'
                : mode === 'cancel'
                  ? '确认取消'
                  : mode === 'claim'
                    ? '提交付款核实'
                    : '保存修改'
            }}
          </ElButton>
        </template>
      </div>
    </template>
  </ElDialog>
</template>
<style scoped>
.customer-order-detail {
  --detail-text: #15233b;
  --detail-secondary: #485b76;
  --detail-border: #dce5f0;
  display: grid;
  gap: 16px;
  min-width: 0;
  color: var(--detail-text);
  overflow-wrap: anywhere;
}
.order-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 248px);
  align-items: center;
  gap: 16px;
  padding: clamp(16px, 3vw, 24px);
  border: 1px solid var(--detail-border);
  border-radius: 16px;
  background: #f8faff;
}
.order-hero h2 {
  margin: 8px 0 10px;
  color: var(--detail-text);
  font-size: clamp(23px, 4vw, 30px);
  line-height: 1.2;
}
.order-state {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 8px;
  color: #254cab;
  background: #e8efff;
  font-size: 13px;
  line-height: 1.45;
}
.order-state[data-fulfillment='COMPLETED'] {
  color: #116149;
  background: #e4f4ec;
}
.order-state[data-fulfillment='CANCELLED'] {
  color: #475569;
  background: #e9eef3;
}
.order-state[data-payment='PENDING_VERIFICATION'],
.order-state[data-payment='REFUND_PENDING'] {
  color: #815016;
  background: #fff1d8;
}
.order-state-details {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0;
  color: var(--detail-secondary);
  line-height: 1.55;
}
.order-reference {
  display: grid;
  justify-items: start;
  gap: 6px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--detail-border);
  border-radius: 12px;
  background: #fff;
}
.reference-label {
  color: var(--detail-secondary);
  font-size: 13px;
}
.order-reference :deep(.order-number > span) {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: clamp(16px, 3.8vw, 21px);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 1.2;
}
.order-notice {
  margin: 0;
  padding: 12px 16px;
  border: 1px solid #eddbb2;
  border-radius: 12px;
  background: #fff8eb;
  color: #73471a;
  line-height: 1.65;
}
.merchant-remarks {
  padding: clamp(16px, 3vw, 24px);
  border: 1px solid #d2e0fa;
  border-inline-start: 4px solid #426ad1;
  border-radius: 14px;
  background: #f8faff;
}
.merchant-remarks h3,
.order-detail-card h3 {
  margin: 0 0 10px;
  color: var(--detail-text);
  font-size: 16px;
}
.merchant-remarks h3 {
  font-size: 18px;
}
.merchant-remarks p {
  margin: 0;
  font-size: 15px;
  line-height: 1.75;
}
.merchant-remarks p + p {
  margin-top: 8px;
}
.payment-reminder {
  color: #24478e;
  font-weight: 650;
}
.merchant-text,
.plain {
  white-space: pre-wrap;
}
.merchant-unavailable {
  color: var(--detail-secondary);
}
.order-detail-columns {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  align-items: start;
  gap: 16px;
}
.order-detail-column {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.order-detail-card {
  padding: 16px;
  border: 1px solid var(--detail-border);
  border-radius: 14px;
  background: #fff;
}
.order-description {
  margin: 0 0 14px;
  color: var(--detail-secondary);
  line-height: 1.7;
}
.customer-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
}
.contact-facts,
.order-deadline {
  grid-template-columns: minmax(0, 1fr);
}
.customer-facts dt,
.customer-timeline time {
  color: var(--detail-secondary);
  font-size: 13px;
}
.customer-facts dd {
  margin: 3px 0 0;
  line-height: 1.5;
}
.order-price {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.order-deadline {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--detail-border);
}
.customer-timeline {
  list-style: none;
  margin: 0;
  padding-inline-start: 12px;
  border-inline-start: 2px solid #d6e2f8;
}
.customer-timeline li {
  position: relative;
  display: grid;
  gap: 3px;
}
.customer-timeline li + li {
  margin-top: 12px;
}
.customer-timeline li::before {
  position: absolute;
  inset-block-start: 6px;
  inset-inline-start: -17px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #426ad1;
  content: '';
}
.customer-order-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}
.customer-order-actions .el-button {
  margin: 0;
}
@media (max-width: 640px) {
  .order-hero,
  .order-detail-columns {
    grid-template-columns: minmax(0, 1fr);
  }
  .customer-order-actions .el-button {
    flex: 1 1 10rem;
    min-height: 40px;
  }
}
</style>
