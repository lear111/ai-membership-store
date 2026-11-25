import { z, ZodError } from 'zod'

export const FORM_TEXT_MAX_LENGTH = { text: 500, email: 254, textarea: 10_000 }
export const MAX_SCHEMA_BYTES = 64 * 1024
export const MAX_FORM_DATA_BYTES = 64 * 1024

export const schemaSizeMessage = '表单配置不能超过 64 KiB（UTF-8 字节）'
export const formDataSizeMessage = '填写信息不能超过 64 KiB（UTF-8 字节）'
export const textareaLengthMessage = '请输入不超过 10,000 个字符的文本'

// Zod's string max may count code points. Match the browser's UTF-16 maxlength.
export const textareaValue = z
  .string()
  .refine(
    (value) => value.length <= FORM_TEXT_MAX_LENGTH.textarea,
    textareaLengthMessage,
  )

export function jsonUtf8Bytes(value: object) {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

// Return only fixed messages from the form contracts, never input or raw issues.
export function formLimitErrorMessage(error: unknown) {
  if (!(error instanceof ZodError)) return undefined
  return error.issues.find(
    (issue) =>
      issue.code === 'custom' &&
      (issue.message === schemaSizeMessage ||
        issue.message === formDataSizeMessage ||
        issue.message === textareaLengthMessage),
  )?.message
}
