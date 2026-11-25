// Public, browser-safe configuration contract. Never import environment or ORM code here.
import { z } from 'zod'
import {
  FORM_TEXT_MAX_LENGTH,
  jsonUtf8Bytes,
  MAX_SCHEMA_BYTES,
  schemaSizeMessage,
  textareaValue,
} from './form-limits.ts'

export const MAX_FIELDS = 20
export const MAX_OPTIONS = 20
const identifier = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value))
const common = {
  id: identifier,
  label: z.string().trim().min(1).max(80),
  required: z.boolean(),
  hint: z.string().max(200).default(''),
}
const options = z
  .array(
    z.strictObject({
      value: z.string().trim().min(1).max(80),
      label: z.string().trim().min(1).max(80),
    }),
  )
  .min(1)
  .max(MAX_OPTIONS)
  .superRefine((items, ctx) => {
    if (new Set(items.map((item) => item.value)).size !== items.length)
      ctx.addIssue({ code: 'custom', message: '选项值不能重复' })
  })
const dateDefault = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(value + 'T00:00:00.000Z')
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    )
  }, '日期必须是真实的 YYYY-MM-DD 日期')
  .optional()
export const formField = z.discriminatedUnion('type', [
  z.strictObject({
    ...common,
    type: z.literal('text'),
    defaultValue: z.string().max(FORM_TEXT_MAX_LENGTH.text).optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal('email'),
    defaultValue: z
      .union([z.email().max(FORM_TEXT_MAX_LENGTH.email), z.literal('')])
      .optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal('textarea'),
    defaultValue: textareaValue.optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal('number'),
    defaultValue: z
      .number()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal('date'),
    defaultValue: dateDefault,
  }),
  z.strictObject({
    ...common,
    type: z.literal('select'),
    options,
    defaultValue: z.string().max(80).optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal('radio'),
    options,
    defaultValue: z.string().max(80).optional(),
  }),
  z.strictObject({
    ...common,
    type: z.literal('checkbox'),
    options,
    defaultValue: z.array(z.string().max(80)).max(MAX_OPTIONS).optional(),
  }),
])
export const productFormSchema = z
  .strictObject({
    version: z.literal(1),
    fields: z.array(formField).max(MAX_FIELDS),
  })
  .superRefine((schema, ctx) => {
    const ids = new Set<string>()
    schema.fields.forEach((field, index) => {
      if (ids.has(field.id))
        ctx.addIssue({
          code: 'custom',
          path: ['fields', index, 'id'],
          message: '字段 ID 不能重复',
        })
      ids.add(field.id)
      if ('options' in field && field.defaultValue !== undefined) {
        const defaults = Array.isArray(field.defaultValue)
          ? field.defaultValue
          : [field.defaultValue]
        if (
          new Set(defaults).size !== defaults.length ||
          defaults.some(
            (value) => !field.options.some((option) => option.value === value),
          )
        )
          ctx.addIssue({
            code: 'custom',
            path: ['fields', index, 'defaultValue'],
            message: '默认值必须匹配不重复的现有选项',
          })
      }
    })
    if (jsonUtf8Bytes(schema) > MAX_SCHEMA_BYTES)
      ctx.addIssue({ code: 'custom', message: schemaSizeMessage })
  })
export type ProductFormSchema = z.output<typeof productFormSchema>
export type FormField = z.output<typeof formField>

export function projectCustomerForm(schema: ProductFormSchema) {
  return {
    version: schema.version,
    fields: schema.fields.map((field) => ({
      id: field.id,
      type: field.type,
      label: field.label,
      required: field.required,
      hint: field.hint,
      ...('options' in field
        ? {
            options: field.options.map(({ label, value }) => ({
              label,
              value,
            })),
          }
        : {}),
    })),
  }
}

export const emptyFormSchema = (): ProductFormSchema => ({
  version: 1,
  fields: [],
})
