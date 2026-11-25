import { Buffer } from 'node:buffer'

export const longTextarea = 'A中🙂\n'.repeat(2_000)
export const jsonBytes = (value: object) =>
  Buffer.byteLength(JSON.stringify(value))

const sample = {
  note: longTextarea,
  context: '中'.repeat(10_000),
  extra: '中'.repeat(5_000),
}

export const longTextFields = (['note', 'context', 'extra'] as const).map(
  (id) => ({
    id,
    type: 'textarea' as const,
    label: id,
    hint: '',
    required: false,
  }),
)

export function formDataAtLimit() {
  return {
    ...sample,
    extra: sample.extra + 'x'.repeat(65_536 - jsonBytes(sample)),
  }
}

export function formSchemaAtLimit() {
  const fields = longTextFields.map((field) => ({
    ...field,
    defaultValue: sample[field.id],
  }))
  const schema = { version: 1 as const, fields }
  fields[2]!.defaultValue += 'x'.repeat(65_536 - jsonBytes(schema))
  return schema
}
