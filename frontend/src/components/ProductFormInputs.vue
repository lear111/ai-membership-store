<script setup lang="ts">
import { FORM_TEXT_MAX_LENGTH } from '../../../backend/src/contracts/form-limits'
import type { ProductFormSchema } from '../api/products'
import type { FormData } from '../api/subscriptions'
defineProps<{
  schema: ProductFormSchema
  modelValue: FormData
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [FormData] }>()
function update(
  values: FormData,
  id: string,
  value: string | number | string[] | undefined,
) {
  const next = { ...values }
  if (
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && !value.length)
  )
    delete next[id]
  else next[id] = value
  emit('update:modelValue', next)
}
</script>
<template>
  <div class="service-inputs">
    <p v-if="!schema.fields.length" class="muted">此商品没有额外服务信息。</p>
    <ElFormItem
      v-for="field in schema.fields"
      :key="field.id"
      :label="field.label + (field.required ? ' *' : '')"
    >
      <ElSelect
        v-if="field.type === 'select'"
        :model-value="modelValue[field.id]"
        :disabled="disabled"
        :aria-label="'服务信息 ' + field.label"
        clearable
        @update:model-value="
          (value: string) => update(modelValue, field.id, value)
        "
      >
        <ElOption
          v-for="option in field.options"
          :key="option.value"
          :label="option.label"
          :value="option.value"
        />
      </ElSelect>
      <ElRadioGroup
        v-else-if="field.type === 'radio'"
        :model-value="modelValue[field.id]"
        :disabled="disabled"
        :aria-label="'服务信息 ' + field.label"
        @update:model-value="
          (value: string | number | boolean) =>
            update(modelValue, field.id, String(value))
        "
      >
        <ElRadio
          v-for="option in field.options"
          :key="option.value"
          :value="option.value"
          >{{ option.label }}</ElRadio
        >
      </ElRadioGroup>
      <ElCheckboxGroup
        v-else-if="field.type === 'checkbox'"
        :model-value="modelValue[field.id] || []"
        :disabled="disabled"
        :aria-label="'服务信息 ' + field.label"
        @update:model-value="
          (value: unknown[]) => update(modelValue, field.id, value as string[])
        "
      >
        <ElCheckbox
          v-for="option in field.options"
          :key="option.value"
          :value="option.value"
          >{{ option.label }}</ElCheckbox
        >
      </ElCheckboxGroup>
      <ElInput
        v-else
        :model-value="modelValue[field.id] ?? ''"
        :type="
          field.type === 'textarea'
            ? 'textarea'
            : field.type === 'number'
              ? 'number'
              : field.type === 'date'
                ? 'date'
                : field.type === 'email'
                  ? 'email'
                  : 'text'
        "
        :disabled="disabled"
        :aria-label="'服务信息 ' + field.label"
        :maxlength="
          field.type === 'number' || field.type === 'date'
            ? undefined
            : FORM_TEXT_MAX_LENGTH[field.type]
        "
        :step="field.type === 'number' ? 'any' : undefined"
        @update:model-value="
          (value: string) =>
            update(
              modelValue,
              field.id,
              field.type === 'number'
                ? value === ''
                  ? undefined
                  : Number(value)
                : value,
            )
        "
      />
      <small v-if="field.hint" class="muted">{{ field.hint }}</small>
    </ElFormItem>
  </div>
</template>
