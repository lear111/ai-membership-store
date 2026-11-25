import { z } from 'zod'
import {
  FORM_TEXT_MAX_LENGTH,
  formDataSizeMessage,
  jsonUtf8Bytes,
  MAX_FORM_DATA_BYTES,
  textareaValue,
} from './form-limits.ts'
import { productFormSchema, type ProductFormSchema } from './product-form.ts'

export type FormData = Record<string, string | number | string[]>
export function formDataSchema(input: ProductFormSchema) {
  const schema = productFormSchema.parse(input)
  const fields: Record<string, z.ZodType> = {}
  for (const field of schema.fields) {
    let value: z.ZodType
    switch (field.type) {
      case 'text':
        value = z.string().max(FORM_TEXT_MAX_LENGTH.text)
        break
      case 'textarea':
        value = textareaValue
        break
      case 'email':
        value = z.email().max(FORM_TEXT_MAX_LENGTH.email)
        break
      case 'number':
        value = z
          .number()
          .min(-Number.MAX_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER)
        break
      case 'date':
        value = z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .refine((v) => {
            const date = new Date(v + 'T00:00:00.000Z')
            return (
              !Number.isNaN(date.getTime()) &&
              date.toISOString().slice(0, 10) === v
            )
          })
        break
      case 'select':
      case 'radio':
        value = z
          .string()
          .refine((v) => field.options.some((o) => o.value === v))
        break
      case 'checkbox':
        value = z
          .array(z.string())
          .max(20)
          .refine(
            (v) =>
              new Set(v).size === v.length &&
              v.every((item) => field.options.some((o) => o.value === item)),
          )
        break
    }
    if (field.required)
      value = value.refine((v) =>
        typeof v === 'string'
          ? v.trim().length > 0
          : Array.isArray(v)
            ? v.length > 0
            : true,
      )
    else value = value.optional()
    fields[field.id] = value
  }
  return z
    .strictObject(fields)
    .refine(
      (data) => jsonUtf8Bytes(data) <= MAX_FORM_DATA_BYTES,
      formDataSizeMessage,
    )
}

export function parseFormData(
  schema: ProductFormSchema,
  data: unknown,
): FormData {
  return formDataSchema(schema).parse(data) as FormData
}
