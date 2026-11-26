<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../../api/client'
const email = ref(''),
  savedEmail = ref(''),
  enabled = ref(false),
  configured = ref(false),
  feedback = ref(''),
  ready = ref(false),
  busy = ref(false)
async function load() {
  try {
    const s = await api<{
      email: string
      emailEnabled: boolean
      mailConfigured: boolean
    }>('/chat/settings')
    email.value = s.email
    savedEmail.value = s.email
    enabled.value = s.emailEnabled
    configured.value = s.mailConfigured
    ready.value = true
  } catch (e) {
    feedback.value = (e as Error).message
  }
}
async function save() {
  const target = email.value.trim()
  busy.value = true
  try {
    await api('/chat/settings', 'PUT', {
      email: target || null,
      emailEnabled: Boolean(target) && enabled.value,
    })
    savedEmail.value = target
    if (!target) enabled.value = false
    feedback.value = target
      ? '已保存，待回复会话已分配给指定客服。'
      : '已保存，客服席位暂空。顾客留言会继续保留。'
  } catch (e) {
    feedback.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
onMounted(load)
</script>
<template>
  <section class="panel" style="max-width: 640px; padding: 24px">
    <h1>客服设置</h1>
    <form v-if="ready" @submit.prevent="save">
      <p>
        <strong>{{ savedEmail ? '当前客服' : '客服席位暂空' }}</strong>
        {{ savedEmail }}
      </p>
      <label
        >接收消息的账号邮箱
        <input
          v-model="email"
          type="email"
          placeholder="留空表示暂不指派"
          :disabled="busy"
        />
      </label>
      <p>
        需要接待时，填入已激活的商店账号邮箱。待回复留言和对应聊天记录会交给这位客服。
      </p>
      <label v-if="email.trim()"
        ><input
          type="checkbox"
          v-model="enabled"
          :disabled="busy || !configured"
        />
        新会话邮件提醒</label
      >
      <p v-if="email.trim() && !configured">请配置商店发件邮箱后启用提醒。</p>
      <p><button :disabled="busy">保存设置</button></p>
    </form>
    <p role="status">{{ feedback }}</p>
  </section>
</template>
