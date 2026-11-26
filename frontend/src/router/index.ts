import { createRouter, createWebHistory } from 'vue-router'
import StoreLayout from '../layouts/StoreLayout.vue'
import AdminLayout from '../layouts/AdminLayout.vue'
import { auth } from '../stores/auth'
import { isPurchasePath } from './customer-redirect'

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    {
      path: '/admin/login',
      component: () => import('../views/auth/Login.vue'),
      props: { admin: true },
    },
    { path: '/login', component: () => import('../views/auth/Login.vue') },
    {
      path: '/register',
      component: () => import('../views/auth/Register.vue'),
    },
    {
      path: '/activate',
      component: () => import('../views/auth/Activate.vue'),
    },
    {
      path: '/',
      component: StoreLayout,
      children: [
        {
          path: 'messages',
          meta: { authenticated: true },
          component: () => import('../views/chat/Chat.vue'),
        },
        {
          path: 'support/inbox',
          meta: { authenticated: true },
          component: () => import('../views/chat/Chat.vue'),
          props: { agent: true },
        },
        {
          path: '',
          name: 'catalog',
          meta: { publicCatalog: true },
          component: () => import('../views/storefront/Catalog.vue'),
        },
        {
          path: 'products/:slug',
          name: 'catalog-product',
          meta: { publicCatalog: true },
          component: () => import('../views/storefront/ProductDetail.vue'),
          props: true,
        },
        {
          path: 'purchase/:slug',
          name: 'customer-purchase',
          meta: { authenticated: true, customerPurchase: true },
          component: () => import('../views/storefront/Purchase.vue'),
          props: true,
        },
        {
          path: 'subscriptions',
          meta: { authenticated: true, customerSubscriptions: true },
          component: () => import('../views/account/Subscriptions.vue'),
        },
        {
          path: 'account/orders',
          alias: '/orders',
          meta: { authenticated: true, customerOrders: true },
          component: () => import('../views/account/CustomerOrders.vue'),
        },
        {
          path: 'profile',
          meta: { authenticated: true },
          component: () => import('../views/account/Profile.vue'),
        },
      ],
    },
    {
      path: '/admin',
      meta: { admin: true },
      component: AdminLayout,
      children: [
        {
          path: 'support',
          component: () => import('../views/chat/Settings.vue'),
        },
        { path: '', component: () => import('../views/admin/Overview.vue') },
        {
          path: 'products',
          component: () => import('../views/admin/Products.vue'),
        },
        {
          path: 'orders',
          component: () => import('../views/account/Orders.vue'),
          props: { admin: true },
        },
        {
          path: 'subscriptions',
          component: () => import('../views/admin/Subscriptions.vue'),
        },
        { path: 'users', component: () => import('../views/admin/Users.vue') },
        {
          path: 'settings',
          component: () => import('../views/admin/Settings.vue'),
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
router.beforeEach(async (to) => {
  if (to.meta.customerPurchase && !isPurchasePath(to.path)) return '/'
  await auth.load(Boolean(to.meta.admin || to.meta.authenticated))
  if (to.meta.admin && auth.state.user?.role !== 'ADMIN')
    return {
      path: auth.state.user ? '/profile' : '/admin/login',
      query: auth.state.user ? {} : { redirect: to.fullPath },
    }
  if (to.meta.authenticated && !auth.state.user)
    return { path: '/login', query: { redirect: to.fullPath } }
})
window.addEventListener('membership:unauthenticated', () => {
  if (router.currentRoute.value.meta.admin)
    void router.replace({
      path: '/admin/login',
      query: { redirect: router.currentRoute.value.fullPath },
    })
  else if (router.currentRoute.value.meta.customerOrders)
    void router.replace({
      path: '/login',
      query: { redirect: '/account/orders' },
    })
  else if (router.currentRoute.value.meta.customerSubscriptions)
    void router.replace({
      path: '/login',
      query: { redirect: '/subscriptions' },
    })
  else if (router.currentRoute.value.meta.customerPurchase)
    void router.replace({
      path: '/login',
      query: { redirect: router.currentRoute.value.fullPath },
    })
})
