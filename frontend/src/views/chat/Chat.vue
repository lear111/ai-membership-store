<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  reactive,
  ref,
} from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../../api/client'
import {
  Headphones,
  ReceiptText,
  Mic,
  Send,
  ChevronLeft,
  Paperclip,
} from '@lucide/vue'

interface Order {
  id: string
  orderNo: string
  productNameSnapshot: string
  updatedAt?: string
}
interface Message {
  id: number
  text: string
  audioType: string | null
  fromAgent: boolean
  order: Order | null
  createdAt: string
}
interface Thread {
  id: string
  name: string
  pending: string | null
  preview: string
  unread: number
}
interface Draft {
  text: string
  order?: Order
  blob?: Blob
  url?: string
  request: string
  failure: string
}
const props = defineProps<{ agent?: boolean }>()
const route = useRoute()
const inbox = ref<Thread[]>([]),
  notices = ref<Order[]>([]),
  messages = ref<Message[]>([])
const selected = ref(props.agent ? '' : 'me'),
  mobileDetail = ref(!!route.query.order),
  pendingOnly = ref(true)
const online = ref(false),
  assigned = ref(false),
  canReply = ref(false),
  verified = ref(false),
  error = ref(''),
  unread = ref(0),
  latest = ref('')
const loadingOld = ref(false),
  hasOlder = ref(false),
  busy = ref(false),
  recording = ref(false),
  preparing = ref(false),
  picking = ref(false)
const log = ref<HTMLElement>(),
  drafts = reactive(new Map<string, Draft>())
const draft = computed(() => {
  const key = selected.value
  if (!drafts.has(key))
    drafts.set(key, { text: '', request: crypto.randomUUID(), failure: '' })
  return drafts.get(key)!
})
const filtered = computed(() =>
  inbox.value
    .filter((t) => !pendingOnly.value || t.pending)
    .sort((a, b) =>
      pendingOnly.value
        ? String(a.pending).localeCompare(String(b.pending))
        : 0,
    ),
)
const title = computed(() =>
  selected.value === 'notice'
    ? '订单通知'
    : props.agent
      ? inbox.value.find((t) => t.id === selected.value)?.name || '客服收件箱'
      : '官方客服',
)
const tab = crypto.randomUUID()
const contactHint = computed(() => {
  if (!verified.value) return '正在确认客服状态'
  if (!assigned.value) return '暂未安排客服，可以先留言'
  return online.value ? '人工客服' : '可以先留言，客服回来后会看到'
})
let mounted = true,
  polling = false,
  epoch = 0,
  timer = 0,
  beat = 0,
  recordTimer = 0,
  recorder: MediaRecorder | null = null
const threadPath = (key: string) => '/chat/thread/' + encodeURIComponent(key)
function visibleConversation() {
  return (
    !document.hidden &&
    (!matchMedia('(max-width:640px)').matches || mobileDetail.value)
  )
}
function stamp(date: string) {
  return new Date(date).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
function messageError(e: unknown) {
  return e instanceof Error ? e.message : '连接失败，请重试'
}
async function refresh() {
  if (!mounted || document.hidden || polling) return
  polling = true
  const version = epoch,
    key = selected.value
  try {
    const s = await api<{
      assigned: boolean
      isAgent: boolean
      online: boolean
    }>('/chat/status')
    if (!mounted || version !== epoch) return
    canReply.value = s.isAgent
    assigned.value = s.assigned
    online.value = s.online
    verified.value = true
    if (props.agent) {
      if (!s.isAgent) {
        inbox.value = []
        messages.value = []
        selected.value = ''
        error.value = ''
        return
      }
      const rows = await api<Thread[]>('/chat/inbox')
      if (!mounted || version !== epoch) return
      inbox.value = rows
      if (key && !rows.some((t) => t.id === key)) {
        selected.value = ''
        messages.value = []
        return
      }
    }
    if (key && key !== 'notice') {
      const page = await api<{ messages: Message[]; unread: number }>(
        threadPath(key) + '/messages',
      )
      if (!mounted || version !== epoch) return
      const last = page.messages.at(-1)
      if (!props.agent) {
        latest.value =
          last?.text ||
          (last?.audioType ? '[语音]' : last?.order ? '[订单]' : '联系人工客服')
        unread.value = page.unread
      }
      const previous = messages.value,
        nearEnd =
          !log.value ||
          log.value.scrollHeight -
            log.value.clientHeight -
            log.value.scrollTop <
            65
      const first = page.messages[0]
      if (!previous.length) hasOlder.value = page.messages.length === 60
      if (first) {
        const overlaps = previous.some((m) => m.id === first.id)
        if (!overlaps && previous.length && page.messages.length === 60)
          hasOlder.value = true
        messages.value = [
          ...(overlaps ? previous.filter((m) => m.id < first.id) : []),
          ...page.messages,
        ]
      } else messages.value = []
      if (last && last.id !== previous.at(-1)?.id && nearEnd) {
        await nextTick()
        if (log.value) log.value.scrollTop = log.value.scrollHeight
      }
      if (page.unread && last && visibleConversation()) {
        await api(threadPath(key) + '/read', 'POST', { id: last.id })
        if (mounted && version === epoch) unread.value = 0
      }
    } else if (key === 'notice' && !props.agent) {
      const result = await api<{ unread: number; messages: Message[] }>(
        '/chat/thread/me/messages',
      )
      if (mounted && version === epoch) {
        unread.value = result.unread
        latest.value = result.messages.at(-1)?.text || '联系人工客服'
      }
    }
    if (mounted && version === epoch) error.value = ''
  } catch (e) {
    if (mounted && version === epoch) {
      error.value = messageError(e)
      verified.value = false
    }
  } finally {
    polling = false
    if (mounted && epoch !== version) void refresh()
  }
}
async function older() {
  const key = selected.value,
    first = messages.value[0]
  if (!first || loadingOld.value) return
  loadingOld.value = true
  try {
    const page = await api<{ messages: Message[] }>(
      threadPath(key) + '/messages?before=' + first.id,
    )
    if (key !== selected.value || !mounted) return
    const height = log.value?.scrollHeight || 0
    messages.value = [...page.messages, ...messages.value]
    hasOlder.value = page.messages.length === 60
    await nextTick()
    if (log.value) log.value.scrollTop += log.value.scrollHeight - height
  } catch (e) {
    error.value = messageError(e)
  } finally {
    loadingOld.value = false
  }
}
function select(key: string) {
  if (recording.value || preparing.value || busy.value) return
  epoch++
  selected.value = key
  mobileDetail.value = true
  picking.value = false
  messages.value = []
  hasOlder.value = false
  void refresh()
}
async function loadOrders() {
  try {
    notices.value = await api<Order[]>('/chat/notices')
  } catch (e) {
    error.value = messageError(e)
  }
}
async function heartbeat(visible: boolean) {
  if (!props.agent || !canReply.value) return
  await fetch('/api/v1/chat/presence', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'MembershipStore',
    },
    body: JSON.stringify({ tab, visible }),
  }).catch(() => {})
}
function visibility() {
  void heartbeat(!document.hidden)
  if (!document.hidden) void refresh()
}
function away() {
  void heartbeat(false)
}
function resetVoice(d: Draft) {
  if (d.url) URL.revokeObjectURL(d.url)
  d.url = undefined
  d.blob = undefined
  d.failure = ''
  d.request = crypto.randomUUID()
}
async function record() {
  const d = draft.value
  let stream: MediaStream | undefined
  preparing.value = true
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
      throw new Error('当前浏览器不支持录音，请使用支持麦克风的浏览器。')
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (!mounted) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    const type = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ].find((t) => MediaRecorder.isTypeSupported(t))
    if (!type) throw new Error('此浏览器没有可用的录音格式')
    const rec = new MediaRecorder(stream, {
      mimeType: type,
      audioBitsPerSecond: 48000,
    })
    const parts: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data)
    }
    rec.onstop = () => {
      stream?.getTracks().forEach((t) => t.stop())
      clearTimeout(recordTimer)
      recording.value = false
      recorder = null
      if (!mounted) return
      const blob = new Blob(parts, { type: rec.mimeType })
      if (!blob.size || blob.size > 2 * 1024 * 1024) {
        d.failure = '录音为空或过大，请重新录音'
        return
      }
      resetVoice(d)
      d.blob = blob
      d.url = URL.createObjectURL(blob)
    }
    rec.start()
    recorder = rec
    recording.value = true
    d.failure = ''
    recordTimer = window.setTimeout(() => {
      if (rec.state === 'recording') rec.stop()
    }, 60_000)
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop())
    d.failure =
      e instanceof DOMException && e.name === 'NotAllowedError'
        ? '未获得麦克风权限，可以允许录音或使用文字。'
        : messageError(e)
  } finally {
    preparing.value = false
  }
}
async function send() {
  const d = draft.value,
    key = selected.value
  if (
    busy.value ||
    recording.value ||
    preparing.value ||
    (!d.text.trim() && !d.order && !d.blob)
  )
    return
  busy.value = true
  d.failure = ''
  try {
    const suffix = d.blob && d.order ? '?orderId=' + d.order.id : ''
    await api(
      threadPath(key) + '/messages' + suffix,
      'POST',
      d.blob || { text: d.text.trim(), orderId: d.order?.id },
      d.request,
    )
    if (!d.blob) d.text = ''
    resetVoice(d)
    d.order = undefined
    picking.value = false
    await refresh()
  } catch (e) {
    d.failure = messageError(e)
  } finally {
    busy.value = false
  }
}
function edited() {
  draft.value.request = crypto.randomUUID()
  draft.value.failure = ''
}
function showNotices() {
  select('notice')
  void loadOrders()
}
function attach(order?: Order) {
  draft.value.order = order
  edited()
  picking.value = false
}
function consult(order: Order) {
  select('me')
  attach(order)
}
function pickOrder() {
  picking.value = !picking.value
  if (picking.value) void loadOrders()
}
onMounted(async () => {
  if (!props.agent) {
    await loadOrders()
    const order = notices.value.find((o) => o.id === route.query.order)
    if (order) draft.value.order = order
    else if (typeof route.query.order === 'string') {
      try {
        const data = await api<{ order: Order }>(
          '/customer/orders/' + encodeURIComponent(route.query.order),
        )
        draft.value.order = data.order
      } catch (e) {
        error.value = messageError(e)
      }
    }
  }
  if (!mounted) return
  await refresh()
  if (!mounted) return
  void heartbeat(!document.hidden)
  timer = window.setInterval(() => void refresh(), 2500)
  beat = window.setInterval(() => void heartbeat(!document.hidden), 15000)
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('pagehide', away)
})
onBeforeUnmount(() => {
  mounted = false
  away()
  clearInterval(timer)
  clearInterval(beat)
  clearTimeout(recordTimer)
  if (recorder?.state === 'recording') recorder.stop()
  for (const d of drafts.values()) resetVoice(d)
  document.removeEventListener('visibilitychange', visibility)
  window.removeEventListener('pagehide', away)
})
</script>
<template>
  <section class="support-page">
    <header class="support-title">
      <h1>{{ agent ? '客服收件箱' : '消息' }}</h1>
      <RouterLink v-if="canReply && !agent" to="/support/inbox"
        >打开客服工作台 →</RouterLink
      ><RouterLink v-if="agent" to="/messages">返回我的消息</RouterLink>
    </header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="agent && verified && !canReply" class="hint">
      {{
        assigned
          ? '该账号尚未被指定为客服。'
          : '客服席位暂空。店主指派客服后，可在此接待顾客。'
      }}
    </p>
    <div v-else class="support-grid" :class="{ opened: mobileDetail }">
      <aside>
        <div class="list-head">{{ agent ? '分配给我' : '会话列表' }}</div>
        <div v-if="agent" class="filters">
          <button :aria-pressed="pendingOnly" @click="pendingOnly = true">
            待回复 {{ inbox.filter((t) => t.pending).length }}</button
          ><button :aria-pressed="!pendingOnly" @click="pendingOnly = false">
            全部
          </button>
        </div>
        <template v-if="!agent">
          <button
            class="contact"
            :class="{ active: selected === 'me' }"
            @click="select('me')"
          >
            <Headphones /><span
              ><strong
                >官方客服
                <small :class="{ on: verified && online }">{{
                  verified ? (online ? '在线' : '离线') : '连接中'
                }}</small></strong
              ><span>{{ latest || '联系人工客服' }}</span></span
            ><em>{{ unread || '置顶' }}</em>
          </button>
          <button
            class="contact"
            :class="{ active: selected === 'notice' }"
            @click="showNotices"
          >
            <ReceiptText /><span
              ><strong>订单通知</strong><span>查看最近订单</span></span
            >
          </button></template
        >
        <button
          v-for="t in agent ? filtered : []"
          :key="t.id"
          class="contact"
          :class="{ active: selected === t.id }"
          @click="select(t.id)"
        >
          <span class="avatar">{{ t.name.slice(0, 1) }}</span><span
            ><strong>{{ t.name }}</strong
            ><span>{{ t.preview }}</span></span
          ><em v-if="t.unread">{{ t.unread }}</em>
        </button>
        <p v-if="agent && !filtered.length" class="hint">
          暂无{{ pendingOnly ? '待回复' : '' }}会话
        </p>
      </aside>
      <div class="conversation">
        <header>
          <button
            class="back"
            aria-label="返回会话列表"
            :disabled="recording || preparing"
            @click="mobileDetail = false"
          >
            <ChevronLeft />
          </button>
          <div>
            <strong>{{ title }}</strong>
            <small v-if="agent && selected">{{
              inbox.find((t) => t.id === selected)?.pending
                ? '待回复'
                : '已回复'
            }}</small>
            <small
              v-if="!agent && selected === 'me'"
              :class="{ on: verified && online }"
              >{{ verified ? (online ? '在线' : '离线') : '连接中' }}</small
            >
            <p v-if="!agent && selected === 'me'">
              {{ contactHint }}
            </p>
          </div>
        </header>
        <div v-if="selected === 'notice'" class="history">
          <article v-for="o in notices" :key="o.id" class="notice">
            <ReceiptText /> <strong>{{ o.productNameSnapshot }}</strong>
            <p>订单 #{{ o.orderNo }} · {{ stamp(o.updatedAt!) }}</p>
            <RouterLink
              :to="{ path: '/messages', query: { order: o.id } }"
              @click="consult(o)"
              >就此订单咨询</RouterLink
            >
          </article>
          <p v-if="!notices.length" class="hint">还没有订单通知</p>
        </div>
        <template v-else-if="selected"
          ><div class="history" ref="log">
            <button v-if="hasOlder" :disabled="loadingOld" @click="older">
              查看更早消息
            </button>
            <p v-if="!messages.length" class="hint">
              {{
                agent ? '暂无聊天记录' : '有什么可以帮你？发消息给店铺客服。'
              }}
            </p>
            <div
              v-for="m in messages"
              :key="m.id"
              class="row"
              :class="{ mine: m.fromAgent === !!agent }"
            >
              <div class="bubble">
                <p v-if="m.text">{{ m.text }}</p>
                <audio
                  v-if="m.audioType"
                  controls
                  preload="none"
                  :src="'/api/v1' + threadPath(selected) + '/audio/' + m.id"
                ></audio>
                <details v-if="m.order">
                  <summary>订单 #{{ m.order.orderNo }}</summary>
                  {{ m.order.productNameSnapshot }}
                </details>
                <time
                  >{{ m.fromAgent === !!agent ? '已发送 · ' : ''
                  }}{{ stamp(m.createdAt) }}</time
                >
              </div>
            </div>
          </div>
          <form class="composer" @submit.prevent="send">
            <div class="tools">
              <button
                type="button"
                :disabled="busy || preparing || !!draft.blob"
                @click="recording ? recorder?.stop() : record()"
              >
                <Mic />{{
                  recording ? '结束录音' : preparing ? '等待麦克风' : '录语音'
                }}</button
              ><button
                v-if="!agent"
                type="button"
                :disabled="busy"
                @click="pickOrder"
              >
                <Paperclip />附订单
              </button>
            </div>
            <div v-if="picking">
              <button
                v-for="o in notices"
                :key="o.id"
                type="button"
                @click="attach(o)"
              >
                {{ o.productNameSnapshot }} #{{ o.orderNo }}</button
              ><span v-if="!notices.length">暂无可附订单</span>
            </div>
            <div v-if="draft.order">
              随附 #{{ draft.order.orderNo }}
              <button type="button" :disabled="busy" @click="attach()">
                移除
              </button>
            </div>
            <div v-if="draft.url" class="voice">
              <audio controls :src="draft.url"></audio
              ><button
                type="button"
                :disabled="busy"
                @click="resetVoice(draft)"
              >
                取消语音
              </button>
            </div>
            <div class="entry">
              <input
                v-if="!draft.blob"
                v-model="draft.text"
                @input="edited"
                maxlength="2000"
                aria-label="消息内容"
                placeholder="输入消息…"
                :disabled="busy || recording"
              /><button
                class="send"
                :disabled="
                  busy ||
                  preparing ||
                  recording ||
                  (!draft.blob && !draft.order && !draft.text.trim())
                "
              >
                <Send />{{
                  busy
                    ? '发送中'
                    : draft.failure
                      ? '重新发送'
                      : draft.blob
                        ? '发送语音'
                        : '发送'
                }}
              </button>
            </div>
            <p v-if="draft.failure" role="alert" class="error">
              {{ draft.failure }}
            </p>
            <p v-if="recording">录音中，最长 60 秒。结束后可试听。</p>
          </form></template
        >
        <p v-else class="hint">选择一位顾客，查看并回复消息。</p>
      </div>
    </div>
  </section>
</template>
<style scoped>
.support-page {
  max-width: 1100px;
  margin: 24px auto;
  color: #202c40;
}
.support-title,
.conversation > header,
.tools,
.entry,
.filters,
.voice {
  display: flex;
  align-items: center;
  gap: 10px;
}
.support-title {
  justify-content: space-between;
  margin: 0 0 18px;
}
.support-title h1 {
  margin: 0;
  font-size: 26px;
}
.support-grid {
  display: grid;
  grid-template-columns: minmax(210px, 29%) minmax(0, 1fr);
  border: 1px solid #dce3ed;
  border-radius: 14px;
  overflow: hidden;
  background: white;
}
.support-page button {
  font: inherit;
  cursor: pointer;
}
.support-page button:disabled {
  opacity: 0.55;
  cursor: default;
}
.list-head,
.hint {
  padding: 16px;
}
.list-head {
  font-weight: 700;
}
.support-grid aside {
  padding: 6px;
  border-right: 1px solid #e0e5ee;
}
.contact {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  width: 100%;
  background: white;
  border: 0;
  border-radius: 8px;
  text-align: left;
  color: inherit;
}
.contact.active {
  background: #ecf2ff;
}
.contact > svg {
  color: #3161bc;
}
.contact > span:not(.avatar) {
  min-width: 0;
  flex: 1;
}
.contact strong,
.contact span span {
  display: block;
}
.contact span span {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #64738a;
  font-size: 13px;
}
.contact em {
  font-size: 11px;
  color: #365a90;
}
.support-page small {
  font-size: 12px;
  font-weight: 400;
  color: #687488;
}
.support-page small.on {
  color: #127444;
}
.conversation {
  min-width: 0;
  background: #f6f8fc;
}
.conversation > header,
.composer {
  padding: 14px 18px;
  background: white;
}
.conversation > header p,
.composer p {
  font-size: 13px;
  margin: 3px 0;
}
.history {
  height: clamp(250px, 47vh, 560px);
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.row {
  display: flex;
}
.row.mine {
  justify-content: flex-end;
}
.bubble,
.notice {
  background: white;
  border: 1px solid #dce3ed;
  border-radius: 12px;
  padding: 9px 12px;
  max-width: min(87%, 520px);
  overflow-wrap: anywhere;
}
.mine .bubble {
  background: #e6eeff;
}
.bubble p {
  white-space: pre-wrap;
  margin: 0;
}
.bubble time {
  font-size: 11px;
  color: #586981;
  display: block;
  margin-top: 3px;
}
.support-page audio {
  max-width: 100%;
  width: 245px;
  height: 36px;
}
.composer,
.tools {
  border-top: 1px solid #e0e5ee;
}
.tools {
  border: 0;
  margin-bottom: 8px;
}
.composer button,
.filters button,
.back {
  background: white;
  border: 1px solid #d5dfea;
  border-radius: 7px;
  padding: 6px 9px;
  display: inline-flex;
  gap: 5px;
  align-items: center;
}
.composer svg {
  width: 16px;
  height: 16px;
}
.entry input {
  min-width: 0;
  flex: 1;
  border: 1px solid #becce1;
  border-radius: 8px;
  padding: 9px;
  font: inherit;
}
.entry .send,
.filters button[aria-pressed='true'] {
  background: #305cd4;
  color: white;
}
.back {
  display: none;
}
.filters {
  padding: 4px 8px;
}
.hint {
  color: #687488;
}
.error {
  color: #9a3035;
}
.voice {
  margin: 8px 0;
  flex-wrap: wrap;
}
@media (max-width: 640px) {
  .support-page {
    margin: 12px 0;
  }
  .support-grid {
    display: block;
  }
  .conversation,
  .opened aside {
    display: none;
  }
  .opened .conversation {
    display: block;
  }
  .back {
    display: inline-flex;
  }
  .support-grid aside {
    min-height: 46vh;
    border: 0;
  }
  .composer,
  .conversation > header {
    padding: 12px;
  }
  .support-title h1 {
    font-size: 22px;
  }
  .composer button {
    min-height: 40px;
  }
}
</style>
