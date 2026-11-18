/** Playwright helpers for `SelectField` (shadcn/Radix Select): the console has no native `<select>`. */
import type { Locator, Page } from "@playwright/test";

/** The open dropdown's options. */
export const openOptions = (page: Page) => page.locator('[data-slot="select-content"] [role="option"]');

/** Opens the dropdown from its trigger and clicks the option with `value` (its `data-value`) or at `index`. */
export async function choose(page: Page, trigger: Locator, pick: string | { index: number }): Promise<void> {
  await trigger.click();
  const options = openOptions(page);
  const option =
    typeof pick === "string"
      ? options.and(page.locator(`[data-value=${JSON.stringify(pick)}]`))
      : options.nth(pick.index);
  await option.click();
}

/** Opens the dropdown, runs `check` on its options, then closes it with Escape. */
export async function withOptions(page: Page, trigger: Locator, check: (options: Locator) => Promise<void>) {
  await trigger.click();
  await check(openOptions(page));
  await page.keyboard.press("Escape");
}
