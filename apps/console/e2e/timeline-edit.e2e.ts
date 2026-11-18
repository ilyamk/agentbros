/**
 * Timeline edit section end to end (RFC 0004 WP13b; parity rows RU-T, RU-P06, RU-K of
 * the review:ui parity checklist), run with RUN_CONSOLE_E2E=1 pnpm console:e2e. Unlike the fixture-mode
 * suites this one starts a real console server (tests/helpers/console-timeline-server.ts, a tsx child process) over a temporary checkout
 * with initialized timeline journals, serving the bundle the Playwright web server just built (out/console/dist), so every dry-run, apply,
 * undo, redo, group move and 409 goes through the unchanged ReviewService and TimelineEditStore. It replaces the
 * review:ui browser tests review-ui-browser, review-pointer-browser, visual-track-transfer-browser and
 * review-group-move-browser for the console. Screenshots at 1280 and 390 px go to out/qa/console/; axe and the
 * strict CSP are checked on the section.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { choose } from "./select";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const QA = path.resolve(process.cwd(), "out/qa/console");
const DIST = path.resolve(process.cwd(), "out/console/dist");
const r = (num: number, den = 1) => ({ num, den });

/** A fresh project per test (`film-1`, `film-2`, …, made by the server helper), so each starts at revision 0. */
let PROJECT = "";
let made = 0;
let root = "";
let child: ChildProcess | undefined;
let origin = "";
let token = "";

test.beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "console-timeline-e2e-"));
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
      "12",
    ],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_HOOKS: "off" },
    },
  );
  const line = await new Promise<string>((resolve, reject) => {
    child!.once("exit", (code) => reject(new Error(`timeline server exited (${code})`)));
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

test.beforeEach(() => {
  PROJECT = `film-${++made}`;
});

/** An edit made elsewhere (another tab, an agent): the review mutate route with the session token. */
async function editElsewhere(page: Page, expectedRevision: number, command: unknown) {
  const response = await page.request.post(`${origin}/api/review/${PROJECT}/mutate`, {
    headers: { "x-console-token": token, origin, "content-type": "application/json" },
    data: JSON.stringify({ action: "edit", expectedRevision, command }),
  });
  expect(response.status()).toBe(200);
}

/** Opens the timeline view; collects CSP violations from the page. */
async function openTimeline(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const w = window as unknown as { __csp?: string[] };
      (w.__csp ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  await page.goto(`${origin}/#token=${token}&project=${PROJECT}`);
  await page.waitForURL(/#\/projects\//);
  await page.evaluate((project) => (location.hash = `#/projects/${project}/timeline`), PROJECT);
  await expect(page.locator("#identity")).toContainText(`${PROJECT} · revision`);
  return async () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

const revision = (page: Page, n: number) =>
  expect(page.locator("#identity")).toHaveText(`${PROJECT} · revision ${n} · 120 frames`);
const clipNamed = (page: Page, id: string) => page.locator(`.clip[title^="${id} ·"]`);
const dryRun = async (page: Page) => JSON.parse((await page.locator("#dry-run").textContent()) ?? "null");
const ready = (page: Page) => expect(page.locator("#status")).toHaveText("Ready");

async function box(locator: Locator) {
  // Centre it only when it is hidden: the sticky app bar covers the top of the viewport, where
  // scrollIntoViewIfNeeded may leave it, and an extra scroll would move boxes measured before.
  await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const bar = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
    if (rect.top < bar || rect.bottom > innerHeight) element.scrollIntoView({ block: "center", inline: "nearest" });
  });
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

test("form edit: prepare, apply, undo and redo through the real journal (RU-T01–T05, T12–T15)", async ({ page }) => {
  const violations = await openTimeline(page);
  await revision(page, 0);
  await expect(page.locator("#board .card")).toHaveCount(3);
  await expect(page.locator("#undo")).toBeDisabled();
  await expect(page.locator("#redo")).toBeDisabled();
  await clipNamed(page, "proof").click();
  await expect(page.locator("#selection")).toHaveText("visual / proof · scene:proof");
  await expect(page.locator("#edit-start")).toHaveValue("60");
  await page.locator("#edit-start").fill("90");
  await page.locator("#prepare").click();
  await ready(page);
  expect(JSON.parse(await page.locator("#command").inputValue())).toMatchObject({ type: "move", start: r(90) });
  expect(await dryRun(page)).toMatchObject({ revision: 0, durationInFrames: 120 });
  await page.locator("#apply").click();
  await revision(page, 1);
  await expect(page.locator("#dry-run")).toHaveText("Applied with revision readback.");
  await expect(page.locator(".clip[title='proof · scene:proof · 90 → 120']")).toBeVisible();
  await page.locator("#timeline-edit details summary").click();
  await expect(page.locator("#journal")).toContainText('"type": "move"');
  // Undo and redo are journal entries too: each is a new revision.
  await page.locator("#undo").click();
  await revision(page, 2);
  await expect(page.locator(".clip[title='proof · scene:proof · 60 → 90']")).toBeVisible();
  await page.locator("#redo").click();
  await revision(page, 3);
  await page.locator("#edit-start").fill("4.5");
  await page.locator("#prepare").click();
  await expect(page.locator("#status")).toHaveText(
    "Frame/rate values must be integers. Use advanced rational commands for fractions.",
  );
  expect(await violations()).toEqual([]);
});

test("pointer drag: preview, release validates only, then explicit apply; Escape cancels (RU-T16, K01, K03, K06)", async ({
  page,
}) => {
  await openTimeline(page);
  const proof = clipNamed(page, "proof");
  const b = await box(proof);
  const lane = await box(page.locator('.lane[data-track-id="visual"]'));
  const perFrame = lane.width / 120;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 10 * perFrame, b.y + b.height / 2, { steps: 4 });
  await expect(page.locator("#dry-run")).toHaveText(
    "Pointer preview only. Release to validate, then apply explicitly.",
  );
  await expect(proof).toHaveClass(/dragging/);
  await page.locator("#apply").dispatchEvent("click");
  await expect(page.locator("#status")).toHaveText("Finish or cancel pointer interaction before applying");
  await page.mouse.up();
  await ready(page);
  const command = JSON.parse(await page.locator("#command").inputValue());
  expect(command).toMatchObject({ type: "move", trackId: "visual", clipId: "proof" });
  expect(command.start.num / command.start.den).toBeGreaterThan(60);
  await revision(page, 0);
  await page.locator("#apply").click();
  await revision(page, 1);

  // A second drag cancelled by Escape restores the clip and clears the command.
  const c = await box(proof);
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 - 20 * perFrame, c.y + c.height / 2, { steps: 4 });
  await page.keyboard.press("Escape");
  await expect(proof).not.toHaveClass(/dragging/);
  await page.mouse.up();
  await expect(page.locator("#command")).toHaveValue("");
  await expect(page.locator("#dry-run")).toHaveText("Proposal cancelled; prepare a new edit.");
  await revision(page, 1);
});

test("drop on another visual lane proposes a transfer; edge drag trims; resize cancels (RU-T17, T18, K02, K04, K05)", async ({
  page,
}) => {
  await openTimeline(page);
  const hook = clipNamed(page, "hook");
  await box(hook);
  const broll = await box(page.locator('.lane[data-track-id="broll"]'));
  // Measured after the lane's scroll, which may have moved the clip.
  const h = (await hook.boundingBox())!;
  const perFrame = broll.width / 120;
  // Grab the middle (15 frames in), drop at frame 90 of the other lane: start 75 on broll.
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(broll.x + 90 * perFrame, broll.y + broll.height / 2, { steps: 6 });
  await page.mouse.up();
  await ready(page);
  const transfer = JSON.parse(await page.locator("#command").inputValue());
  expect(transfer).toMatchObject({ type: "transfer", trackId: "visual", clipId: "hook", targetTrackId: "broll" });
  await page.locator("#apply").click();
  await revision(page, 1);
  await expect(page.locator('.lane[data-track-id="broll"] .clip[title^="hook ·"]')).toBeVisible();

  const end = clipNamed(page, "proof").locator(".trim-end");
  await expect(end).toHaveAttribute("title", "Trim end inward; keyboard: use Trim source form");
  const e = await box(end);
  await page.mouse.move(e.x + e.width / 2, e.y + e.height / 2);
  await page.mouse.down();
  await page.mouse.move(e.x + e.width / 2 - 10 * perFrame, e.y + e.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator("#dry-run")).toContainText("proposedHash");
  await ready(page);
  expect(JSON.parse(await page.locator("#command").inputValue())).toMatchObject({ type: "trim", clipId: "proof" });
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(page.locator("#command")).toHaveValue("");
});

test("group move prepares 2–24 visual clips and applies one reversible edit (RU-P06, K08)", async ({ page }) => {
  await openTimeline(page);
  await expect(page.locator("#group-prepare")).toBeDisabled();
  await page.getByLabel("Group visual / hook").check();
  await page.getByLabel("Group visual / proof").check();
  await expect(page.locator("#group-selection")).toHaveText("2 / 24 selected · visual / hook, visual / proof");
  await page.locator("#group-prepare").click();
  await ready(page);
  expect(await dryRun(page)).toMatchObject({ groupMembers: 2, revision: 0 });
  await page.locator("#group-num").fill("15");
  await expect(page.locator("#command")).toHaveValue("");
  await page.locator("#group-prepare").click();
  await ready(page);
  await page.locator("#apply").click();
  await revision(page, 1);
  await expect(page.locator("#group-selection")).toHaveText("0 / 24 selected · ");
  await expect(page.locator(".clip[title='proof · scene:proof · 75 → 105']")).toBeVisible();
});

test("a revision changed elsewhere is a 409: refresh, notice, no replay (G2, RU-T13)", async ({ page }) => {
  await openTimeline(page);
  await clipNamed(page, "proof").click();
  await page.locator("#edit-start").fill("90");
  await page.locator("#prepare").click();
  await ready(page);
  await editElsewhere(page, 0, { type: "move", trackId: "visual", clipId: "hook", start: r(1) });
  await page.locator("#apply").click();
  await expect(page.locator("#status")).toHaveAttribute("data-kind", "conflict");
  await expect(page.locator("#conflict-notice")).toContainText("no automatic replay");
  await revision(page, 1);
  await expect(page.locator("#command")).toHaveValue("");
});

test("specialized prepares send bodies the strict server schemas accept (RU-P01–P05, RU-AU01/02)", async ({ page }) => {
  await openTimeline(page);
  const zod = /unrecognized|invalid_type|Required|Expected (number|string|object)/i;
  const cases: [string, string][] = [
    ["hook", "authored-copy"],
    ["hook", "visual-reframe"],
    ["hook", "visual-remove"],
    ["proof", "visual-slip"],
    ["proof", "visual-split"],
    ["bed", "audio-position"],
    ["bed", "audio-trim"],
  ];
  for (const [clipId, operation] of cases) {
    await clipNamed(page, clipId).click();
    await choose(page, page.locator("#operation"), operation);
    if (operation === "authored-copy") await choose(page, page.locator("#copy-headline-mode"), "set");
    if (operation === "audio-position") await page.locator("#audio-position-num").fill("15");
    if (operation === "audio-trim") await page.locator("#audio-source-end-num").fill("90");
    await page.locator("#prepare").click();
    await expect(page.locator("#status")).not.toHaveText("Working…");
    const text = (await page.locator("#status").textContent()) ?? "";
    // The fixture's scene clips have no imported originals, so most routes refuse on domain grounds; what matters is
    // that none refuses the request shape.
    expect(text, `${operation}: ${text}`).not.toMatch(zod);
  }
  await revision(page, 0);
});

test("split and remove of an imported image: prepare, apply, undo (RU-P03, RU-P05, defect 2)", async ({ page }) => {
  await openTimeline(page);
  await clipNamed(page, "hook").click();
  await choose(page, page.locator("#operation"), "visual-split");
  // The default cut is the clip's middle frame, which the server accepts (review:ui defaulted to the start).
  await expect(page.locator("#split-at-num")).toHaveValue("15");
  await page.locator("#prepare").click();
  await ready(page);
  expect(await dryRun(page)).toMatchObject({ visualSplit: true, revision: 0 });
  expect(JSON.parse(await page.locator("#command").inputValue())).toMatchObject({
    type: "split",
    at: r(15),
    newClipId: "hook-right",
  });
  await page.locator("#apply").click();
  await revision(page, 1);
  await expect(clipNamed(page, "hook-right")).toBeVisible();

  await clipNamed(page, "hook-right").click();
  await choose(page, page.locator("#operation"), "visual-remove");
  await page.locator("#prepare").click();
  await ready(page);
  expect(await dryRun(page)).toMatchObject({ visualRemove: true, gapRetained: true, durationInFrames: 120 });
  await page.locator("#apply").click();
  await revision(page, 2);
  await expect(clipNamed(page, "hook-right")).toHaveCount(0);
  await page.locator("#undo").click();
  await revision(page, 3);
  await expect(clipNamed(page, "hook-right")).toBeVisible();
});

test("screenshots at 1280 and 390 px, axe on the edit section", async ({ page }) => {
  await openTimeline(page, 1280);
  // The hook's selection line carries a full sha256 asset id: it must wrap at 390 px, not widen the page.
  await clipNamed(page, "hook").click();
  for (const width of [1280, 390]) {
    // A resize cancels the proposal (RU-K02): prepare after it.
    await page.setViewportSize({ width, height: 900 });
    await page.locator("#prepare").click();
    await expect(page.locator("#dry-run")).toContainText("proposedHash");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.locator("#timeline-edit").screenshot({ path: path.join(QA, `timeline-edit-${width}.png`) });
    await page.screenshot({ path: path.join(QA, `timeline-edit-page-${width}.png`), fullPage: true });
    const axe = await new AxeBuilder({ page }).include("#timeline-edit").analyze();
    const serious = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  }
});
