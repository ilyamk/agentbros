/**
 * WP15 end to end (RFC 0004 US21–US23, D18; RUN_CONSOLE_E2E=1 pnpm console:e2e): the replica, recipe and campaign
 * canvases and the motion library at 1280 and 390 px, dark and light, every panel open, axe with no serious violation,
 * no horizontal page scroll; and a static snapshot opened from disk with no request leaving the page. Screenshots
 * into out/qa/console/ (`route-*.png`, `library-*.png`, `snapshot-*.png`).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { renderSnapshot } from "../../../src/lib/console/snapshot";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const REPO = process.cwd();
const QA = path.join(REPO, "out/qa/console");

async function openAll(page: Page) {
  const closed = page.locator('[data-panel] > h2 > button[aria-expanded="false"]');
  for (let guard = 0; guard < 40 && (await closed.count()) > 0; guard++) await closed.first().click();
}

async function check(page: Page, width: number, shot: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal page scroll").toBe(width);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(QA, shot), fullPage: true });
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations
    .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(" ")) }));
  expect(serious).toEqual([]);
}

const ROUTES = [
  { fixture: "view-replica", panels: ["replica.rights", "replica.spec", "replica.compare"], name: "replica" },
  { fixture: "view-recipe", panels: ["recipe.draft"], name: "recipe" },
  { fixture: "view-campaign", panels: ["campaign.summary"], name: "campaign" },
] as const;

for (const { fixture, panels, name } of ROUTES)
  for (const theme of ["dark", "light"] as const)
    for (const width of [1280, 390])
      test(`route canvas ${name} ${theme} ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`./?fixture=${fixture}&lang=en&theme=${theme}`);
        for (const id of panels) await expect(page.locator(`[data-panel="${id}"]`)).toBeVisible();
        await openAll(page);
        await check(page, width, `route-${name}-${theme}-${width}.png`);
      });

for (const theme of ["dark", "light"] as const)
  for (const width of [1280, 390])
    test(`library ${theme} ${width}px`, async ({ page }) => {
      await page.route("**/library/preview/**", (route) => {
        const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
        return route.fulfill({
          contentType: "image/jpeg",
          body: readFileSync(path.join(REPO, "docs/library/previews", `${id}.jpg`)),
        });
      });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`./?fixture=projects-response&lang=en&theme=${theme}#/library`);
      await expect(page.locator("[data-block]").first()).toBeVisible();
      await expect(page.locator("[data-block] img").first()).toBeVisible();
      await page.getByLabel("Search the library").fill("hero");
      await expect(page.locator("[data-block]")).not.toHaveCount(0);
      await page.getByLabel("Search the library").fill("");
      await check(page, width, `library-${theme}-${width}.png`);
    });

test("snapshot: opens from disk, read-only, no request leaves the page", async ({ page }) => {
  const dist = path.join(REPO, "out/console/dist");
  const view = JSON.parse(readFileSync(path.join(REPO, "tests/fixtures/console/view-film-build.json"), "utf8"));
  const html = renderSnapshot({
    data: {
      v: 1,
      takenAt: "2026-11-17T10:00:00.000Z",
      view,
      summary: {
        id: view.project.id,
        route: view.project.route,
        waiting: view.waiting.length,
        control: "running",
        spentUsd: 0,
        updatedAt: view.generatedAt,
      },
    },
    js: readFileSync(path.join(dist, "app.js"), "utf8"),
    css: readFileSync(path.join(dist, "style.css"), "utf8"),
  });
  const dir = mkdtempSync(path.join(tmpdir(), "console-snapshot-e2e-"));
  try {
    mkdirSync(path.join(dir, "out", view.project.id), { recursive: true });
    const file = path.join(dir, "out", view.project.id, "console-snapshot.html");
    writeFileSync(file, html);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith("file:")) requests.push(request.url());
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(pathToFileURL(file).href);
      await expect(page.locator("[data-snapshot-banner]")).toBeVisible();
      await expect(page.locator('[data-card="decision"]').first()).toBeVisible();
      await expect(page.locator("fieldset[disabled]")).toHaveCount(1);
      await openAll(page);
      await expect(page.locator("video")).toHaveCount(0);
      await expect(page.locator("[data-snapshot-media]").first()).toBeVisible();
      await page.screenshot({ path: path.join(QA, `snapshot-${width}.png`), fullPage: true });
    }
    expect(requests).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
