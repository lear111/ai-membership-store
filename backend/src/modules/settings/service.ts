import { z } from 'zod'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { transaction } from '../../db/transaction.ts'
import { ApiError } from '../../http/errors.ts'

const adminSettingsSelect = {
  id: true,
  storeName: true,
  ownerEmail: true,
  timezone: true,
  paymentInstructions: true,
  updatedAt: true,
} as const

export const timezone = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value })
      return !/^[+-]/.test(value)
    } catch {
      return false
    }
  }, '请输入有效的 IANA 时区')

export const editSettings = z
  .strictObject({
    storeName: z.string().trim().min(1).max(80).optional(),
    ownerEmail: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email().max(254))
      .optional(),
    timezone: timezone.optional(),
    paymentInstructions: z
      .string()
      .transform((value) => value.replace(/\r\n?/g, '\n'))
      .pipe(z.string().max(4000))
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0)
export function settingsService(database: PrismaClient) {
  return {
    async publicConfig() {
      const settings = await database.appSettings.findUnique({
        where: { id: 1 },
        select: { storeName: true },
      })
      if (!settings)
        throw new ApiError(503, 'SETTINGS_UNAVAILABLE', '店铺信息暂不可用')
      return { storeName: settings.storeName }
    },
    async orderGuidance() {
      const settings = await database.appSettings.findUnique({
        where: { id: 1 },
        select: { storeName: true, timezone: true, paymentInstructions: true },
      })
      const zone = timezone.safeParse(settings?.timezone)
      if (!settings || !zone.success)
        throw new ApiError(503, 'SETTINGS_UNAVAILABLE', '付款说明暂不可用')
      return {
        storeName: settings.storeName,
        businessTimezone: zone.data,
        paymentInstructions: settings.paymentInstructions,
      }
    },
    async get() {
      const settings = await database.appSettings.findUnique({
        where: { id: 1 },
        select: adminSettingsSelect,
      })
      if (!settings)
        throw new ApiError(503, 'SETTINGS_UNAVAILABLE', '系统设置尚未初始化')
      return settings
    },
    edit(
      input: z.output<typeof editSettings>,
      actorId: string,
      requestId: string,
    ) {
      return transaction(database, async (tx) => {
        const current = await tx.appSettings.findUnique({ where: { id: 1 } })
        if (!current)
          throw new ApiError(503, 'SETTINGS_UNAVAILABLE', '系统设置尚未初始化')
        const settings = await tx.appSettings.update({
          where: { id: 1 },
          data: input,
          select: adminSettingsSelect,
        })
        await tx.adminAuditLog.create({
          data: {
            actorAdminId: actorId,
            requestId,
            action: 'SETTINGS_UPDATED',
            entityType: 'AppSettings',
            entityId: '1',
            beforeJson: { timezone: current.timezone },
            afterJson: {
              fields: Object.keys(input).filter(
                (field) =>
                  field !== 'paymentInstructions' ||
                  current.paymentInstructions !== settings.paymentInstructions,
              ),
              timezone: settings.timezone,
            },
          },
        })
        return settings
      })
    },
  }
}
