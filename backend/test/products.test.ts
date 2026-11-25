import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  productFormSchema,
  MAX_FIELDS,
  type FormField,
} from '../src/contracts/product-form.ts'
import {
  createProduct,
  editProduct,
  completeProduct,
} from '../src/modules/products/schemas.ts'
import { formDataSchema } from '../src/contracts/form-data.ts'
import {
  formDataAtLimit,
  formSchemaAtLimit,
  jsonBytes,
  longTextarea,
  longTextFields,
} from './long-text-fixture.ts'
import { editSettings } from '../src/modules/settings/service.ts'

const base = { label: '联系信息', required: false, hint: '仅限非敏感信息' }
export const allFields: FormField[] = [
  { ...base, id: 'f_text', type: 'text', defaultValue: '项目 A' },
  {
    ...base,
    id: 'f_email',
    type: 'email',
    defaultValue: 'fixture@example.com',
  },
  { ...base, id: 'f_area', type: 'textarea', defaultValue: '第一行\n第二行' },
  {
    ...base,
    id: 'f_select',
    type: 'select',
    options: [{ label: '方案 A', value: 'a' }],
    defaultValue: 'a',
  },
  {
    ...base,
    id: 'f_radio',
    type: 'radio',
    options: [{ label: '方案 B', value: 'b' }],
    defaultValue: 'b',
  },
  {
    ...base,
    id: 'f_check',
    type: 'checkbox',
    options: [{ label: '项目 C', value: 'c' }],
    defaultValue: ['c'],
  },
  { ...base, id: 'f_number', type: 'number', defaultValue: 1.5 },
  { ...base, id: 'f_date', type: 'date', defaultValue: '2028-02-29' },
]
const schema = (fields: unknown[]) => ({ version: 1, fields })
test('form configuration supports all eight types and stable IDs/defaults after reordering', () => {
  const parsed = productFormSchema.parse(schema(allFields))
  assert.equal(parsed.fields.length, 8)
  const reordered = productFormSchema.parse(schema([...allFields].reverse()))
  assert.deepEqual(
    reordered.fields.map((field) => field.id),
    [...allFields].reverse().map((field) => field.id),
  )
  assert.deepEqual(parsed.fields[5]!.defaultValue, ['c'])
  assert.deepEqual(productFormSchema.parse(schema([])), schema([]))
})
test('form configuration rejects duplicate/prototype IDs, unknown fields, executable types and excessive fields', () => {
  for (const input of [
    schema([allFields[0], allFields[0]]),
    schema([{ ...allFields[0], id: 'constructor' }]),
    schema([{ ...allFields[0], type: 'html' }]),
    schema([{ ...allFields[0], script: 'alert(1)' }]),
    schema([{ ...allFields[0], onChange: 'fetch("/")' }]),
    schema(
      Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ({
        ...allFields[0],
        id: 'field_' + i,
      })),
    ),
    { version: 2, fields: [] },
  ])
    assert.equal(productFormSchema.safeParse(input).success, false)
})
test('choice options and defaults must be unique, bounded and type-correct', () => {
  for (const field of [
    { ...allFields[3], options: [] },
    {
      ...allFields[3],
      options: [
        { label: 'A', value: 'x' },
        { label: 'B', value: 'x' },
      ],
    },
    { ...allFields[3], options: [{ label: '', value: 'a' }] },
    { ...allFields[3], options: [{ label: 'A', value: '' }] },
    {
      ...allFields[3],
      options: Array.from({ length: 21 }, (_, i) => ({
        label: 'A',
        value: String(i),
      })),
    },
    { ...allFields[3], defaultValue: 'unknown' },
    { ...allFields[4], defaultValue: ['b'] },
    { ...allFields[5], defaultValue: ['c', 'c'] },
    { ...allFields[5], defaultValue: 'c' },
    { ...allFields[0], options: [{ label: 'A', value: 'a' }] },
  ])
    assert.equal(productFormSchema.safeParse(schema([field])).success, false)
})
test('defaults reject invalid emails, calendar dates, nonnumeric numbers', () => {
  for (const field of [
    { ...allFields[1], defaultValue: 'invalid' },
    { ...allFields[6], defaultValue: '1+1' },
    { ...allFields[6], defaultValue: Infinity },
    { ...allFields[7], defaultValue: '2026-02-29' },
    { ...allFields[7], defaultValue: '2026-13-01' },
    { ...allFields[7], defaultValue: 'new Date()' },
  ])
    assert.equal(productFormSchema.safeParse(schema([field])).success, false)
  // Markup is inert text: renderers must interpolate, never v-html/eval it.
  assert.equal(
    productFormSchema.parse(
      schema([{ ...allFields[0], label: '<b>literal</b>' }]),
    ).fields[0]!.label,
    '<b>literal</b>',
  )
})
test('textarea defaults and submitted values count UTF-16 units consistently', () => {
  const field = longTextFields[0]!
  const input = formDataSchema(productFormSchema.parse(schema([field])))
  for (const value of [
    'a'.repeat(10_000),
    '中'.repeat(10_000),
    '🙂'.repeat(5_000),
    longTextarea,
  ]) {
    assert.equal(value.length, 10_000)
    assert.equal(
      productFormSchema.parse(schema([{ ...field, defaultValue: value }]))
        .fields[0]!.defaultValue,
      value,
    )
    assert.equal(input.parse({ note: value }).note, value)
    assert.equal(
      productFormSchema.safeParse(
        schema([{ ...field, defaultValue: value + 'x' }]),
      ).success,
      false,
    )
    assert.equal(input.safeParse({ note: value + 'x' }).success, false)
  }
})

test('single-line and email defaults and answers retain their own length limits', () => {
  const emailDomain =
    'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(61)
  for (const [type, value, tooLong] of [
    ['text', '中'.repeat(500), '中'.repeat(501)],
    [
      'email',
      'a'.repeat(64) + '@' + emailDomain,
      'a'.repeat(64) + '@' + emailDomain + 'd',
    ],
  ]) {
    const field = { ...base, id: 'field', type }
    const config = productFormSchema.parse(
      schema([{ ...field, defaultValue: value }]),
    )
    assert.equal(formDataSchema(config).parse({ field: value }).field, value)
    assert.equal(
      productFormSchema.safeParse(schema([{ ...field, defaultValue: tooLong }]))
        .success,
      false,
    )
    assert.equal(
      formDataSchema(config).safeParse({ field: tooLong }).success,
      false,
    )
  }
})

test('schema and form data independently accept exactly 64 KiB of serialized UTF-8', () => {
  const configuration = formSchemaAtLimit()
  assert.equal(jsonBytes(configuration), 65_536)
  assert.deepEqual(productFormSchema.parse(configuration), configuration)
  configuration.fields[2]!.defaultValue += 'x'
  assert.equal(jsonBytes(configuration), 65_537)
  assert.throws(
    () => productFormSchema.parse(configuration),
    /表单配置不能超过 64 KiB/,
  )

  const data = formDataAtLimit()
  const form = formDataSchema(productFormSchema.parse(schema(longTextFields)))
  assert.equal(jsonBytes(data), 65_536)
  assert.deepEqual(form.parse(data), data)
  data.extra += 'x'
  assert.equal(jsonBytes(data), 65_537)
  assert.throws(() => form.parse(data), /填写信息不能超过 64 KiB/)
  assert.throws(
    () => form.parse({ ...data, unknown: 'no' }),
    /unrecognized_keys/,
  )
})

test('product requests validate integer fen, type constraints, unknown properties and defaults', () => {
  const valid = {
    name: '服务',
    type: 'SUBSCRIPTION',
    priceFen: 100,
    renewalPriceFen: 50,
    termLabel: '按供应商确认',
    servicePeriodUnit: 'MONTH',
    servicePeriodCount: 1,
  }
  const parsed = createProduct.parse(valid)
  assert.equal(parsed.listed, false)
  assert.equal(parsed.sortOrder, 0)
  assert.deepEqual(parsed.formSchema, schema([]))
  for (const change of [
    { priceFen: 0.5 },
    { priceFen: -1 },
    { priceFen: 2147483648 },
    { priceFen: '100' },
    { type: 'INVALID' },
    { renewalPriceFen: null },
    { supplierCost: 1 },
    { password: 'no' },
    {
      formSchema: {
        version: 1,
        fields: [{ ...allFields[0], id: 'invalid id' }],
      },
    },
  ])
    assert.equal(
      createProduct.safeParse({ ...valid, ...change }).success,
      false,
    )
  assert.equal(
    createProduct.safeParse({
      ...valid,
      type: 'ONE_TIME',
      renewalPriceFen: null,
      servicePeriodUnit: null,
      servicePeriodCount: null,
    }).success,
    true,
  )
  assert.equal(
    createProduct.safeParse({
      ...valid,
      type: 'ONE_TIME',
      renewalPriceFen: null,
      renewalEnabled: true,
    }).success,
    false,
  )
  assert.equal(editProduct.safeParse({}).success, false)
  assert.equal(editProduct.safeParse({ archivedAt: null }).success, false)
  for (const field of ['purchaseEnabled', 'renewalEnabled'])
    for (const value of [false, true]) {
      assert.equal(
        createProduct.safeParse({ ...valid, [field]: value }).success,
        false,
      )
      assert.equal(editProduct.safeParse({ [field]: value }).success, false)
    }
  assert.equal(
    completeProduct.safeParse({ ...parsed, type: 'ONE_TIME' }).success,
    false,
  )
})
test('structured subscription periods require an explicit unit and positive integer count', () => {
  const base = {
    name: 'Period fixture',
    type: 'SUBSCRIPTION',
    priceFen: 100,
    renewalPriceFen: 99,
    termLabel: '展示说明不是实际周期',
  }
  for (const [servicePeriodUnit, servicePeriodCount] of [
    ['DAY', 7],
    ['MONTH', 1],
    ['MONTH', 12],
    ['YEAR', 1],
  ]) {
    const parsed = createProduct.parse({
      ...base,
      servicePeriodUnit,
      servicePeriodCount,
    })
    assert.equal(parsed.servicePeriodUnit, servicePeriodUnit)
    assert.equal(parsed.servicePeriodCount, servicePeriodCount)
    assert.equal(parsed.termLabel, base.termLabel)
  }
  for (const fields of [
    {},
    { servicePeriodUnit: 'DAY' },
    { servicePeriodCount: 7 },
    { servicePeriodUnit: null, servicePeriodCount: null },
    ...[0, -1, 0.5, 2147483648, '1', true, null].map((servicePeriodCount) => ({
      servicePeriodUnit: 'MONTH',
      servicePeriodCount,
    })),
    { servicePeriodUnit: 'WEEK', servicePeriodCount: 1 },
  ])
    assert.equal(createProduct.safeParse({ ...base, ...fields }).success, false)
})

test('one-time periods are null and edits must supply a complete period pair', () => {
  const base = {
    name: 'Once',
    type: 'ONE_TIME',
    priceFen: 100,
    renewalPriceFen: null,
    termLabel: '一次',
  }
  const parsed = createProduct.parse(base)
  assert.equal(parsed.servicePeriodUnit, null)
  assert.equal(parsed.servicePeriodCount, null)
  assert.equal(
    createProduct.safeParse({
      ...base,
      servicePeriodUnit: null,
      servicePeriodCount: null,
    }).success,
    true,
  )
  for (const fields of [
    { servicePeriodUnit: 'DAY', servicePeriodCount: 1 },
    { servicePeriodUnit: 'DAY' },
    { servicePeriodCount: 1 },
  ])
    assert.equal(createProduct.safeParse({ ...base, ...fields }).success, false)
  for (const fields of [
    { servicePeriodUnit: 'DAY' },
    { servicePeriodCount: 1 },
    { servicePeriodUnit: null },
    { servicePeriodCount: null },
  ])
    assert.equal(editProduct.safeParse(fields).success, false)
  assert.equal(
    editProduct.safeParse({ servicePeriodUnit: 'YEAR', servicePeriodCount: 1 })
      .success,
    true,
  )
})

test('settings accept only non-secret singleton fields and valid IANA timezone', () => {
  assert.deepEqual(
    editSettings.parse({
      storeName: ' 商店 ',
      ownerEmail: ' Owner@Example.com ',
      timezone: 'Asia/Shanghai',
    }),
    {
      storeName: '商店',
      ownerEmail: 'owner@example.com',
      timezone: 'Asia/Shanghai',
    },
  )
  for (const input of [
    {},
    { timezone: 'Not/A_Zone' },
    { timezone: '+08:00' },
    { smtpPassword: 'no' },
    { id: 2 },
    { ownerEmail: 'invalid' },
  ])
    assert.equal(editSettings.safeParse(input).success, false)
})
