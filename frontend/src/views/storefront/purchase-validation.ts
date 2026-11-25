import {
  formDataSchema,
  type FormData,
} from '../../../../backend/src/contracts/form-data'
import type { ProductFormSchema } from '../../../../backend/src/contracts/product-form'
import {
  formDataSizeMessage,
  textareaLengthMessage,
} from '../../../../backend/src/contracts/form-limits'
import { hasCredentialValues } from '../../../../backend/src/contracts/credential-fields'

const invalid = {
  text: '请输入不超过 500 个字符的文本',
  textarea: textareaLengthMessage,
  email: '请输入有效的邮箱地址',
  number: '请输入有效范围内的数字',
  date: '请输入有效的日期',
  select: '请选择提供的选项',
  radio: '请选择提供的选项',
  checkbox: '请选择提供的选项，每项只能选一次',
}

export function purchaseErrors(schema: ProductFormSchema, values: FormData) {
  const result = formDataSchema(schema).safeParse(values)
  const issues = result.success ? [] : result.error.issues
  const invalidIds = new Set(issues.map((issue) => issue.path[0]))
  const errors = schema.fields.flatMap((field) => {
    const value = values[field.id]
    const empty =
      value === undefined ||
      (typeof value === 'string' && !value.trim()) ||
      (Array.isArray(value) && !value.length)
    if (hasCredentialValues(value)) return [field.label + ' · 不得填写认证凭证']
    if (!invalidIds.has(field.id)) return []
    return [
      field.label +
        ' · ' +
        (field.required && empty ? '请填写必填项' : invalid[field.type]),
    ]
  })
  if (issues.some((issue) => issue.code === 'unrecognized_keys'))
    errors.push('表单包含未知字段')
  if (
    issues.some(
      (issue) => !issue.path.length && issue.message === formDataSizeMessage,
    )
  )
    errors.push(formDataSizeMessage)
  return errors
}
