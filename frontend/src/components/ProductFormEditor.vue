<script setup lang="ts">
import { FORM_TEXT_MAX_LENGTH } from '../../../backend/src/contracts/form-limits'
import { computed } from 'vue'
import {
  productFormSchema,
  MAX_FIELDS,
  MAX_OPTIONS,
  type FormField,
  type ProductFormSchema,
} from '../../../backend/src/contracts/product-form'
import ProductFormPreview from './ProductFormPreview.vue'
const props = defineProps<{ modelValue: ProductFormSchema }>()
const emit = defineEmits<{ 'update:modelValue': [ProductFormSchema] }>()
const types = [
  ['text', '单行文本'],
  ['email', '邮箱'],
  ['textarea', '多行文本'],
  ['select', '下拉选择'],
  ['radio', '单选'],
  ['checkbox', '多选'],
  ['number', '数字'],
  ['date', '日期'],
]
const errors = computed(() => {
  const result = productFormSchema.safeParse(props.modelValue)
  return result.success
    ? []
    : result.error.issues
        .slice(0, 4)
        .map((issue) => issue.path.join('.') + '：' + issue.message)
})
function replace(fields: FormField[]) {
  emit('update:modelValue', { version: 1, fields })
}
function update(index: number, patch: Record<string, unknown>) {
  replace(
    props.modelValue.fields.map((field, i) =>
      i === index ? ({ ...field, ...patch } as FormField) : field,
    ),
  )
}
function add() {
  if (props.modelValue.fields.length >= MAX_FIELDS) return
  replace([
    ...props.modelValue.fields,
    {
      id: 'field_' + crypto.randomUUID(),
      type: 'text',
      label: '新字段',
      required: false,
      hint: '',
    },
  ])
}
function move(index: number, direction: number) {
  const fields = [...props.modelValue.fields]
  const target = index + direction
  if (target < 0 || target >= fields.length) return
  ;[fields[index], fields[target]] = [fields[target]!, fields[index]!]
  replace(fields)
}
function changeType(index: number, type: string) {
  const current = props.modelValue.fields[index]!
  const field = {
    id: current.id,
    label: current.label,
    required: current.required,
    hint: current.hint,
    type,
  } as FormField
  if (['select', 'radio', 'checkbox'].includes(type))
    Object.assign(field, {
      options: [{ value: 'option_' + crypto.randomUUID(), label: '选项 1' }],
    })
  replace(
    props.modelValue.fields.map((item, i) => (i === index ? field : item)),
  )
}
function setDefault(index: number, value: unknown) {
  const field = props.modelValue.fields[index]!
  const fields = props.modelValue.fields.map((item) => ({ ...item }))
  if (value === '' || value === null || value === undefined)
    delete fields[index]!.defaultValue
  else
    fields[index]!.defaultValue = (
      field.type === 'number' ? Number(value) : value
    ) as FormField['defaultValue']
  replace(fields as FormField[])
}
function addOption(index: number) {
  const field = props.modelValue.fields[index]!
  if (!('options' in field) || field.options.length >= MAX_OPTIONS) return
  update(index, {
    options: [
      ...field.options,
      {
        value: 'option_' + crypto.randomUUID(),
        label: '选项 ' + (field.options.length + 1),
      },
    ],
  })
}
function optionLabel(index: number, optionIndex: number, value: string) {
  const field = props.modelValue.fields[index]!
  if ('options' in field)
    update(index, {
      options: field.options.map((option, i) =>
        i === optionIndex ? { ...option, label: value } : option,
      ),
    })
}
function removeOption(index: number, optionIndex: number) {
  const field = props.modelValue.fields[index]!
  if (!('options' in field)) return
  const removed = field.options[optionIndex]!.value
  const next = {
    ...field,
    options: field.options.filter((_, i) => i !== optionIndex),
  }
  if (Array.isArray(next.defaultValue))
    next.defaultValue = next.defaultValue.filter(
      (value: string) => value !== removed,
    )
  else if (next.defaultValue === removed) delete next.defaultValue
  replace(props.modelValue.fields.map((item, i) => (i === index ? next : item)))
}
</script>
<template>
  <div class="form-configuration">
    <div class="form-section-heading">
      <h3>商品动态表单</h3>
      <ElButton :disabled="modelValue.fields.length >= MAX_FIELDS" @click="add"
        >添加字段</ElButton
      >
    </div>
    <p class="muted">
      仅配置必要的非敏感信息，禁止收集密码、验证码、令牌等秘密。最多 20
      个字段、每字段 20 个选项，配置上限 64 KiB（UTF-8 字节）。
    </p>
    <p v-if="errors.length" class="form-error" role="alert">
      {{ errors.join('；') }}
    </p>
    <div
      v-for="(field, index) in modelValue.fields"
      :key="field.id"
      class="form-field-editor"
    >
      <div class="form-section-heading">
        <strong>字段 {{ index + 1 }}</strong>
        <div class="field-actions">
          <ElButton
            size="small"
            :disabled="index === 0"
            :aria-label="'上移字段 ' + field.label"
            @click="move(index, -1)"
            >上移</ElButton
          >
          <ElButton
            size="small"
            :disabled="index === modelValue.fields.length - 1"
            :aria-label="'下移字段 ' + field.label"
            @click="move(index, 1)"
            >下移</ElButton
          >
          <ElButton
            size="small"
            type="danger"
            :aria-label="'删除字段 ' + field.label"
            @click="replace(modelValue.fields.filter((_, i) => i !== index))"
            >删除字段</ElButton
          >
        </div>
      </div>
      <small class="field-id">固定 ID：{{ field.id }}</small>
      <div class="form-grid">
        <ElFormItem label="字段名称"
          ><ElInput
            :model-value="field.label"
            @update:model-value="
              (value: string) => update(index, { label: value })
            "
            aria-label="字段名称"
            maxlength="80"
        /></ElFormItem>
        <ElFormItem label="字段类型"
          ><ElSelect
            :model-value="field.type"
            @update:model-value="
              (value: string) => changeType(index, String(value))
            "
            aria-label="字段类型"
          >
            <ElOption
              v-for="[value, label] in types"
              :key="value"
              :label="label"
              :value="value"
            /> </ElSelect
        ></ElFormItem>
      </div>
      <ElFormItem label="输入提示"
        ><ElInput
          :model-value="field.hint"
          @update:model-value="
            (value: string) => update(index, { hint: value })
          "
          aria-label="输入提示"
          maxlength="200"
      /></ElFormItem>
      <div class="toggle-row">
        <span>是否必填</span
        ><ElSwitch
          :model-value="field.required"
          @update:model-value="
            (value: string) => update(index, { required: Boolean(value) })
          "
          :aria-label="field.label + '必填'"
        />
      </div>
      <template v-if="'options' in field">
        <div
          v-for="(option, optionIndex) in field.options"
          :key="option.value"
          class="option-editor"
        >
          <ElInput
            :model-value="option.label"
            @update:model-value="
              (value: string) => optionLabel(index, optionIndex, value)
            "
            aria-label="选项名称"
            maxlength="80"
          />
          <ElButton
            type="danger"
            link
            :aria-label="'删除选项 ' + option.label"
            @click="removeOption(index, optionIndex)"
            >删除选项</ElButton
          >
        </div>
        <ElButton
          :disabled="field.options.length >= MAX_OPTIONS"
          @click="addOption(index)"
          >添加选项</ElButton
        >
        <ElFormItem label="默认值">
          <ElSelect
            :model-value="field.defaultValue"
            @update:model-value="(value: string) => setDefault(index, value)"
            :multiple="field.type === 'checkbox'"
            clearable
            aria-label="字段默认值"
          >
            <ElOption
              v-for="option in field.options"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </ElSelect>
        </ElFormItem>
      </template>
      <ElFormItem v-else label="默认值"
        ><ElInput
          :model-value="String(field.defaultValue ?? '')"
          @update:model-value="(value: string) => setDefault(index, value)"
          :type="
            field.type === 'textarea'
              ? 'textarea'
              : field.type === 'text'
                ? 'text'
                : field.type
          "
          step="any"
          aria-label="字段默认值"
          :maxlength="
            field.type === 'number' || field.type === 'date'
              ? undefined
              : FORM_TEXT_MAX_LENGTH[field.type]
          "
      /></ElFormItem>
    </div>
    <ProductFormPreview :schema="modelValue" />
  </div>
</template>
