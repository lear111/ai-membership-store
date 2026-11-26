<script setup lang="ts">
import {
  LayoutDashboard,
  Package,
  ReceiptText,
  CalendarDays,
  UsersRound,
  Settings2,
  ArrowUpRight,
  FlaskConical,
} from '@lucide/vue'
import Brand from '../components/Brand.vue'
import { computed, onMounted, ref } from 'vue'
import { settings } from '../stores/settings'
import { useRoute, useRouter } from 'vue-router'
import { auth } from '../stores/auth'
const route = useRoute()
const router = useRouter()
const logoutError = ref('')
const persistentPage = computed(() =>
  [
    '/admin/orders',
    '/admin/users',
    '/admin/products',
    '/admin/settings',
    '/admin/support',
    '/admin/subscriptions',
  ].includes(route.path),
)
onMounted(() => {
  void settings.load().catch(() => {})
})
async function logout() {
  try {
    await auth.logout()
    await router.replace('/admin/login')
  } catch {
    logoutError.value = '退出失败，请检查本地 API 后重试'
  }
}
const nav = [
  { path: '/admin', text: '经营概览', icon: LayoutDashboard },
  { path: '/admin/products', text: '商品管理', icon: Package },
  { path: '/admin/orders', text: '订单管理', icon: ReceiptText },
  { path: '/admin/subscriptions', text: '订阅管理', icon: CalendarDays },
  { path: '/admin/users', text: '用户管理', icon: UsersRound },
  { path: '/admin/settings', text: '系统设置', icon: Settings2 },
  { path: '/admin/support', text: '客服设置', icon: UsersRound },
]
</script>
<template>
  <div class="admin-shell">
    <header class="topbar admin-topbar">
      <div class="admin-brand">
        <Brand /><span class="console-label">管理控制台</span>
      </div>
      <div class="header-actions">
        <RouterLink class="console-link" to="/"
          >返回商店 <ArrowUpRight :size="14" /></RouterLink
        ><span class="owner-email">{{ auth.state.user?.loginEmail }}</span
        ><ElButton link @click="logout">退出登录</ElButton
        ><span class="avatar owner">管</span>
      </div>
    </header>
    <aside class="admin-sidebar">
      <span class="sidebar-caption">工作空间</span>
      <nav aria-label="管理导航">
        <RouterLink
          v-for="item in nav"
          :key="item.path"
          :to="item.path"
          exact-active-class="active"
          ><component :is="item.icon" :size="19" /><span>{{
            item.text
          }}</span></RouterLink
        >
      </nav>
      <div class="sidebar-bottom">
        <span class="online-dot"></span> 本地运行环境
        <small>阶段 2 · 仅限本机</small>
      </div>
    </aside>
    <main class="admin-main">
      <div class="demo-notice">
        <FlaskConical :size="15" /><span>{{
          persistentPage
            ? '当前页面保存至本地数据库 · 不发送邮件'
            : '经营概览仍为 Mock 演示'
        }}</span
        ><span class="demo-pill">{{ persistentPage ? 'LOCAL' : 'MOCK' }}</span>
      </div>
      <p v-if="logoutError" class="form-error" role="alert">
        {{ logoutError }}
      </p>
      <RouterView />
      <footer class="page-footer">
        统一管理控制台 <span>·</span> 仅限本机访问
      </footer>
    </main>
  </div>
</template>
