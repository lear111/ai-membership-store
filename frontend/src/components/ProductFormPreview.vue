<script setup lang="ts">
import { FORM_TEXT_MAX_LENGTH } from '../../../backend/src/contracts/form-limits'
import { computed, reactive, watch } from 'vue'
import {
  productFormSchema,
  type ProductFormSchema,
} from '../../../backend/src/contracts/product-form'
const props = defineProps<{ schema: ProductFormSchema }>()
const valid = computed(() => productFormSchema.safeParse(props.schema))
type Value = string | number | string[] | undefined
const values = reactive<Record<string, Value>>({})
watch(
  () => props.schema,
  (schema) => {
    for (const key of Object.keys(values)) delete values[key]
    const result = productFormSchema.safeParse(schema)
    if (result.success)
      for (const field of result.data.fields)
        values[field.id] = Array.isArray(field.defaultValue)
          ? [...field.defaultValue]
          : field.defaultValue
  },
  { deep: true, immediate: true },
)
</script>
<template>
  <div class="form-preview" data-testid="form-preview">
    <h3>表单预览</h3>
    <p class="muted">
      仅预览配置，试填内容不会保存或提交。
    </p>
    <p v-if="!valid.success" class="muted">请先修正字段配置后预览。</p>
    <template v-else>
      <p v-if="!valid.data.fields.length" class="muted">暂无自定义字段</p>
      <div
        v-for="field in valid.data.fields"
        :key="field.id"
        class="preview-field"
      >
        <label :for="'preview-' + field.id"
          >{{ field.label
          }}<span v-if="field.required" class="required-mark"> *</span></label
        >
        <ElSelect
          v-if="field.type === 'select'"
          v-model="values[field.id]"
          :id="'preview-' + field.id"
          :aria-label="'预览 ' + field.label"
          :placeholder="field.hint || '请选择'"
          clearable
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
          v-model="values[field.id]"
          :id="'preview-' + field.id"
          :aria-label="'预览 ' + field.label"
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
          :model-value="
            Array.isArray(values[field.id])
              ? (values[field.id] as string[])
              : []
          "
          @update:model-value="
            (value: unknown[]) => (values[field.id] = value.map(String))
          "
          :id="'preview-' + field.id"
          :aria-label="'预览 ' + field.label"
        >
          <ElCheckbox
            v-for="option in field.options"
            :key="option.value"
            :value="option.value"
            >{{ option.label }}</ElCheckbox
          >
        </ElCheckboxGroup>
        <ElInput
          form="preview-only-no-submission"
          v-else
          :model-value="String(values[field.id] ?? '')"
          @update:model-value="(value: string) => (values[field.id] = value)"
          :id="'preview-' + field.id"
          :aria-label="'预览 ' + field.label"
          :type="
            field.type === 'textarea'
              ? 'textarea'
              : field.type === 'text'
                ? 'text'
                : field.type
          "
          :placeholder="field.hint"
          :rows="3"
          step="any"
          :maxlength="
            field.type === 'number' || field.type === 'date'
              ? undefined
              : FORM_TEXT_MAX_LENGTH[field.type]
          "
        />
        <small
          v-if="field.hint && ['radio', 'checkbox'].includes(field.type)"
          class="muted"
          >{{ field.hint }}</small
        >
      </div>
    </template>
  </div>
</template>
