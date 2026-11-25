import { expect, type Locator, type Page } from '@playwright/test'

export async function pasteAtTextareaLimit(
  page: Page,
  field: Locator,
  value: string,
) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await expect(field).toHaveAttribute('maxlength', '10000')
  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    value + 'x',
  )
  await field.fill('')
  await field.press('Control+V')
  await expect(field).toHaveValue(value)
  await field.press('End')
  await field.press('x')
  await expect(field).toHaveValue(value)
}
