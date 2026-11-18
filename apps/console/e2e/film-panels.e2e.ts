/**
 * Film panels end to end (RFC 0004 §5.2, WP10) in fixture mode (RUN_CONSOLE_E2E=1 pnpm console:e2e): the script gate
 * and the build step at 1280 and 390 px, dark and light, with every panel open; screenshots into out/qa/console/
 * (`film-*.png`), axe with no serious violation, no horizontal page scroll.
 */
import path from "node:path";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const QA = path.resolve(process.cwd(), "out/qa/console");

const FIXTURES = [
  { fixture: "view-film-script-gate", current: "film.script", pointer: "film.script", name: "script-gate" },
  { fixture: "view-film-build", current: "film.build", pointer: "film.narration", name: "build" },
] as const;

for (const theme of ["dark", "light"] as const)
  for (const width of [1280, 390])
    test(`film verdict with material ${theme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`./?fixture=view-film-human&lang=en&theme=${theme}`);
      const card = page.locator('[data-card="decision"][data-decision="dec-human-verdict"]');
      await expect(card).toBeVisible();
      await expect(card.getByRole("button", { name: /Approve|Accept/ })).toHaveCount(0);
      // the pinned verdict card opens the verdict form and focuses its first score
      await card.getByRole("button", { name: "Open the verdict form" }).click();
      const human = page.locator('[data-panel="film.human"]');
      await expect(human.locator('input[type="radio"]').first()).toBeFocused();
      await expect(human.locator("[data-axis]")).toHaveCount(11);
      await expect(human.locator('[data-frame-comment-input="player"]')).toHaveCount(1);
      const closed = page.locator('[data-panel] > h2 > button[aria-expanded="false"]');
      for (let guard = 0; guard < 30 && (await closed.count()) > 0; guard++) await closed.first().click();
      await expect(page.locator('[data-panel="film.critic"] [data-compare]').first()).toBeVisible();
      await expect(page.locator('[data-panel="film.ideas"] [data-candidate]')).toHaveCount(6);
      await expect(page.locator('[data-panel="film.beats"] [data-shot]')).toHaveCount(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal page scroll").toBe(width);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(QA, `film-human-${theme}-${width}.png`), fullPage: true });
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations
        .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
        .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(" ")) }));
      expect(serious).toEqual([]);
    });

for (const { fixture, current, pointer, name } of FIXTURES)
  for (const theme of ["dark", "light"] as const)
    for (const width of [1280, 390])
      test(`film panels ${name} ${theme} ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`./?fixture=${fixture}&lang=en&theme=${theme}`);
        const panel = page.locator(`[data-panel="${current}"]`);
        await expect(panel).toBeVisible();
        await expect(panel.locator("> h2 > button")).toHaveAttribute("aria-expanded", "true");
        // the current step's panel is the first film panel on the canvas
        const firstFilm = await page.locator('[data-panel^="film."]').first().getAttribute("data-panel");
        expect(firstFilm).toBe(current);
        // the pointer moves focus to the pinned decision card
        await page.locator(`[data-panel="${pointer}"]`).getByRole("button", { name: "Go to the decision" }).click();
        await expect(page.locator('[data-card="decision"]:focus')).toHaveCount(1);
        const closed = page.locator('[data-panel] > h2 > button[aria-expanded="false"]');
        for (let guard = 0; guard < 30 && (await closed.count()) > 0; guard++) await closed.first().click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal page scroll").toBe(
          width,
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(QA, `film-${name}-${theme}-${width}.png`), fullPage: true });
        const results = await new AxeBuilder({ page }).analyze();
        const serious = results.violations
          .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
          .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(" ")) }));
        expect(serious).toEqual([]);
      });
