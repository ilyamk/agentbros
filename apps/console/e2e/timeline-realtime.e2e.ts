/**
 * Timeline offline realtime editor end-to-end (RFC 0004 WP13d; RU-R, RU-RC, RU-RS of
 * the review:ui parity checklist), the console replacement of review:ui's review-realtime-browser,
 * realtime-derive-browser, review-realtime-channel-browser and realtime-still-draft-browser tests. Unlike the fixture
 * e2e files it runs the real console server in-process on a temporary root (ffmpeg makes the request image and the
 * registered still, as the old tests did) and serves the bundle `vite build` just made, so the WebSocket channel, the
 * one-use ticket and the services are the real ones. Nothing calls a provider. Screenshots at 1280 and 390 px, dark
 * and light, into out/qa/console/; axe on the section; the server's own strict CSP.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { choose, withOptions } from "./select";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const repo = process.cwd();
const QA = path.join(repo, "out/qa/console");
const PROJECT = "demo";

interface Started {
  url: string;
  root: string;
  request: unknown;
  imageSha256: string;
}

let child: ChildProcess | undefined;
let started: Started | undefined;

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  test.skip(!hasFfmpeg(), "ffmpeg is needed to make the request image (brew install ffmpeg)");
  child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(repo, "tests/helpers/console-realtime-e2e-server.ts"),
      path.join(repo, "out/console/dist"),
    ],
    { cwd: repo, stdio: ["pipe", "pipe", "inherit"] },
  );
  const line = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child!.stdout! });
    lines.once("line", resolve);
    child!.once("exit", (code) => reject(new Error(`realtime e2e server exited with ${code}`)));
  });
  started = JSON.parse(line) as Started;
});

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child!.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
});

async function openTimeline(page: Page, query = "lang=en&theme=dark") {
  // No 150 ms enable/disable transitions mid-axe (the console turns them off under reduced motion).
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const w = window as unknown as { __csp?: string[] };
      (w.__csp ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  const [origin, fragment] = started!.url.split("#");
  await page.goto(`${origin}?${query}#${fragment}`);
  await page.waitForFunction(() => !location.hash.includes("token="));
  await page.evaluate((project) => (location.hash = `#/projects/${project}/timeline`), PROJECT);
  await expect(page.locator("#identity")).toContainText(PROJECT);
  return () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

async function axe(page: Page) {
  await page.mouse.move(0, 0); // no hover colour on the button just clicked
  const results = await new AxeBuilder({ page }).include("#timeline-realtime").analyze();
  return results.violations
    .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
    .map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(" ")).slice(0, 5),
    }));
}

const summary = (page: Page) => page.locator("#rt-summary");
const status = (page: Page) => page.locator("#rt-status");

test("offline editor, local channel and still draft over the real console server", async ({ page }) => {
  test.setTimeout(90_000);
  const sockets: string[] = [];
  const posts: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/api/review/${PROJECT}/realtime`))
      posts.push(JSON.parse(request.postData() ?? "{}").action);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const violations = await openTimeline(page);

  // RU-R: closed by default; opening reads; create, add, queue, inspect
  const panel = page.locator("#realtime-panel");
  await expect(panel).not.toHaveAttribute("open");
  await panel.locator("summary").click();
  await withOptions(page, page.locator("#rt-editor"), (options) =>
    expect(options).toHaveText(["published · sequence 4"]),
  );
  await expect(summary(page)).toContainText('"editor": "published"');
  await page.locator("#rt-new-id").fill("draft");
  await page.locator("#rt-create").click();
  await expect(summary(page)).toContainText('"sequence": 0');
  await expect(status(page)).toHaveText("Recorded once. No provider execution.");
  await page.locator("#rt-request").fill(JSON.stringify(started!.request));
  await page.locator("#rt-add").click();
  await expect(summary(page)).toContainText('"sequence": 1');
  const card = page.locator('[data-revision="first"]');
  await expect(card).toContainText("first · draft");
  await expect(card.locator('[data-action="select"]')).toBeDisabled();
  await card.locator('[data-action="inspect"]').click();
  await expect(page.locator("#rt-request-detail")).toContainText('"revisionId": "first"');

  // RU-R10: derive a new local draft from the pinned request
  await card.locator('[data-action="derive"]').click();
  await expect(page.locator("#rt-derive-fields")).toBeEnabled();
  await expect(page.locator("#rt-derive-source")).toHaveValue("first");
  await page.locator("#rt-derive-revision").fill("derived");
  await page.locator("#rt-derive-session").fill("derived-session");
  await page.locator("#rt-derive-prompt").fill("A calmer blue");
  await page.locator("#rt-derive-bound").fill("0.25");
  await page.locator("#rt-derive-save").click();
  await expect(page.locator('[data-revision="derived"]')).toContainText("derived · draft");
  await expect(summary(page)).toContainText('"sequence": 2');

  // RU-R08/R11/R12: queue, handoff, recover (planning liability only)
  await page.locator('[data-revision="first"] [data-action="queue"]').click();
  await expect(page.locator('[data-revision="first"]')).toContainText("first · queued");
  await expect(page.locator("#rt-handoff")).toBeEnabled();
  await page.locator("#rt-handoff").click();
  await expect(page.locator('[data-revision="first"]')).toContainText("first · in-flight");
  await page.locator("#rt-recover").click();
  await expect(page.locator('[data-revision="first"]')).toContainText("first · uncertain");
  await expect(page.locator("#rt-handoff")).toBeDisabled();

  // RU-RC: open the channel, inspect, close; the ticket never appears in the URL
  await page.locator("#rt-channel-session").fill("local-1");
  await page.locator("#rt-channel-open").click();
  await expect(page.locator("#rt-channel-summary")).toContainText('"outcome": "ok"');
  await expect(page.locator("#rt-create")).toBeDisabled();
  await expect(page.locator("#rt-add-file")).toBeDisabled();
  await expect(page.locator("#rt-still-refresh")).toBeDisabled();
  await page.locator("#rt-channel-status").click();
  await expect(page.locator("#rt-channel-summary")).toContainText('"currentSequence": 5');
  await page.locator("#rt-channel-close").click();
  await expect(page.locator("#rt-channel-summary")).toHaveText(
    "Local channel closed; inspect before another explicit action",
  );
  expect(sockets).toHaveLength(1);
  expect(sockets[0]).toMatch(new RegExp(`/api/review/${PROJECT}/realtime/channel$`));

  // RU-RS: metadata-only listing, one add-asset
  await page.locator("#rt-still-refresh").click();
  await expect(page.locator("#rt-still-summary")).toContainText('"metadataOnly": true');
  await page.locator("#rt-still-source").click();
  const option = page.locator('[data-slot="select-content"] [role="option"]').nth(1);
  await expect(option).toContainText("image/png · 32×32 · sha256:");
  await option.click();
  await expect(page.locator("#rt-still-fields")).toBeEnabled();
  await page.locator("#rt-still-revision").fill("still-1");
  await page.locator("#rt-still-session").fill("still-session");
  await page.locator("#rt-still-prompt").fill("From the still");
  await page.locator("#rt-still-seed").fill("4");
  await page.locator("#rt-still-bound").fill("0.2");
  await page.locator("#rt-still-save").click();
  await expect(status(page)).toHaveText("Saved one new offline still draft. No queue, handoff or provider execution.");
  await expect(page.locator("#rt-still-summary")).toContainText('"physicalDecodeVerified": false');
  await expect(page.locator('[data-revision="still-1"]')).toContainText("still-1 · draft");

  // RU-R15/R16: select the completed revision; the SHA-verified frame loads through the session cookie.
  await choose(page, page.locator("#rt-editor"), "published");
  const published = page.locator('[data-revision="pub"]');
  await expect(published).toContainText("pub · complete");
  await expect(published).toContainText("Published manifest SHA256 ");
  await expect(page.locator("#rt-preview")).toContainText("No verified preview is selected.");
  await published.locator('[data-action="select"]').click();
  const frame = page.locator("#rt-preview img").first();
  await expect(frame).toHaveAttribute("src", /\/api\/review\/demo\/file\?path=%40realtime%2F/);
  await expect.poll(() => frame.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(32);
  await expect(page.locator("#rt-preview figcaption").first()).toContainText(/^Original SHA256 [a-f0-9]{64}$/);
  await expect(summary(page)).toContainText('"selected": "pub"');

  // Each action was posted exactly once (no replay).
  expect(posts).toEqual(["create", "add", "derive", "queue", "handoff", "recover", "add-asset", "select"]);
  expect(await violations()).toEqual([]);
  expect(await axe(page)).toEqual([]);

  mkdirSync(QA, { recursive: true });
  const section = page.locator("#timeline-realtime");
  await section.screenshot({ path: path.join(QA, "timeline-realtime-1280-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
  await section.screenshot({ path: path.join(QA, "timeline-realtime-390-dark.png") });
});

test("light theme and Russian at 1280 and 390 px", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const violations = await openTimeline(page, "lang=ru&theme=light");
  await page.locator("#realtime-panel summary").click();
  await expect(summary(page)).not.toBeEmpty();
  await page.locator("#rt-new-id").fill("ru-editor");
  await page.locator("#rt-create").click();
  await expect(summary(page)).toContainText('"editor": "ru-editor"');
  await expect(status(page)).toHaveText("Записано один раз. Провайдер не запускался.");
  await expect(page.getByRole("button", { name: "Открыть локальный канал" })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  mkdirSync(QA, { recursive: true });
  const section = page.locator("#timeline-realtime");
  await section.screenshot({ path: path.join(QA, "timeline-realtime-1280-light-ru.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
  await section.screenshot({ path: path.join(QA, "timeline-realtime-390-light-ru.png") });
  expect(await violations()).toEqual([]);
  // the registered still stays byte-identical (no upload, decode or rewrite)
  const still = path.join(started!.root, `public/projects/${PROJECT}/assets/imported/${started!.imageSha256}.png`);
  expect(createHash("sha256").update(readFileSync(still)).digest("hex")).toBe(started!.imageSha256);
});
