/**
 * The editing table and the Studio launcher end to end (2026-11-18; RUN_CONSOLE_E2E=1 pnpm console:e2e).
 *
 * - Real console server (tests/helpers/console-timeline-server.ts over a temporary checkout, the bundle in
 *   out/console/dist): "Editing table" opens a new tab through `window.open` with an opener, and that tab is signed in
 *   by the sessionStorage the browser copied (no token in its URL) and shows the timeline. "Edit myself" pauses with
 *   the editing-table marker; the new tab shows the banner; the user's own timeline edit still applies while paused;
 *   "Done" resumes with words naming the revision, written to the control file.
 * - Fixture mode: the header actions and the banner at 1280 and 390 px, dark and light, with axe and no horizontal
 *   scroll (screenshots `editing-*.png` into out/qa/console/); the Studio button opens the server's URL in a new tab.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const QA = path.resolve(process.cwd(), "out/qa/console");
const DIST = path.resolve(process.cwd(), "out/console/dist");
const TOKEN_KEY = "agentbros.console.token";

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations
    .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(" ")) }));
  expect(serious).toEqual([]);
}

test.describe("real server", () => {
  let root = "";
  let child: ChildProcess | undefined;
  let origin = "";
  let token = "";

  test.beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "console-editing-e2e-"));
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve(process.cwd(), "tests/helpers/console-timeline-server.ts"),
        "--root",
        root,
        "--dist",
        DIST,
        "--projects",
        "2",
        "--control",
      ],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_HOOKS: "off" },
      },
    );
    const line = await new Promise<string>((resolve, reject) => {
      child!.once("exit", (code) => reject(new Error(`console server exited (${code})`)));
      createInterface({ input: child!.stdout! }).once("line", resolve);
    });
    ({ origin, token } = JSON.parse(line) as { origin: string; token: string });
  });

  test.afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child!.once("exit", resolve));
      child.stdin?.end();
      await exited;
    }
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function openCanvas(page: Page, project: string) {
    await page.goto(`${origin}/?lang=en#token=${token}&project=${project}`);
    await expect(page.locator('nav a[aria-current="page"]', { hasText: /^Canvas$/ })).toBeVisible({
      timeout: 15_000,
    });
  }

  test("Editing table: the new tab is signed in by the copied sessionStorage and shows the timeline", async ({
    page,
  }) => {
    await openCanvas(page, "film-1");
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("button", { name: "Editing table", exact: true }).click(),
    ]);
    await expect(popup.getByTestId("timeline-view")).toBeVisible({ timeout: 15_000 });
    await expect(popup.locator("#identity")).toContainText("film-1 · revision 0");
    expect(popup.url()).toMatch(/#\/projects\/film-1\/timeline$/);
    expect(popup.url()).not.toContain(token);
    expect(await popup.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY)).toBe(token);
    expect(await popup.evaluate(() => window.opener !== null)).toBe(true);
    await expect(popup.getByText("did not accept this link")).toHaveCount(0);
    await popup.close();
  });

  test("Studio: the new tab drops the console's copied session; the console stays signed in", async ({ page }) => {
    // The server's Studio routes, answered here: this test is about the browser, not about starting Studio.
    await page.route("**/api/projects/film-1/studio", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          route.request().method() === "POST"
            ? { ok: true, url: "http://127.0.0.1:3000/Film", reused: false }
            : { ok: true, available: true, target: { kind: "film", entry: "src/index.ts", composition: "Film" } },
        ),
      }),
    );
    await page
      .context()
      .route("http://127.0.0.1:3000/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Studio</title><p>Studio</p>" }),
      );
    await openCanvas(page, "film-1");
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator("[data-studio-open]").first().click()]);
    await expect.poll(() => popup.url()).toBe("http://127.0.0.1:3000/Film");
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    // Back on the console's origin in that tab: the session it inherited from the console is gone.
    await popup.goto(`${origin}/?lang=en`);
    expect(await popup.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY)).toBeNull();
    await popup.close();
    // The console's own tab keeps its session and its next API call succeeds.
    expect(await page.evaluate((key) => sessionStorage.getItem(key), TOKEN_KEY)).toBe(token);
    await page.reload();
    await expect(page.locator('nav a[aria-current="page"]', { hasText: /^Canvas$/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("did not accept this link")).toHaveCount(0);
  });

  test("Edit myself: pause with the marker, banner, the user's edit applies while paused, Done resumes", async ({
    page,
  }) => {
    const project = "film-2";
    await openCanvas(page, project);
    await page.getByRole("button", { name: "More editing table options" }).click();
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("menuitem", { name: "Edit myself (pause agent)" }).click(),
    ]);
    // The opener shows the pause.
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible({ timeout: 30_000 });
    const control = () =>
      JSON.parse(
        readFileSync(path.join(root, "public/projects", project, "pipeline/session/control.json"), "utf8"),
      ) as {
        state: string;
        reason?: string;
        answer?: string;
      };
    expect(control()).toMatchObject({
      state: "paused",
      reason: expect.stringMatching(/^editing-table/),
      answer: "I am editing the timeline myself. Pause the agent until I hand the project back.",
    });

    // The editing table: the banner, then an edit of the user's own through the form.
    await popup.setViewportSize({ width: 1280, height: 900 });
    await expect(popup.getByRole("region", { name: "The agent is paused while you edit" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(popup.locator("#identity")).toContainText(`${project} · revision 0`);
    await axe(popup);
    await popup.screenshot({ path: path.join(QA, "editing-banner-server-1280.png"), fullPage: true });
    await popup.locator('.clip[title^="proof ·"]').click();
    await popup.locator("#edit-start").fill("90");
    await popup.locator("#prepare").click();
    await expect(popup.locator("#status")).toHaveText("Ready");
    await popup.locator("#apply").click();
    await expect(popup.locator("#identity")).toHaveText(`${project} · revision 1 · 120 frames`);

    await popup.getByRole("button", { name: "Done — hand back to the agent" }).click();
    await expect(popup.getByRole("region", { name: "The agent is paused while you edit" })).toHaveCount(0, {
      timeout: 30_000,
    });
    expect(control()).toMatchObject({
      state: "running",
      answer: "I finished editing the timeline myself at revision 1. Continue from there.",
    });
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 15_000 });
    await popup.close();
  });
});

test.describe("fixture mode", () => {
  for (const theme of ["dark", "light"] as const)
    for (const width of [1280, 390])
      test(`header actions and banner ${theme} ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`./?fixture=view-film-build&lang=en&theme=${theme}`);
        await expect(page.getByRole("button", { name: "Editing table", exact: true })).toBeVisible();
        await expect(page.locator("[data-studio-open]").first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal page scroll").toBe(
          width,
        );
        await axe(page);
        await page.screenshot({ path: path.join(QA, `editing-header-${theme}-${width}.png`) });

        // The editing table in a new tab keeps the fixture, language and theme.
        const [popup] = await Promise.all([
          page.waitForEvent("popup"),
          page.getByRole("button", { name: "Editing table", exact: true }).click(),
        ]);
        expect(popup.url()).toContain(`?fixture=view-film-build&lang=en&theme=${theme}#/projects/promo-acme/timeline`);
        await expect(popup.locator('nav a[aria-current="page"]', { hasText: /^Timeline$/ })).toBeVisible();
        await popup.close();

        // Edit myself: this page's in-memory fixture pauses; its Timeline page shows the banner.
        await page.getByRole("button", { name: "More editing table options" }).click();
        // axe once the menu's enter transition has finished.
        await page.waitForFunction(() => {
          const menu = document.querySelector('[role="menu"]');
          return !!menu && getComputedStyle(menu).opacity === "1";
        });
        await axe(page);
        const [second] = await Promise.all([
          page.waitForEvent("popup"),
          page.getByRole("menuitem", { name: "Edit myself (pause agent)" }).click(),
        ]);
        await second.close();
        await page.evaluate(() => (location.hash = "#/projects/promo-acme/timeline"));
        const banner = page.getByRole("region", { name: "The agent is paused while you edit" });
        await expect(banner).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal page scroll").toBe(
          width,
        );
        await axe(page);
        await page.screenshot({ path: path.join(QA, `editing-banner-${theme}-${width}.png`) });
        await banner.getByRole("button", { name: "Done — hand back to the agent" }).click();
        await expect(banner).toHaveCount(0);
      });

  test("Studio: the header button opens the server's URL in a new tab", async ({ page, context }) => {
    await context.route("http://127.0.0.1:3000/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Studio</title><p>Studio</p>" }),
    );
    await page.goto("./?fixture=view-film-build&lang=en");
    const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator("[data-studio-open]").first().click()]);
    await expect.poll(() => popup.url()).toBe("http://127.0.0.1:3000/Film");
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    await popup.close();
  });

  test("Studio: a campaign has no header button", async ({ page }) => {
    await page.goto("./?fixture=view-campaign&lang=en");
    await expect(page.getByRole("button", { name: "Editing table", exact: true })).toBeVisible();
    await expect(page.locator("[data-studio-open]")).toHaveCount(0);
  });
});
