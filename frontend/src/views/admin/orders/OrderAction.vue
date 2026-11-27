<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ApiError } from '../../../api/client'
import {
  OrderRequest,
  type AdminOrder,
  type Evidence,
} from '../../../api/orders'
import {
  transactionTimeChoices,
  transactionTimeInput,
} from '../../../../../backend/src/contracts/transaction-time'
import { settings } from '../../../stores/settings'
import { formatOrderNumber, money, parsePrice } from '../../../stores/format'
import { channelLabels } from './state'
export type Action =
  | 'note'
  | 'cancel'
  | 'record'
  | 'confirm'
  | 'fail'
  | 'refund'
  | 'confirmRefund'
  | 'failRefund'
  | 'fulfill'
const props = defineProps<{
  order: AdminOrder
  action: Action
  evidence?: Evidence
  originalPayment?: Evidence
}>()
const emit = defineEmits<{ close: []; saved: []; stale: [] }>()
const titles = {
  note: '编辑内部备注',
  cancel: '取消订单',
  record: '登记付款',
  confirm: '确认收款',
  fail: '付款标记失败',
  refund: '登记线下退款',
  confirmRefund: '确认退款到账',
  failRefund: '退款标记失败',
  fulfill: '确认履约完成',
}
const note = ref(
    props.action === 'note' ? (props.order.internalNote ?? '') : '',
  ),
  reason = ref('')
const amount = ref((props.order.amountFen / 100).toFixed(2)),
  channel = ref<Evidence['channel']>('CASH')
const timeZone = computed(() => settings.state.value.timezone)
const isRecording = props.action === 'record' || props.action === 'refund'
const occurred = ref(
    isRecording
      ? transactionTimeInput(new Date().toISOString(), timeZone.value)
      : '',
  ),
  selectedInstant = ref(''),
  reference = ref(''),
  acknowledged = ref(false)
const timeOptions = computed(() => {
  try {
    return { choices: transactionTimeChoices(occurred.value, timeZone.value) }
  } catch (error) {
    return {
      choices: [],
      error: error instanceof Error ? error.message : '无法换算交易发生时间',
    }
  }
})
watch([occurred, timeZone], () => (selectedInstant.value = ''), {
  flush: 'sync',
})
const error = ref(''),
  busy = ref(false),
  uncertain = ref(false),
  request = new OrderRequest()
async function save() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    if (uncertain.value) {
      await request.retry()
      uncertain.value = false
      emit('saved')
      return
    }
    if (isRecording && (!settings.state.loaded || settings.state.error))
      throw new Error('请先成功读取系统时区设置后再登记交易')
    const a = props.action,
      o = props.order
    const body: Record<string, unknown> = { expectedVersion: o.version }
    let path = '/admin/orders/' + o.id,
      method = 'POST'
    if (a === 'note') {
      path += '/internal-note'
      method = 'PATCH'
      body.internalNote = note.value.trim() || null
    } else if (a === 'cancel' || a === 'fail' || a === 'failRefund') {
      if (!reason.value.trim()) throw new Error('必须填写原因')
      body.reason = reason.value.trim()
      path =
        a === 'cancel'
          ? path + '/cancel'
          : '/admin/payment-transactions/' +
            props.evidence!.id +
            (a === 'fail' ? '/fail' : '/fail-refund')
    } else if (a === 'record' || a === 'refund') {
      if (a === 'refund' && !acknowledged.value)
        throw new Error('请确认已在外部发起全额退款')
      body.amountFen =
        a === 'refund'
          ? props.originalPayment!.amountFen
          : parsePrice(amount.value)
      if (Number(body.amountFen) <= 0) throw new Error('付款金额必须大于零')
      body.channel =
        a === 'refund' ? props.originalPayment!.channel : channel.value
      const { choices, error } = timeOptions.value
      if (error) throw new Error(error)
      const chosen =
        choices.length === 1
          ? choices[0]
          : choices.find(({ utc }) => utc === selectedInstant.value)
      if (!chosen) throw new Error('请选择回拨时段的实际 UTC 偏移')
      body.occurredAt = chosen.utc
      if (reference.value.trim())
        body.externalReference = reference.value.trim()
      if (note.value.trim()) body.note = note.value.trim()
      path += a === 'record' ? '/payment-transactions' : '/refunds'
    } else if (a === 'fulfill') {
      if (!acknowledged.value) throw new Error('请确认服务已实际履约完成')
      path += '/fulfill'
      if (note.value.trim()) body.fulfillmentNote = note.value.trim()
    } else {
      if (!acknowledged.value)
        throw new Error(
          a === 'confirm'
            ? '请核实外部实际全额收款'
            : '请确认客户已实际收到全额退款',
        )
      path =
        '/admin/payment-transactions/' +
        props.evidence!.id +
        (a === 'confirm' ? '/confirm' : '/confirm-refund')
    }
    await request.send(path, method, body)
    uncertain.value = false
    emit('saved')
  } catch (e) {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      emit('stale')
      emit('close')
    } else {
      uncertain.value =
        e instanceof SyntaxError ||
        (e instanceof ApiError && (e.status === 0 || e.status >= 500))
      error.value = e instanceof Error ? e.message : '操作失败'
    }
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <ElDialog
    :model-value="true"
    :title="titles[action]"
    width="600px"
    class="order-dialog"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy && !uncertain"
    :show-close="!busy && !uncertain"
    @close="emit('close')"
  >
    <p>
      订单 {{ formatOrderNumber(order.orderNo) }} · 版本 {{ order.version }}
    </p>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <p v-if="uncertain" role="alert">
      响应未确认，请重试原请求；将使用相同请求内容和幂等密钥。
    </p>
    <fieldset class="order-fieldset" :disabled="busy || uncertain">
      <ElForm label-position="top">
        <p v-if="action === 'cancel'">
          取消订单不代表退款；已付款订单取消后需单独登记并确认线下退款。
        </p>
        <template v-if="action === 'record' || action === 'refund'">
          <p v-if="action === 'refund'" role="note">
            必须已在外部发起全额退款。此处只登记待确认记录，不代表退款成功。原路全额：{{
              money(originalPayment!.amountFen)
            }}
            · {{ channelLabels[originalPayment!.channel] }}
          </p>
          <p v-else>仅登记实际付款证据；金额不符仍可登记，但不能确认收款。</p>
          <template v-if="action === 'record'">
            <ElFormItem label="实际付款金额（元）"
              ><ElInput
                v-model="amount"
                aria-label="实际付款金额（元）"
                :disabled="busy || uncertain"
            /></ElFormItem>
            <ElFormItem label="付款渠道"
              ><ElSelect
                v-model="channel"
                aria-label="付款渠道"
                :disabled="busy || uncertain"
                ><ElOption
                  v-for="(label, value) in channelLabels"
                  :key="value"
                  :value="value"
                  :label="label" /></ElSelect
            ></ElFormItem>
          </template>
          <ElFormItem :label="'实际发生时间（' + timeZone + '）'"
            ><input
              v-model="occurred"
              aria-label="实际发生时间"
              type="datetime-local"
              step="0.001"
          /></ElFormItem>
          <ElFormItem
            v-if="timeOptions.choices.length > 1"
            label="回拨时段的 UTC 偏移"
          >
            <select v-model="selectedInstant" aria-label="回拨时段的 UTC 偏移">
              <option value="" disabled>请选择实际发生的那一次</option>
              <option
                v-for="(choice, index) in timeOptions.choices"
                :key="choice.utc"
                :value="choice.utc"
              >
                第 {{ index + 1 }} 次（UTC{{ choice.offset }}）
              </option>
            </select>
          </ElFormItem>
          <ElFormItem label="外部交易参考号"
            ><ElInput
              v-model="reference"
              aria-label="外部交易参考号"
              maxlength="120"
              :disabled="busy || uncertain"
          /></ElFormItem>
        </template>
        <ElFormItem
          v-if="['cancel', 'fail', 'failRefund'].includes(action)"
          label="原因（必填）"
          ><ElInput
            v-model="reason"
            aria-label="原因（必填）"
            type="textarea"
            maxlength="500"
            :disabled="busy || uncertain"
        /></ElFormItem>
        <ElFormItem
          v-if="['note', 'record', 'refund', 'fulfill'].includes(action)"
          :label="
            action === 'note' ? '内部备注（仅管理员）' : '补充说明（可选）'
          "
          ><ElInput
            v-model="note"
            :aria-label="
              action === 'note' ? '内部备注（仅管理员）' : '补充说明（可选）'
            "
            type="textarea"
            :maxlength="action === 'note' ? 2000 : 500"
            :disabled="busy || uncertain"
        /></ElFormItem>
        <ElCheckbox
          v-if="
            ['confirm', 'confirmRefund', 'refund', 'fulfill'].includes(action)
          "
          v-model="acknowledged"
          :disabled="busy || uncertain"
          >{{
            action === 'confirm'
              ? '已在外部核实实际全额收款'
              : action === 'confirmRefund'
                ? '已核实客户实际收到全额退款'
                : action === 'refund'
                  ? '已在外部发起原路全额退款'
                  : '已确认服务实际履约完成'
          }}</ElCheckbox
        >
      </ElForm>
    </fieldset>
    <template #footer
      ><ElButton :disabled="busy || uncertain" @click="emit('close')"
        >返回</ElButton
      ><ElButton type="primary" :loading="busy" @click="save">{{
        uncertain ? '重试原请求' : '确认提交'
      }}</ElButton></template
    >
  </ElDialog>
</template>
