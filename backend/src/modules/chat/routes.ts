import express, { Router } from 'express'
import { z } from 'zod'
import type { PrismaClient, Prisma } from '../../generated/prisma/client.ts'
import { ApiError } from '../../http/errors.ts'
import { rateLimit } from '../../http/security.ts'

const missing = () => new ApiError(404, 'NOT_FOUND', '会话或订单不存在')
const forbidden = () => new ApiError(403, 'FORBIDDEN', '当前账号没有客服权限')
const orderFields = {
  id: true,
  orderNo: true,
  productNameSnapshot: true,
  hidden: true,
}
const fields = {
  id: true,
  fromAgent: true,
  text: true,
  createdAt: true,
  audioType: true,
  order: { select: orderFields },
}
const leases = new Map<string, { user: string; expires: number }>()
const cleanPresence = () => {
  for (const [tab, lease] of leases)
    if (lease.expires <= Date.now()) leases.delete(tab)
}
async function lock(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT id FROM SupportSettings WHERE id = 1 FOR UPDATE`
}
function voiceType(bytes: Buffer) {
  if (
    bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) &&
    bytes.subarray(0, 512).includes(Buffer.from('webm'))
  )
    return 'audio/webm'
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4'
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  throw new ApiError(422, 'AUDIO_FORMAT', '不支持此录音格式')
}
export function supportRoutes(db: PrismaClient) {
  const router = Router()
  const config = () =>
    db.supportSettings.findUniqueOrThrow({
      where: { id: 1 },
      include: { agent: { select: { status: true, loginEmail: true } } },
    })
  router.get('/status', async (_req, res) => {
    const setting = await config()
    cleanPresence()
    res.json({
      assigned: setting.agent?.status === 'ACTIVE',
      online:
        setting.agent?.status === 'ACTIVE' &&
        [...leases.values()].some((l) => l.user === setting.agentId),
      isAgent: setting.agentId === res.locals.principal.user.id,
    })
  })
  router.post('/presence', async (req, res) => {
    const data = z
      .object({ tab: z.uuid(), visible: z.boolean() })
      .parse(req.body)
    const user = res.locals.principal.user.id
    if ((await config()).agentId !== user) throw forbidden()
    cleanPresence()
    const key = user + ':' + data.tab
    if (data.visible) leases.set(key, { user, expires: Date.now() + 45_000 })
    else leases.delete(key)
    res.sendStatus(204)
  })
  router.use('/settings', (_req, res, next) => {
    if (res.locals.principal.user.role !== 'ADMIN') throw forbidden()
    next()
  })
  router.get('/settings', async (_req, res) => {
    const s = await config()
    res.json({
      email: s.agent?.loginEmail || '',
      emailEnabled: s.emailEnabled,
      mailConfigured: Boolean(
        process.env.SUPPORT_SMTP_URL && process.env.SUPPORT_MAIL_FROM,
      ),
    })
  })
  router.put('/settings', async (req, res) => {
    const data = z
      .object({
        email: z
          .email()
          .transform((s) => s.toLowerCase())
          .nullable(),
        emailEnabled: z.boolean(),
      })
      .parse(req.body)
    const emailEnabled = data.email !== null && data.emailEnabled
    if (
      emailEnabled &&
      !(process.env.SUPPORT_SMTP_URL && process.env.SUPPORT_MAIL_FROM)
    )
      throw new ApiError(422, 'MAIL_UNAVAILABLE', '请先配置客服邮件服务')
    const assignment = await db.$transaction(async (tx) => {
      await lock(tx)
      const agent = data.email
        ? await tx.user.findFirst({
            where: { loginEmail: data.email, status: 'ACTIVE' },
            select: { id: true },
          })
        : null
      if (data.email && !agent)
        throw new ApiError(422, 'ACCOUNT_MISSING', '请输入已激活账号的登录邮箱')
      const agentId = agent?.id ?? null
      const previous = await tx.supportSettings.findUniqueOrThrow({
        where: { id: 1 },
      })
      await tx.supportSettings.update({
        where: { id: 1 },
        data: { agentId, emailEnabled },
      })
      await tx.adminAuditLog.create({
        data: {
          actorAdminId: res.locals.principal.user.id,
          action: 'SUPPORT_SETTINGS_UPDATED',
          entityType: 'SupportSettings',
          entityId: '1',
          requestId: res.locals.requestId,
          beforeJson: {
            agentId: previous.agentId,
            emailEnabled: previous.emailEnabled,
          },
          afterJson: { agentId, emailEnabled },
        },
      })
      if (previous.agentId !== agentId) {
        await tx.supportThread.updateMany({
          where: { pendingAt: { not: null } },
          data: { agentId },
        })
      }
      if (previous.agentId !== agentId || !emailEnabled)
        await tx.supportReminder.deleteMany({ where: { deliveredAt: null } })
      if (agentId && emailEnabled && previous.agentId !== agentId) {
        const pending = await tx.supportThread.findFirst({
          where: { agentId, pendingAt: { not: null } },
        })
        if (pending)
          await tx.supportReminder.create({
            data: { customerId: pending.customerId, agentId },
          })
      }
      return { previous: previous.agentId, current: agentId }
    })
    if (assignment.previous !== assignment.current)
      for (const [tab, lease] of leases)
        if (lease.user === assignment.previous) leases.delete(tab)
    res.sendStatus(204)
  })
  router.get('/notices', async (_req, res) => {
    res.json(
      await db.order.findMany({
        where: { userId: res.locals.principal.user.id, hidden: false },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          orderNo: true,
          productNameSnapshot: true,
          updatedAt: true,
        },
      }),
    )
  })
  router.get('/inbox', async (_req, res) => {
    const user = res.locals.principal.user.id
    if ((await config()).agentId !== user) throw forbidden()
    const rows = await db.supportThread.findMany({
      where: { agentId: user },
      include: {
        customer: { select: { username: true, loginEmail: true } },
        messages: {
          orderBy: { id: 'desc' },
          take: 1,
          select: { text: true, audioType: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    })
    res.json(
      await Promise.all(
        rows.map(async (t) => ({
          id: t.customerId,
          name:
            t.customer.username ||
            t.customer.loginEmail?.split('@')[0] ||
            '顾客',
          pending: t.pendingAt,
          preview: t.messages[0]?.audioType
            ? '[语音]'
            : t.messages[0]?.text || '[订单]',
          unread: await db.supportMessage.count({
            where: {
              customerId: t.customerId,
              fromAgent: false,
              id: { gt: t.agentRead },
            },
          }),
        })),
      ),
    )
  })
  router.use('/thread/:key', async (req, res, next) => {
    const key = z.union([z.literal('me'), z.uuid()]).parse(req.params.key)
    const agent = key !== 'me'
    const user = res.locals.principal.user.id
    const customer = agent ? key : user
    const thread = await db.supportThread.findUnique({
      where: { customerId: customer },
    })
    if (
      agent &&
      ((await config()).agentId !== user || thread?.agentId !== user)
    )
      throw missing()
    Object.assign(res.locals, { agent, customer })
    next()
  })
  router.get('/thread/:key/messages', async (req, res) => {
    const { customer, agent } = res.locals
    const before = z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .parse(req.query.before)
    const thread = await db.supportThread.findUnique({
      where: { customerId: customer },
    })
    const messages = await db.supportMessage.findMany({
      where: {
        customerId: customer,
        ...(before ? { id: { lt: before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: 60,
      select: fields,
    })
    const unread = thread
      ? await db.supportMessage.count({
          where: {
            customerId: customer,
            fromAgent: !agent,
            id: { gt: agent ? thread.agentRead : thread.customerRead },
          },
        })
      : 0
    res.json({
      pending: !!thread?.pendingAt,
      unread,
      messages: messages
        .reverse()
        .map((m) => ({ ...m, order: m.order?.hidden ? null : m.order })),
    })
  })
  router.post('/thread/:key/read', async (req, res) => {
    const id = z.number().int().positive().parse(req.body.id)
    const { customer, agent } = res.locals
    const col = agent ? 'agentRead' : 'customerRead'
    if (
      await db.supportMessage.findFirst({
        where: { customerId: customer, id },
        select: { id: true },
      })
    )
      await db.supportThread.updateMany({
        where: {
          customerId: customer,
          ...(agent ? { agentId: res.locals.principal.user.id } : {}),
          [col]: { lt: id },
        },
        data: { [col]: id },
      })
    res.sendStatus(204)
  })
  router.get('/thread/:key/audio/:id', async (req, res) => {
    const m = await db.supportMessage.findFirst({
      where: {
        id: z.coerce.number().int().positive().parse(req.params.id),
        customerId: res.locals.customer,
      },
      select: { audio: true, audioType: true },
    })
    if (!m?.audio || !m.audioType) throw missing()
    res
      .set('Content-Security-Policy', "default-src 'none'; sandbox")
      .type(m.audioType)
      .send(Buffer.from(m.audio))
  })
  router.post(
    '/thread/:key/messages',
    rateLimit(120, 60_000),
    express.raw({ type: 'application/octet-stream', limit: '2mb' }),
    async (req, res) => {
      const requestId = z.uuid().parse(req.get('Idempotency-Key'))
      const audio = Buffer.isBuffer(req.body) ? req.body : null
      const audioType = audio ? voiceType(audio) : null
      const body = audio
        ? { text: '', orderId: z.uuid().optional().parse(req.query.orderId) }
        : z
            .object({
              text: z.string().trim().max(2000),
              orderId: z.uuid().optional(),
            })
            .parse(req.body)
      if (!audio && !body.text && !body.orderId)
        throw new ApiError(422, 'EMPTY', '请输入消息')
      const { customer, agent } = res.locals
      const senderId = res.locals.principal.user.id as string
      await db.$transaction(async (tx) => {
        await lock(tx)
        const settings = await tx.supportSettings.findUniqueOrThrow({
          where: { id: 1 },
        })
        const thread = await tx.supportThread.findUnique({
          where: { customerId: customer },
        })
        if (
          agent &&
          (settings.agentId !== senderId || thread?.agentId !== senderId)
        )
          throw missing()
        const existing = await tx.supportMessage.findUnique({
          where: { senderId_requestId: { senderId, requestId } },
          select: { customerId: true, fromAgent: true },
        })
        if (existing) {
          if (existing.customerId !== customer || existing.fromAgent !== agent)
            throw new ApiError(409, 'DUPLICATE', '发送标识冲突')
          return
        }
        if (
          body.orderId &&
          (agent ||
            !(await tx.order.findFirst({
              where: { id: body.orderId, userId: customer, hidden: false },
              select: { id: true },
            })))
        )
          throw missing()
        const pendingAt = agent ? null : thread?.pendingAt || new Date()
        const assign = { agentId: settings.agentId, pendingAt }
        await tx.supportThread.upsert({
          where: { customerId: customer },
          create: { customerId: customer, ...assign },
          update: assign,
        })
        await tx.supportMessage.create({
          data: {
            customerId: customer,
            senderId,
            requestId,
            fromAgent: agent,
            text: body.text,
            orderId: body.orderId,
            audioType,
            ...(audio ? { audio: new Uint8Array(audio) } : {}),
          },
        })
        if (agent)
          await tx.supportReminder.deleteMany({
            where: { customerId: customer, deliveredAt: null },
          })
        if (
          !agent &&
          !thread?.pendingAt &&
          settings.agentId &&
          settings.emailEnabled
        )
          await tx.supportReminder.create({
            data: { customerId: customer, agentId: settings.agentId },
          })
      })
      res.sendStatus(204)
    },
  )
  return router
}
