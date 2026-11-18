/**
 * Footage panels and the metrics page end to end (RFC 0004 US19, A15, A19, WP12) in fixture mode
 * (RUN_CONSOLE_E2E=1 pnpm console:e2e): the recut plan's approval and the rendered outputs at 1280 and 390 px, dark
 * and light, with every panel open, and `#/metrics`; screenshots into out/qa/console/ (`footage-*.png`,
 * `metrics-*.png`), axe with no serious violation, no horizontal page scroll.
 */
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const QA = path.resolve(process.cwd(), "out/qa/console");

const FIXTURES = [
  { fixture: "view-footage", current: "footage.plan", name: "plan" },
  { fixture: "view-footage-render", current: "footage.render", name: "render" },
] as const;

async function check(page: Page, width: number, file: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal page scroll").toBe(width);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(QA, file), fullPage: true });
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations
    .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(" ")) }));
  expect(serious).toEqual([]);
}

for (const { fixture, current, name } of FIXTURES)
  for (const theme of ["dark", "light"] as const)
    for (const width of [1280, 390])
      test(`footage panels ${name} ${theme} ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`./?fixture=${fixture}&lang=en&theme=${theme}`);
        const panel = page.locator(`[data-panel="${current}"]`);
        await expect(panel).toBeVisible();
        await expect(panel.locator("> h2 > button")).toHaveAttribute("aria-expanded", "true");
        expect(await page.locator('[data-panel^="footage."]').first().getAttribute("data-panel")).toBe(current);
        const closed = page.locator('[data-panel] > h2 > button[aria-expanded="false"]');
        for (let guard = 0; guard < 30 && (await closed.count()) > 0; guard++) await closed.first().click();
        if (name === "plan") {
          await expect(page.locator("[data-cut-timeline] [data-cut]").first()).toBeVisible();
          await expect(page.locator("[data-after-bar]")).toBeVisible();
        } else {
          await expect(page.locator('[data-panel="footage.shorts"] [data-short]')).toHaveCount(3);
          await expect(page.locator('[data-panel="footage.render"] [data-render]')).toHaveCount(3);
        }
        await check(page, width, `footage-${name}-${theme}-${width}.png`);
      });

for (const theme of ["dark", "light"] as const)
  for (const width of [1280, 390])
    test(`metrics page ${theme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`./?fixture=view-footage&lang=en&theme=${theme}#/metrics`);
      await expect(page.getByRole("heading", { level: 1, name: "Metrics" })).toBeVisible();
      await expect(page.getByText("2026-11")).toBeVisible();
      await check(page, width, `metrics-${theme}-${width}.png`);
    });
