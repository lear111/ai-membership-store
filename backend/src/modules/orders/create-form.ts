import { productFormSchema } from '../../contracts/product-form.ts'
import { parseFormData } from '../../contracts/form-data.ts'

export function creationForm(schemaInput: unknown, input: unknown) {
  const schema = productFormSchema.parse(schemaInput)
  return parseFormData(schema, input)
}
