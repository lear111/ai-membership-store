<script setup lang="ts">
import { computed, onMounted, reactive, ref, toRaw } from 'vue'
import { api, type Customer, type CustomerList } from '../../api/client'
import { readProducts, type Product } from '../../api/products'
import {
  loadSubscription,
  eventLabels,
  type Subscription,
  type SubscriptionEvent,
  type PageResult,
  type FormData,
} from '../../api/subscriptions'
import ProductFormInputs from '../../components/ProductFormInputs.vue'
import { adminName } from '../../stores/user-name'
import { money, parsePrice, mask } from '../../stores/format'
import { businessInput, businessUtc } from '../../stores/business-time'
import { settings } from '../../stores/settings'

const result = ref<PageResult<Subscription>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
})
const filters = reactive({
  search: '',
  userId: '',
  productId: '',
  status: '',
  sourceType: '',
  expiry: 'ALL',
  from: '',
  to: '',
})
const page = ref(1),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  formError = ref('')
const users = ref<Customer[]>([]),
  products = ref<Product[]>([]),
  filterUsers = ref<Customer[]>([]),
  filterProducts = ref<Product[]>([]),
  chosenProduct = ref<Product>()
const mode = ref<'' | 'create' | 'detail' | 'edit' | 'renew' | 'terminate'>('')
const selected = ref<Subscription>(),
  events = ref<PageResult<SubscriptionEvent>>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
  })
const form = reactive({
  userId: '',
  productId: '',
  startedAt: '',
  expiresAt: '',
  price: '',
  note: '',
  reason: '',
  formData: {} as FormData,
})
const timezone = computed(() => settings.state.value.timezone)
const title = computed(
  () =>
    ({
      create: '新增订阅',
      detail: '订阅详情',
      edit: '编辑订阅',
      renew: '直接续订',
      terminate: '立即取消',
      '': '',
    })[mode.value],
)
const schema = computed(() =>
  mode.value === 'create'
    ? chosenProduct.value?.formSchema
    : selected.value?.formSchemaSnapshot,
)
const eligible = (s: Subscription) =>
  s.status === 'ACTIVE' && new Date(s.expiresAt).getTime() > Date.now()
const stamp = (iso: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone.value,
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(new Date(iso))
let lastRequest = '',
  lastKey = ''
function changePage(delta: number) {
  page.value += delta
  void load()
}
async function load(reset = false) {
  if (reset) page.value = 1
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({
      page: String(page.value),
      pageSize: '20',
      expiry: filters.expiry,
    })
    for (const key of [
      'search',
      'userId',
      'productId',
      'status',
      'sourceType',
    ] as const)
      if (filters[key]) query.set(key, filters[key])
    if (filters.from)
      query.set('from', businessUtc(filters.from, timezone.value))
    if (filters.to) query.set('to', businessUtc(filters.to, timezone.value))
    result.value = await api<PageResult<Subscription>>(
      '/admin/subscriptions?' + query,
    )
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
async function searchUsers(search = '', forCreation = true) {
  try {
    const items = (
      await api<CustomerList>(
        '/admin/users?' + new URLSearchParams({ search, pageSize: '100' }),
      )
    ).items
    if (forCreation) users.value = items.filter((u) => u.status !== 'DISABLED')
    else filterUsers.value = items
  } catch (e) {
    error.value = (e as Error).message
  }
}
async function searchProducts(search = '', forCreation = true) {
  try {
    const items = (
      await readProducts(
        new URLSearchParams({
          search,
          ...(forCreation ? { type: 'SUBSCRIPTION' } : {}),
          archived: forCreation ? 'ACTIVE' : 'ALL',
          pageSize: '100',
        }),
      )
    ).items
    if (forCreation) products.value = items
    else filterProducts.value = items
  } catch (e) {
    error.value = (e as Error).message
  }
}
async function choices() {
  try {
    await Promise.all([searchUsers(), searchProducts()])
  } catch (e) {
    error.value = (e as Error).message
  }
}
async function chooseProduct(id: string) {
  try {
    chosenProduct.value = (
      await api<{ product: Product }>('/admin/products/' + id)
    ).product
    form.price = String(chosenProduct.value.renewalPriceFen! / 100)
    form.formData = Object.fromEntries(
      chosenProduct.value.formSchema.fields
        .filter(
          (f) =>
            f.defaultValue !== undefined &&
            f.defaultValue !== '' &&
            (!Array.isArray(f.defaultValue) || f.defaultValue.length > 0),
        )
        .map((f) => [f.id, structuredClone(toRaw(f.defaultValue!))]),
    )
  } catch (e) {
    formError.value = (e as Error).message
  }
}
async function openCreate() {
  chosenProduct.value = undefined
  selected.value = undefined
  Object.assign(form, {
    userId: '',
    productId: '',
    startedAt: businessInput(new Date().toISOString(), timezone.value),
    expiresAt: '',
    price: '',
    note: '',
    reason: '',
    formData: {},
  })
  formError.value = ''
  lastRequest = ''
  mode.value = 'create'
  await choices()
}
async function history(eventPage = 1) {
  if (!selected.value) return
  try {
    events.value = await api<PageResult<SubscriptionEvent>>(
      '/admin/subscriptions/' + selected.value.id + '/events?page=' + eventPage,
    )
  } catch (e) {
    formError.value = (e as Error).message
  }
}
async function open(
  s: Subscription,
  action: 'detail' | 'edit' | 'renew' | 'terminate',
) {
  formError.value = ''
  busy.value = true
  try {
    selected.value = await loadSubscription(s.id)
    const current = selected.value
    Object.assign(form, {
      userId: current.userId,
      productId: current.productId,
      startedAt: businessInput(current.startedAt, timezone.value),
      expiresAt:
        action === 'renew'
          ? ''
          : businessInput(current.expiresAt, timezone.value),
      price: String(current.renewalPriceFen / 100),
      note: current.note ?? '',
      reason: '',
      formData: structuredClone(toRaw(current.formData)),
    })
    lastRequest = ''
    mode.value = action
    if (action === 'detail') {
      events.value = { items: [], total: 0, page: 1, pageSize: 20 }
      await history()
    }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function submit() {
  if (busy.value) return
  busy.value = true
  formError.value = ''
  try {
    let path = '/admin/subscriptions',
      method = 'POST',
      body: Record<string, unknown>
    if (mode.value === 'create')
      body = {
        userId: form.userId,
        productId: form.productId,
        startedAt: businessUtc(form.startedAt, timezone.value),
        expiresAt: businessUtc(form.expiresAt, timezone.value),
        renewalPriceFen: parsePrice(form.price),
        formData: form.formData,
        note: form.note || null,
      }
    else {
      if (!selected.value) throw new Error('请重新加载订阅')
      path += '/' + selected.value.id
      const common = { version: selected.value.version, reason: form.reason }
      if (mode.value === 'terminate') {
        path += '/terminate'
        body = common
      } else if (mode.value === 'renew') {
        path += '/renew'
        body = {
          ...common,
          newExpiresAt: businessUtc(form.expiresAt, timezone.value),
          renewalPriceFen: parsePrice(form.price),
        }
      } else {
        method = 'PATCH'
        const current = selected.value
        body = {
          ...common,
          ...(form.startedAt !==
          businessInput(current.startedAt, timezone.value)
            ? { startedAt: businessUtc(form.startedAt, timezone.value) }
            : {}),
          ...(form.expiresAt !==
          businessInput(current.expiresAt, timezone.value)
            ? { expiresAt: businessUtc(form.expiresAt, timezone.value) }
            : {}),
          ...(parsePrice(form.price) !== current.renewalPriceFen
            ? { renewalPriceFen: parsePrice(form.price) }
            : {}),
          ...(JSON.stringify(form.formData) !== JSON.stringify(current.formData)
            ? { formData: form.formData }
            : {}),
          ...((form.note || null) !== current.note
            ? { note: form.note || null }
            : {}),
        }
        if (Object.keys(body).length === 2)
          throw new Error('请至少修改一项订阅信息')
      }
    }
    const fingerprint = JSON.stringify({ path, method, body })
    if (lastRequest !== fingerprint) {
      lastRequest = fingerprint
      lastKey = crypto.randomUUID()
    }
    await api(path, method, body, lastKey)
    mode.value = ''
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
onMounted(async () => {
  await settings.load().catch(() => {})
  await Promise.all([load(), searchUsers('', false), searchProducts('', false)])
})
</script>
<template>
  <section>
    <div class="page-heading">
      <div>
        <span class="eyebrow">SUBSCRIPTIONS</span>
        <h1>订阅管理</h1>
      </div>
      <ElButton type="primary" :disabled="busy" @click="openCreate"
        >新增订阅</ElButton
      >
    </div>
    <p class="inline-note">
      管理员直接维护订阅，不创建订单、不记录付款、不发送邮件。日期按
      {{ timezone }} 展示和填写，到期时间需人工确认。
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div class="panel">
      <form class="toolbar subscription-filters" @submit.prevent="load(true)">
        <ElInput
          v-model="filters.search"
          aria-label="搜索订阅"
          placeholder="备注、用户名、邮箱或商品"
          clearable
        />
        <ElSelect
          v-model="filters.userId"
          aria-label="筛选客户"
          placeholder="全部客户"
          clearable
          filterable
          remote
          :remote-method="(search: string) => searchUsers(search, false)"
          ><ElOption
            v-for="u in filterUsers"
            :key="u.id"
            :value="u.id"
            :label="adminName(u) + ' · ' + mask(u.loginEmail)"
        /></ElSelect>
        <ElSelect
          v-model="filters.productId"
          aria-label="筛选订阅商品"
          placeholder="全部商品"
          clearable
          filterable
          remote
          :remote-method="(search: string) => searchProducts(search, false)"
          ><ElOption
            v-for="p in filterProducts"
            :key="p.id"
            :value="p.id"
            :label="p.name"
        /></ElSelect>
        <ElSelect
          v-model="filters.status"
          aria-label="订阅状态"
          clearable
          placeholder="全部状态"
          ><ElOption label="有效状态" value="ACTIVE" /><ElOption
            label="已终止"
            value="TERMINATED"
        /></ElSelect>
        <ElSelect
          v-model="filters.sourceType"
          aria-label="订阅来源"
          clearable
          placeholder="全部来源"
          ><ElOption label="管理员" value="ADMIN" /><ElOption
            label="系统"
            value="SYSTEM"
        /></ElSelect>
        <ElSelect v-model="filters.expiry" aria-label="到期筛选"
          ><ElOption label="全部到期时间" value="ALL" /><ElOption
            label="7 天内到期"
            value="UPCOMING" /><ElOption label="已过期" value="EXPIRED"
        /></ElSelect>
        <ElInput
          v-model="filters.from"
          type="datetime-local"
          aria-label="到期范围开始"
        /><ElInput
          v-model="filters.to"
          type="datetime-local"
          aria-label="到期范围结束"
        />
        <ElButton native-type="submit" :loading="loading">查询</ElButton>
      </form>
      <div class="table-scroll" :aria-busy="loading">
        <table>
          <thead>
            <tr>
              <th>客户 / 订阅 ID</th>
              <th>商品快照</th>
              <th>到期时间</th>
              <th>续订价格</th>
              <th>状态 / 来源</th>
              <th class="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in result.items" :key="s.id">
              <td>
                <strong>{{ adminName(s.user) }}</strong><small>{{
                  mask(s.user.loginEmail)
                }}</small
                ><small>{{ s.id }}</small>
              </td>
              <td>
                <strong>{{ s.productNameSnapshot }}</strong><small
                  >{{ s.termSnapshot
                  }}<span v-if="s.product.archivedAt">
                    · 商品已归档</span
                  ></small
                >
              </td>
              <td>{{ stamp(s.expiresAt) }}</td>
              <td>{{ money(s.renewalPriceFen) }}</td>
              <td>
                <span :class="['badge', eligible(s) ? 'green' : 'gray']">{{
                  s.status === 'TERMINATED'
                    ? '已终止'
                    : eligible(s)
                      ? '有效'
                      : '已过期'
                }}</span><small>{{
                  s.sourceType === 'ADMIN' ? '管理员' : '系统'
                }}</small>
              </td>
              <td class="align-right">
                <ElButton link type="primary" @click="open(s, 'detail')"
                  >详情</ElButton
                ><ElButton
                  v-if="eligible(s)"
                  link
                  type="primary"
                  @click="open(s, 'edit')"
                  >编辑</ElButton
                ><ElButton
                  v-if="eligible(s) && !s.product.archivedAt"
                  link
                  type="primary"
                  @click="open(s, 'renew')"
                  >直接续订</ElButton
                ><ElButton
                  v-if="s.status === 'ACTIVE'"
                  link
                  type="danger"
                  @click="open(s, 'terminate')"
                  >立即取消</ElButton
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!result.items.length && !loading" class="empty-state">
        未找到订阅
      </div>
      <div class="table-footer pagination">
        <span>本地数据库 · {{ result.total }} 条</span>
        <div>
          <ElButton :disabled="page <= 1 || loading" @click="changePage(-1)"
            >上一页</ElButton
          ><ElButton
            :disabled="page * 20 >= result.total || loading"
            @click="changePage(1)"
            >下一页</ElButton
          >
        </div>
      </div>
    </div>
    <ElDialog
      :model-value="Boolean(mode)"
      :title="title"
      width="760px"
      class="responsive-dialog"
      :close-on-click-modal="!busy"
      :show-close="!busy"
      @close="mode = ''"
    >
      <p v-if="formError" role="alert" class="form-error">{{ formError }}</p>
      <template v-if="mode === 'detail' && selected">
        <h3>{{ selected.productNameSnapshot }}</h3>
        <p class="muted">
          {{ selected.productDescriptionSnapshot || '暂无商品介绍' }}
        </p>
        <dl class="detail-grid">
          <div>
            <dt>客户</dt>
            <dd>{{ adminName(selected.user) }}</dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>{{ stamp(selected.startedAt) }}</dd>
          </div>
          <div>
            <dt>到期时间</dt>
            <dd>{{ stamp(selected.expiresAt) }}</dd>
          </div>
          <div>
            <dt>续订价格</dt>
            <dd>{{ money(selected.renewalPriceFen) }}</dd>
          </div>
          <div>
            <dt>创建时商品标价</dt>
            <dd>{{ money(selected.priceSnapshotFen) }}（非实付金额）</dd>
          </div>
          <div>
            <dt>商品类型 / 周期</dt>
            <dd>
              {{
                selected.productTypeSnapshot === 'SUBSCRIPTION'
                  ? '订阅服务'
                  : '一次性服务'
              }}
              · {{ selected.termSnapshot }}
            </dd>
          </div>
          <div>
            <dt>版本</dt>
            <dd>{{ selected.version }}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>{{ selected.sourceType }}</dd>
          </div>
        </dl>
        <p v-if="selected.product.archivedAt" class="inline-note">
          商品已归档，现有有效订阅可维护，但不可续订。
        </p>
        <p v-if="selected.status === 'TERMINATED'" class="inline-note">
          已终止 ·
          {{
            selected.terminatedAt
              ? stamp(selected.terminatedAt)
              : '历史终止记录'
          }}
          · {{ selected.terminationReason || '历史原因未记录' }}。不能恢复。
        </p>
        <ElForm label-position="top"
          ><ProductFormInputs
            :schema="selected.formSchemaSnapshot"
            :model-value="selected.formData"
            disabled
        /></ElForm>
        <p>备注：{{ selected.note || '无' }}</p>
        <h3>操作历史</h3>
        <p class="muted">
          历史保留时间、原因、版本和金额；服务信息与备注内容脱敏。
        </p>
        <ol class="subscription-history">
          <li v-for="event in events.items" :key="event.id">
            <strong>{{
              eventLabels[event.eventType] || event.eventType
            }}</strong>
            ·
            {{
              event.actorType === 'SYSTEM'
                ? '系统'
                : event.actorAdmin
                  ? adminName(event.actorAdmin)
                  : '管理员'
            }}<small
              >{{ stamp(event.createdAt) }} ·
              {{ event.reason || '创建订阅' }}</small
            ><small v-if="event.beforeJson"
              >版本 {{ event.beforeJson.version }} →
              {{ event.afterJson?.version }} · 续订价格
              {{ money(Number(event.beforeJson.renewalPriceFen)) }} →
              {{ money(Number(event.afterJson?.renewalPriceFen)) }}<br />到期
              {{
                event.beforeJson.expiresAt
                  ? stamp(String(event.beforeJson.expiresAt))
                  : '—'
              }}
              →
              {{
                event.afterJson?.expiresAt
                  ? stamp(String(event.afterJson.expiresAt))
                  : '—'
              }}</small
            >
          </li>
        </ol>
        <ElButton :disabled="events.page <= 1" @click="history(events.page - 1)"
          >上一页历史</ElButton
        ><ElButton
          :disabled="events.page * 20 >= events.total"
          @click="history(events.page + 1)"
          >下一页历史</ElButton
        >
      </template>
      <ElForm
        v-else
        label-position="top"
        :disabled="busy"
        @submit.prevent="submit"
      >
        <template v-if="mode === 'create'">
          <ElFormItem label="客户"
            ><ElSelect
              v-model="form.userId"
              aria-label="订阅客户"
              filterable
              remote
              :remote-method="searchUsers"
              placeholder="选择客户，支持待激活账户"
              ><ElOption
                v-for="u in users"
                :key="u.id"
                :value="u.id"
                :label="
                  adminName(u) +
                  (u.status === 'PENDING_ACTIVATION' ? ' · 待激活' : '')
                " /></ElSelect
          ></ElFormItem>
          <ElFormItem label="订阅商品"
            ><ElSelect
              v-model="form.productId"
              aria-label="订阅商品"
              filterable
              remote
              :remote-method="searchProducts"
              placeholder="选择未归档订阅商品"
              @change="chooseProduct"
              ><ElOption
                v-for="p in products"
                :key="p.id"
                :value="p.id"
                :label="
                  p.name + (p.listed ? ' · 已上架' : ' · 未上架')
                " /></ElSelect
          ></ElFormItem>
          <p class="muted">
            每次新增独立记录，不自动合并相同客户与商品的订阅。
          </p>
        </template>
        <p v-else-if="selected">
          <strong>{{ selected.productNameSnapshot }}</strong> ·
          {{ adminName(selected.user) }} · 版本 {{ selected.version }}
        </p>
        <p v-if="mode === 'terminate'" class="inline-note">
          立即终止当前订阅，不可恢复，也不会退款或创建付款记录。
        </p>
        <template v-else>
          <div class="form-grid">
            <ElFormItem
              v-if="mode !== 'renew'"
              :label="'开始时间（' + timezone + '）'"
              ><ElInput
                v-model="form.startedAt"
                type="datetime-local"
                aria-label="订阅开始时间"
                required /></ElFormItem
            ><ElFormItem :label="mode === 'renew' ? '新的到期时间' : '到期时间'"
              ><ElInput
                v-model="form.expiresAt"
                type="datetime-local"
                aria-label="订阅到期时间"
                required /></ElFormItem
            ><ElFormItem label="续订价格（元）"
              ><ElInput
                v-model="form.price"
                aria-label="订阅续订价格"
                inputmode="decimal"
                required
            /></ElFormItem>
          </div>
          <p v-if="mode === 'renew'" class="muted">
            直接修改当前订阅的到期时间，不自动按周期加时，不创建订单或付款记录。
          </p>
          <template v-if="mode !== 'renew'"
            ><h3>服务信息</h3>
            <p class="muted">
              按商品表单填写服务信息。
            </p>
            <ProductFormInputs
              v-if="schema"
              v-model="form.formData"
              :schema="schema" /><ElFormItem label="内部备注"
              ><ElInput
                v-model="form.note"
                type="textarea"
                maxlength="2000"
                aria-label="订阅备注" /></ElFormItem
          ></template>
        </template>
        <ElFormItem v-if="mode !== 'create'" label="操作原因"
          ><ElInput
            v-model="form.reason"
            aria-label="订阅操作原因"
            maxlength="500"
            placeholder="请勿填写敏感内容"
            required
        /></ElFormItem>
        <ElButton
          native-type="submit"
          :type="mode === 'terminate' ? 'danger' : 'primary'"
          :loading="busy"
          >{{
            mode === 'terminate'
              ? '确认立即取消'
              : mode === 'renew'
                ? '确认直接续订'
                : '保存订阅'
          }}</ElButton
        >
      </ElForm>
    </ElDialog>
  </section>
</template>
