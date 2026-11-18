/**
 * Timeline review sections end to end (RFC 0004 WP13c; RUN_CONSOLE_E2E=1 pnpm console:e2e): a real console server
 * (tests/helpers/console-timeline-server.ts, a tsx child process) over a temporary checkout, plus one project this test
 * seeds (a scene clip, a registered PNG, an injected HTML report, a chapter manifest, a rendered landscape.mp4), so every request goes
 * through the unchanged review services. It re-points the review:ui browser tests of these areas (Appendix A of
 * the review:ui parity checklist): review-ui-browser (snapshot, compare, choose, asset search, report
 * injection, `@out/landscape.mp4`) and review-chapters-browser. Screenshots at 1280 and 390 px go to out/qa/console/;
 * axe runs at both widths, and the strict CSP is checked.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { choose, withOptions } from "./select";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const QA = path.resolve(process.cwd(), "out/qa/console");
const DIST = path.resolve(process.cwd(), "out/console/dist");
const PROJECT = "chaptered";
const r = (num: number) => ({ num, den: 1 });

let root = "";
let child: ChildProcess | undefined;
let server: { origin: string; token: string } | undefined;

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  test.skip(!hasFfmpeg(), "ffmpeg is needed for the seeded image and render (brew install ffmpeg)");
  root = mkdtempSync(path.join(os.tmpdir(), "console-timeline-review-e2e-"));
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
      "1",
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
  server = JSON.parse(line) as { origin: string; token: string };
  // The shared helper's projects have no scene payloads, which chapter planning needs; seed one more project
  // (review state is read per request, so it may land after the server started), as tests/helpers/review-chapters.ts
  // does, plus a registered PNG, an injected HTML report and a chapter manifest.
  const seed = `
    const [{ TimelineEditStore }, { importAsset }] = await Promise.all([
      import(${JSON.stringify(path.resolve(process.cwd(), "src/lib/timeline-ir/store.ts"))}),
      import(${JSON.stringify(path.resolve(process.cwd(), "src/lib/assets/registry.ts"))}),
    ]);
    const fs = await import("node:fs"), path = await import("node:path"), child = await import("node:child_process");
    const [root, id] = process.argv.slice(1), project = path.join(root, "public/projects", id), r = (num) => ({ num, den: 1 });
    fs.mkdirSync(path.join(project, "pipeline"), { recursive: true });
    const scene = { id: "hook", text: "", headline: "Lesson", visualType: "title", durationInFrames: 90 };
    fs.writeFileSync(path.join(project, "project.json"), JSON.stringify({ name: "Lesson", productName: "Lesson",
      formats: ["landscape", "vertical", "square"], colors: {}, musicVolume: 0, scenes: [scene] }));
    const png = path.join(root, "red.png");
    child.execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=48x32", "-frames:v", "1", png]);
    importAsset({ rootDir: root, projectId: id, sourceFile: png, provenance: { origin: "manual" }, rights: { licence: "synthetic-test" } });
    new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json")).initialize({ version: 1, projectId: id,
      timebase: r(30), tracks: [{ id: "visual", kind: "visual", clips: [{ id: "hook", assetId: "scene:hook", start: r(0),
      source: { start: r(0), end: r(90), timebase: r(30) }, rate: r(1), transition: { kind: "cut" }, captions: [],
      payload: { scene } }] }] });
  `;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", seed, root, PROJECT], {
    cwd: process.cwd(),
    env: { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_HOOKS: "off" },
  });
  const project = path.join(root, "public/projects", PROJECT);
  writeFileSync(path.join(project, "pipeline/qa.md"), "<script>window.hacked=true</script>");
  writeFileSync(
    path.join(project, "pipeline/chapters.json"),
    JSON.stringify({
      version: 1,
      revision: 1,
      chapters: [
        { id: "first", title: "First <script>unsafe</script>", revision: 1, start: r(0), end: r(30) },
        { id: "second", title: "Second", revision: 1, start: r(30), end: r(90) },
      ],
      protectedSpans: [],
    }),
  );
  const out = path.join(root, "out", PROJECT);
  mkdirSync(out, { recursive: true });
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(out, "landscape.mp4"),
  ]); // prettier-ignore
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child.stdin?.end();
    await exited;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).include("[data-testid='timeline-view']").analyze();
  return results.violations
    .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
    .map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(" ")).slice(0, 5),
    }));
}

async function openTimeline(page: Page, theme: "dark" | "light") {
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __csp: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  await page.goto(`${server!.origin}/?lang=en&theme=${theme}#token=${server!.token}&project=${PROJECT}`);
  await page.waitForFunction(() => location.hash.startsWith("#/projects/"));
  await page.evaluate(() => (location.hash = "#/projects/chaptered/timeline"));
  await expect(page.locator("#identity")).toHaveText(/chaptered · revision \d+ · 90 frames/);
}

const status = (page: Page) => page.locator("#status");

test("snapshots, takes, assets, budget, QA and chapters against the real review services", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openTimeline(page, "dark");
  await expect(page.locator("#identity")).toHaveText("chaptered · revision 0 · 90 frames");

  // RU-AS: list, search, kind filter, preview an original through the cookie-authenticated review file route
  await expect(page.locator("#asset-count")).toHaveText("1 / 1 assets");
  await expect(page.locator("#assets")).toContainText("licence synthetic-test");
  await page.locator("#asset-search").fill("nothing-matches");
  await expect(page.locator("#asset-count")).toHaveText("0 / 1 assets");
  await page.locator("#asset-search").fill("");
  await choose(page, page.locator("#asset-kind"), "video");
  await expect(page.locator("#asset-count")).toHaveText("0 / 1 assets");
  await choose(page, page.locator("#asset-kind"), "image");
  await expect(page.locator("#asset-count")).toHaveText("1 / 1 assets");
  await page.locator("#assets").getByRole("button", { name: "Preview original" }).click();
  await expect
    .poll(() => page.locator("#assets img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);

  // RU-B, RU-V: empty ledger never reads as free; no visualisations
  await expect(page.locator("#costs")).toHaveText(
    "No durable operations recorded. This does not imply asset billing is free.",
  );
  await expect(page.locator("#visualisations")).toHaveText("No prepared visualisations mounted.");

  // RU-Q: an HTML report is text, never executed; the render plays through the review file route
  await expect(page.locator("#qa-pin")).toContainText("Current timeline hash: ");
  await page.getByRole("button", { name: "pipeline/qa.md" }).click();
  await expect(page.locator("#report")).toContainText("<script>window.hacked=true</script>");
  expect(await page.evaluate(() => (window as unknown as { hacked?: boolean }).hacked)).toBeUndefined();
  await page.getByRole("button", { name: "@out/landscape.mp4" }).click();
  await expect
    .poll(() => page.locator("#report video").evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThanOrEqual(1);

  // RU-C: inspect, select a chapter (bound manifest SHA), a format change invalidates
  await page.locator("#chapter-refresh").click();
  await expect(page.locator("#chapter-status")).toContainText("manifest SHA");
  await withOptions(page, page.locator("#chapter-selection"), (options) =>
    expect(options.first()).toHaveText("First <script>unsafe</script> · 0/1–30/1"),
  );
  await choose(page, page.locator("#chapter-selection"), "second");
  await expect(page.locator("#chapter-inspection")).toContainText('"id": "second"');
  await choose(page, page.locator("#chapter-format"), "vertical");
  await expect(page.locator("#chapter-status")).toHaveText("Not inspected for this revision");
  await page.locator("#chapter-refresh").click();
  await expect(page.locator("#chapter-status")).toContainText("· vertical · read-only");

  // RU-N: save a snapshot, compare, choose it as the take
  await page.locator("#label").fill("First cut");
  await page.locator("#snapshot").click();
  await expect(page.locator("#snapshots")).toContainText("First cut · revision 0 · ");
  // RU-C04: every display (here the snapshot's state read-back) invalidates the chapter inspection
  await expect(page.locator("#chapter-status")).toHaveText("Not inspected for this revision");
  await choose(page, page.locator("#right"), { index: 1 });
  await page.locator("#compare").click();
  await expect(page.locator("#comparison")).toContainText('"equal": true');
  await page.locator("#actor").fill("E2E reviewer");
  await page.locator("#choose").click();
  await expect(page.locator("#choice")).toContainText('"matchesCurrent": true');
  await expect(page.locator("#choice")).toContainText("Selection is a review choice, not release approval");

  mkdirSync(QA, { recursive: true });
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: path.join(QA, "timeline-review-1280-dark.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#identity")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: path.join(QA, "timeline-review-390-dark.png"), fullPage: true });
  expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([]);
});

test("light theme at 1280 and 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openTimeline(page, "light");
  expect(await axe(page)).toEqual([]);
  mkdirSync(QA, { recursive: true });
  await page.screenshot({ path: path.join(QA, "timeline-review-1280-light.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: path.join(QA, "timeline-review-390-light.png"), fullPage: true });
});
