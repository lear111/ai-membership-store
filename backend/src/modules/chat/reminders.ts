import nodemailer from 'nodemailer'
import type { PrismaClient } from '../../generated/prisma/client.ts'

export function startSupportReminders(db: PrismaClient, appUrl: string) {
  const url = process.env.SUPPORT_SMTP_URL
  const from = process.env.SUPPORT_MAIL_FROM
  if (!url || !from) return async () => {}
  const host = new URL(url)
  if (
    host.protocol === 'smtp:' &&
    !['127.0.0.1', 'localhost'].includes(host.hostname)
  )
    host.searchParams.set('requireTLS', 'true')
  const mail = nodemailer.createTransport(host.href, { from })
  let active: Promise<void> | undefined
  async function deliver() {
    const now = new Date()
    const job = await db.supportReminder.findFirst({
      where: { deliveredAt: null, nextAttempt: { lte: now } },
      orderBy: { id: 'asc' },
    })
    if (!job) return
    const claim = await db.supportReminder.updateMany({
      where: { id: job.id, nextAttempt: job.nextAttempt, deliveredAt: null },
      data: {
        attempts: { increment: 1 },
        nextAttempt: new Date(Date.now() + 600000),
      },
    })
    if (!claim.count) return
    const settings = await db.supportSettings.findUnique({
      where: { id: 1 },
      include: { agent: true },
    })
    const pending = await db.supportThread.findFirst({
      where: {
        customerId: job.customerId,
        agentId: job.agentId,
        pendingAt: { not: null },
      },
    })
    const to = settings?.agent?.loginEmail
    if (
      !to ||
      !pending ||
      settings.agentId !== job.agentId ||
      !settings.emailEnabled ||
      settings.agent?.status !== 'ACTIVE'
    ) {
      await db.supportReminder.deleteMany({ where: { id: job.id } })
      return
    }
    try {
      await mail.sendMail({
        from,
        to,
        subject: '商店客服有待回复会话',
        text: '请登录客服收件箱查看：' + appUrl + '/support/inbox',
        messageId: '<support-' + job.id + '@' + new URL(appUrl).hostname + '>',
      })
      await db.supportReminder.updateMany({
        where: { id: job.id },
        data: { deliveredAt: new Date() },
      })
    } catch {
      await db.supportReminder.updateMany({
        where: { id: job.id },
        data: {
          nextAttempt: new Date(
            Date.now() +
              Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7)),
          ),
        },
      })
    }
  }
  const timer = setInterval(() => {
    if (!active)
      active = deliver()
        .catch(() => {})
        .finally(() => {
          active = undefined
        })
  }, 5000)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await active
    mail.close()
  }
}
