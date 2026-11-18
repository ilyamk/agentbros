/**
 * RFC 0004 acceptance gaps in fixture mode (RUN_CONSOLE_E2E=1 pnpm console:e2e): the autonomy and budget form with
 * its confirmation of a raise (A10, US14), Stop's per-job cancel list (A9), the hooks status and install in Settings
 * (H3) and the history's version compare (US17), at 1280 and 390 px, dark and light; axe with no serious violation; no
 * horizontal page scroll; screenshots into out/qa/console/ (`gaps-*.png`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const QA = path.resolve(process.cwd(), "out/qa/console");
let dir = "";
let clip: Buffer | undefined;

test.beforeAll(() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    return;
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "console-gaps-e2e-"));
  const mp4 = path.join(dir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4,
  ]); // prettier-ignore
  clip = readFileSync(mp4);
});

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function axe(page: Page, include?: string) {
  const builder = new AxeBuilder({ page });
  const results = await (include ? builder.include(include) : builder).analyze();
  return results.violations
    .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(" ")) }));
}

async function noHorizontalScroll(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal page scroll").toBe(width);
}

/** Fixture mode has no server: a tiny clip answers every video /media request. */
async function serveClip(page: Page) {
  await page.route("**/media/**", async (route) => {
    if (!clip) return route.fulfill({ status: 404, body: "" });
    await route.fulfill({
      status: 200,
      body: clip,
      headers: { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": String(clip.length) },
    });
  });
}

for (const theme of ["dark", "light"] as const)
  for (const width of [1280, 390]) {
    test(`autonomy and budget form ${theme} ${width}px: a raise is confirmed with the command and amounts`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`./?fixture=view-film-build&lang=en&theme=${theme}`);
      const topBar = page.getByRole("banner", { name: "Project" });
      await expect(topBar).toContainText("$3.10 of $10.00");
      await topBar.getByRole("button", { name: /Change autonomy and budget/ }).click();
      const dialog = page.getByRole("dialog", { name: "Autonomy and budget" });
      await dialog.getByLabel("Budget ceiling (USD)").fill("20");
      await expect(dialog.getByLabel("Your words")).toHaveValue("Set the budget ceiling to $20.00.");
      await dialog.getByRole("button", { name: "Apply" }).click();
      const confirm = page.getByRole("dialog", { name: "Confirm a wider grant" });
      await expect(confirm.locator("[data-policy-command]")).toContainText("pnpm film:policy --project promo-acme");
      await expect(confirm.getByRole("row", { name: /Budget ceiling/ })).toContainText("$10.00");
      await expect(confirm.getByRole("row", { name: /Budget ceiling/ })).toContainText("$20.00");
      await noHorizontalScroll(page, width);
      expect(await axe(page, "[role=dialog]")).toEqual([]);
      await page.screenshot({ path: path.join(QA, `gaps-autonomy-${theme}-${width}.png`) });
      await confirm.getByRole("button", { name: "Confirm and apply" }).click();
      await expect(confirm).toBeHidden();
      await expect(topBar).toContainText("$3.10 of $20.00");
    });

    test(`stop lists paid jobs and cancels one on its own confirmation ${theme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`./?fixture=view-film-build&lang=en&theme=${theme}`);
      await page.locator('[data-control="stopped"]').click();
      const dialog = page.getByRole("dialog", { name: "Stop the project" });
      await dialog.getByRole("button", { name: "Stop" }).click();
      const jobs = dialog.locator("[data-paid-jobs]");
      const narration = jobs.locator('[data-job="job-narration-02"]');
      await expect(narration).toContainText("$1.40 reserved");
      const sfx = jobs.locator('[data-job="job-sfx-03"]');
      await expect(sfx).toContainText("Cannot be cancelled: provider elevenlabs offers no cancellation");
      await expect(sfx.getByRole("button")).toHaveCount(0);
      await narration.getByRole("button", { name: "Cancel job job-narration-02" }).click();
      await expect(narration.getByLabel("Your words")).toHaveValue("Cancel job job-narration-02.");
      await noHorizontalScroll(page, width);
      expect(await axe(page, "[role=dialog]")).toEqual([]);
      await page.screenshot({ path: path.join(QA, `gaps-stop-jobs-${theme}-${width}.png`) });
      await narration.getByRole("button", { name: "Cancel this job" }).click();
      await expect(narration.getByRole("status")).toHaveText("Cancelled.");
      await expect(narration).toHaveAttribute("data-job-state", "cancelled");
      await dialog.getByRole("button", { name: "Close" }).first().click();
      // Stopped with a job still in flight: the list stays one click away.
      await page.locator("[data-paid-jobs-open]").click();
      await expect(
        page.getByRole("dialog", { name: "Running paid jobs" }).locator('[data-job="job-sfx-03"]'),
      ).toBeVisible();
    });

    test(`settings show hooks status and install after a confirm ${theme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`./?fixture=view-film-build&lang=en&theme=${theme}#/settings`);
      const hooks = page.locator("[data-hooks-settings]");
      await expect(hooks.locator('[data-hook-state="installed"]')).toContainText("Installed");
      await expect(hooks.locator('[data-hook-state="missing"]')).toContainText("Not installed");
      await expect(hooks.locator("[data-hooks-command]")).toHaveText("pnpm harness:setup --hooks --apply");
      await noHorizontalScroll(page, width);
      expect(await axe(page)).toEqual([]);
      await page.screenshot({ path: path.join(QA, `gaps-hooks-${theme}-${width}.png`), fullPage: true });
      await hooks.getByRole("button", { name: "Install hooks…" }).click();
      const dialog = page.getByRole("dialog", { name: "Install the harness hooks" });
      await expect(dialog).toContainText(".codex/hooks.json");
      expect(await axe(page, "[role=dialog]")).toEqual([]);
      await dialog.getByRole("button", { name: "Install" }).click();
      await expect(hooks.locator("[data-hooks-trust]")).toContainText("One trust step per harness");
      await expect(hooks.locator('[data-hook-state="installed"]')).toHaveCount(2);
    });

    test(`history compares two versions ${theme} ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await serveClip(page);
      await page.goto(`./?fixture=view-film-script-gate&lang=en&theme=${theme}#/projects/teaser-nova/history`);
      const compare = page.locator("[data-compare-versions]");
      await compare.scrollIntoViewIfNeeded();
      await compare.getByRole("combobox", { name: "Version A" }).click();
      await page.getByRole("option", { name: /Script S1/ }).click();
      await compare.getByRole("combobox", { name: "Version B" }).click();
      await page.getByRole("option", { name: /Script S2/ }).click();
      const diff = compare.locator("[data-text-diff]");
      await expect(diff).toContainText("2 lines added, 3 removed");
      await expect(diff.locator('[data-diff="added"]').first()).toContainText("What if mail answered itself?");
      await noHorizontalScroll(page, width);
      expect(await axe(page, "[data-compare-versions]")).toEqual([]);
      await compare.screenshot({ path: path.join(QA, `gaps-compare-text-${theme}-${width}.png`) });

      if (!clip) return;
      await page.goto(`./?fixture=view-film-human&lang=en&theme=${theme}#/projects/promo-acme/history`);
      const renders = page.locator("[data-compare-versions]");
      await renders.getByRole("combobox", { name: "Version A" }).click();
      await page.getByRole("option", { name: "Renders · out/film.mp4" }).click();
      await renders.getByRole("combobox", { name: "Version B" }).click();
      await page.getByRole("option", { name: "Renders · out/animatic/animatic-v3.mp4" }).click();
      await expect(renders.locator("[data-compare]")).toBeVisible();
      await noHorizontalScroll(page, width);
      expect(await axe(page, "[data-compare-versions]")).toEqual([]);
      await renders.screenshot({ path: path.join(QA, `gaps-compare-renders-${theme}-${width}.png`) });
    });
  }
