<script setup lang="ts">
import { adminName } from '../../../stores/user-name'
import { computed, onMounted, ref, toRaw } from 'vue'
import {
  api,
  ApiError,
  type CustomerList,
  type Customer,
} from '../../../api/client'
import { readProducts, type Product } from '../../../api/products'
import { OrderRequest, type AdminOrder } from '../../../api/orders'
import type { FormData } from '../../../api/subscriptions'
import ProductFormInputs from '../../../components/ProductFormInputs.vue'
import { productFormSchema } from '../../../../../backend/src/contracts/product-form'
import { parseFormData } from '../../../../../backend/src/contracts/form-data'
import { formLimitErrorMessage } from '../../../../../backend/src/contracts/form-limits'
import { money, parsePrice } from '../../../stores/format'
const props = defineProps<{ order?: AdminOrder }>()
const emit = defineEmits<{ close: []; saved: [AdminOrder]; stale: [] }>()
const customers = ref<Customer[]>([]),
  products = ref<Product[]>([])
const customerId = ref(''),
  productId = ref(''),
  amount = ref(props.order ? (props.order.amountFen / 100).toFixed(2) : '')
const reason = ref(''),
  note = ref(''),
  formData = ref<FormData>(structuredClone(toRaw(props.order?.formData ?? {})))
const error = ref(''),
  busy = ref(false),
  uncertain = ref(false),
  loading = ref(false)
const request = new OrderRequest()
const product = computed(() =>
  products.value.find((p) => p.id === productId.value),
)
const schema = computed(() => {
  const parsed = productFormSchema.safeParse(
    props.order?.formSchemaSnapshot ?? product.value?.formSchema,
  )
  return parsed.success ? parsed.data : null
})
let customerSequence = 0,
  productSequence = 0
async function findCustomers(search = '') {
  const sequence = ++customerSequence
  try {
    const result = await api<CustomerList>(
      '/admin/users?' + new URLSearchParams({ search, pageSize: '100' }),
    )
    if (sequence === customerSequence)
      customers.value = result.items.filter(
        (c) => c.role === 'CUSTOMER' && c.status !== 'DISABLED',
      )
  } catch {
    error.value = '客户读取失败，请重新搜索'
  }
}
async function findProducts(search = '') {
  const sequence = ++productSequence
  loading.value = true
  try {
    const result = await readProducts(
      new URLSearchParams({ search, archived: 'ACTIVE', pageSize: '100' }),
    )
    if (sequence === productSequence)
      products.value = result.items.filter((p) => !p.archivedAt)
  } catch {
    error.value = '商品读取失败，请重新搜索'
  } finally {
    if (sequence === productSequence) loading.value = false
  }
}
function chooseProduct() {
  const p = product.value
  amount.value = p ? (p.priceFen / 100).toFixed(2) : ''
  reason.value = ''
  formData.value = {}
  for (const field of p?.formSchema.fields ?? [])
    if (field.defaultValue !== undefined)
      formData.value[field.id] = structuredClone(toRaw(field.defaultValue))
}
async function save() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    if (!schema.value) throw new Error('缺少合法的服务表单，不能创建或编辑')
    const data = parseFormData(schema.value, formData.value),
      amountFen = parsePrice(amount.value)
    const baseline = props.order?.amountFen ?? product.value?.priceFen
    if (amountFen !== baseline && !reason.value.trim())
      throw new Error('请填写价格调整原因')
    if (!props.order && (!customerId.value || !product.value))
      throw new Error('请选择客户和商品')
    if (
      !props.order &&
      product.value?.type === 'SUBSCRIPTION' &&
      (!product.value.servicePeriodUnit || !product.value.servicePeriodCount)
    )
      throw new Error('商品尚未配置结构化周期，请先在商品管理补录')
    const body = {
      formData: data,
      amountFen,
      ...(reason.value.trim()
        ? { priceAdjustmentReason: reason.value.trim() }
        : {}),
      ...(props.order
        ? { expectedVersion: props.order.version }
        : {
            userId: customerId.value,
            productId: productId.value,
            internalNote: note.value.trim() || null,
          }),
    }
    const result = await request.send(
      props.order ? '/admin/orders/' + props.order.id : '/admin/orders',
      props.order ? 'PATCH' : 'POST',
      body,
    )
    uncertain.value = false
    emit('saved', result.order)
  } catch (e) {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      emit('stale')
      emit('close')
    } else {
      uncertain.value =
        e instanceof SyntaxError ||
        (e instanceof ApiError && (e.status === 0 || e.status >= 500))
      error.value =
        formLimitErrorMessage(e) ??
        (e instanceof Error ? e.message : '保存失败')
    }
  } finally {
    busy.value = false
  }
}
onMounted(() => {
  if (!props.order) {
    void findCustomers()
    void findProducts()
  }
})
</script>
<template>
  <ElDialog
    :model-value="true"
    :title="order ? '编辑订单' : '新建订单'"
    width="720px"
    class="order-dialog"
    :close-on-click-modal="false"
    :close-on-press-escape="!uncertain && !busy"
    :show-close="!uncertain && !busy"
    @close="emit('close')"
  >
    <p class="muted">服务信息按商品表单填写。</p>
    <p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <p v-if="uncertain" role="alert">
      响应未确认。请重试原请求，系统会沿用原幂等密钥。
    </p>
    <fieldset :disabled="busy || uncertain" class="order-fieldset">
      <ElForm label-position="top" @submit.prevent="save">
        <template v-if="!order">
          <ElFormItem label="选择客户"
            ><ElSelect
              v-model="customerId"
              aria-label="选择客户"
              :disabled="busy || uncertain"
              filterable
              remote
              :remote-method="findCustomers"
              placeholder="搜索邮箱、用户名或管理员标签"
              ><ElOption
                v-for="c in customers"
                :key="c.id"
                :value="c.id"
                :label="
                  adminName(c) +
                  (c.status === 'PENDING_ACTIVATION' ? '（待激活）' : '')
                " /></ElSelect
          ></ElFormItem>
          <ElFormItem label="选择商品"
            ><ElSelect
              v-model="productId"
              aria-label="选择商品"
              :disabled="busy || uncertain"
              filterable
              remote
              :remote-method="findProducts"
              :loading="loading"
              @change="chooseProduct"
              ><ElOption
                v-for="p in products"
                :key="p.id"
                :value="p.id"
                :label="p.name + (p.listed ? '' : '（未上架）')" /></ElSelect
          ></ElFormItem>
          <p v-if="product">
            商品原价 {{ money(product.priceFen) }} · {{ product.termLabel }} ·
            {{ product.servicePeriodCount }} {{ product.servicePeriodUnit }}
          </p>
        </template>
        <p v-else>
          按订单冻结表单编辑 · {{ order.productNameSnapshot }} · 版本
          {{ order.version }}
        </p>
        <p v-if="(order || product) && !schema" role="alert" class="form-error">
          表单未配置或格式不受支持，暂无法填写服务信息。
        </p>
        <ProductFormInputs
          v-if="schema"
          v-model="formData"
          :schema="schema"
          :disabled="busy || uncertain"
        />
        <ElFormItem label="最终应付金额（元）"
          ><ElInput
            v-model="amount"
            aria-label="最终应付金额（元）"
            inputmode="decimal"
            :disabled="busy || uncertain"
        /></ElFormItem>
        <ElFormItem label="价格调整原因"
          ><ElInput
            v-model="reason"
            aria-label="价格调整原因"
            maxlength="500"
            :disabled="busy || uncertain"
        /></ElFormItem>
        <ElFormItem v-if="!order" label="内部备注（仅管理员）"
          ><ElInput
            v-model="note"
            aria-label="内部备注（仅管理员）"
            type="textarea"
            maxlength="2000"
            :disabled="busy || uncertain"
        /></ElFormItem>
      </ElForm>
    </fieldset>
    <template #footer
      ><ElButton :disabled="busy || uncertain" @click="emit('close')"
        >取消</ElButton
      ><ElButton type="primary" :loading="busy" @click="save">{{
        uncertain ? '重试原请求' : order ? '保存订单' : '创建订单'
      }}</ElButton></template
    >
  </ElDialog>
</template>
