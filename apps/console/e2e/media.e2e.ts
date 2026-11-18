/**
 * Media viewer end-to-end checks (RFC 0004 WP6, US6/US11) in fixture mode (RUN_CONSOLE_E2E=1 pnpm console:e2e).
 * Fixture mode has no server, so the test makes a tiny real H.264 clip and a JPEG frame with ffmpeg in a temp folder
 * and answers `/media/…` (with HTTP range requests, as the console server does) and `/thumb/…` through Playwright
 * routes. It plays, seeks, steps frames, draws a region and reads the emitted FrameComment, under the strict CSP, with
 * screenshots at 1280 and 390 px into out/qa/console/ and axe.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { FrameCommentSchema } from "../../../src/types/console";

test.skip(process.env.RUN_CONSOLE_E2E !== "1", "set RUN_CONSOLE_E2E=1 to run the console end-to-end tests");

const QA = path.resolve(process.cwd(), "out/qa/console");
const NONCE = "e2eNonce0123456789abcdef";
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  `style-src 'self' 'nonce-${NONCE}'`,
  "img-src 'self'",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

let dir = "";
let clip: Buffer;
let frame: Buffer;
let track: Buffer;

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test.beforeAll(() => {
  test.skip(!hasFfmpeg(), "ffmpeg is needed to make the test clip (brew install ffmpeg)");
  dir = mkdtempSync(path.join(os.tmpdir(), "console-media-e2e-"));
  const mp4 = path.join(dir, "clip.mp4");
  const jpg = path.join(dir, "frame.jpg");
  // 3 s, 30 fps, 9:16 like the fixture's endings; keyframe every 10 frames so seeks land quickly
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=270x480:rate=30:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "10", "-movflags", "+faststart",
    mp4,
  ]); // prettier-ignore
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-i", mp4, "-frames:v", "1", "-vf", "scale=160:-2", jpg]);
  const mp3 = path.join(dir, "track.mp3");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:duration=3:beep_factor=4",
    mp3,
  ]);
  track = readFileSync(mp3);
  clip = readFileSync(mp4);
  frame = readFileSync(jpg);
});

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Answers /media with range support (206 + Content-Range, as Chromium needs for seeking) and /thumb with a JPEG. */
async function serveMedia(page: Page) {
  await page.route("**/media/**", async (route) => {
    const url = new URL(route.request().url());
    const isVideo = url.pathname.endsWith(".mp4");
    const isAudio = url.pathname.endsWith(".mp3");
    const body = isVideo ? clip : isAudio ? track : frame;
    const type = isVideo ? "video/mp4" : isAudio ? "audio/mpeg" : "image/jpeg";
    const range = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers()["range"] ?? "");
    if (!range) {
      await route.fulfill({
        status: 200,
        body,
        headers: { "content-type": type, "accept-ranges": "bytes", "content-length": String(body.length) },
      });
      return;
    }
    const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    const slice = body.subarray(start, end + 1);
    await route.fulfill({
      status: 206,
      body: slice,
      headers: {
        "content-type": type,
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${body.length}`,
        "content-length": String(slice.length),
      },
    });
  });
  await page.route("**/thumb/**", (route) =>
    route.fulfill({ status: 200, body: frame, headers: { "content-type": "image/jpeg" } }),
  );
}

/** The console page under the server's strict CSP; returns a collector of violations. */
async function strictCsp(page: Page) {
  await page.route(
    (url) => url.pathname === "/" || url.pathname.endsWith("/index.html"),
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("<head>", `<head><meta name="csp-nonce" content="${NONCE}">`);
      await route.fulfill({ response, body, headers: { ...response.headers(), "content-security-policy": CSP } });
    },
  );
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __csp: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations
    .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
    .map((violation) => ({
      id: violation.id,
      nodes: violation.nodes.map((node) => node.target.join(" ")).slice(0, 5),
    }));
}

const frameOf = async (viewer: Locator) =>
  Number(await viewer.locator("output[data-frame]").getAttribute("data-frame"));
const timeOf = (viewer: Locator) => viewer.locator("video").evaluate((video: HTMLVideoElement) => video.currentTime);

async function openCompare(page: Page) {
  await page.goto("./?fixture=view-film-build&lang=en&theme=dark");
  const compare = page.getByRole("region", { name: "Compare Ending A and Ending B" });
  await compare.scrollIntoViewIfNeeded();
  const viewer = compare.locator("figure[data-media-slot='video']").first();
  await expect
    .poll(() => viewer.locator("video").evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThanOrEqual(1);
  return { compare, viewer };
}

test("plays, seeks, steps frames, draws a region and emits the comment (strict CSP)", async ({ page }) => {
  const violations = await strictCsp(page);
  await serveMedia(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const { viewer } = await openCompare(page);

  // play: the clock moves, then pause
  await viewer.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => timeOf(viewer), { timeout: 5000 }).toBeGreaterThan(0.3);
  await viewer.getByRole("button", { name: "Pause" }).click();
  await expect(viewer.getByRole("button", { name: "Play" })).toBeVisible();

  // seek from the frame strip: the fifth of eight frames sits near 1.7 s
  await viewer.getByRole("list", { name: "Frames of Ending A" }).getByRole("button").nth(4).click();
  await expect.poll(() => timeOf(viewer)).toBeCloseTo(1.7, 1);
  await expect.poll(() => frameOf(viewer)).toBe(51);

  // step: buttons and keys, one frame and one second
  await viewer.getByRole("button", { name: /Next frame/ }).click();
  await expect.poll(() => frameOf(viewer)).toBe(52);
  await viewer.locator("video").focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => frameOf(viewer)).toBe(51);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(() => frameOf(viewer)).toBe(21);
  await expect(viewer.locator("output[data-frame]")).toContainText("00:00:21");

  // large view: comment on the frame with a dragged region
  await viewer.getByRole("button", { name: "Open large view" }).click();
  const dialog = page.getByRole("dialog", { name: "Large view of Ending A" });
  const full = dialog.locator("figure[data-media-slot='video']");
  await expect
    .poll(() => full.locator("video").evaluate((video: HTMLVideoElement) => video.readyState))
    .toBeGreaterThanOrEqual(1);
  await full.getByRole("button", { name: /Next frame/ }).click();
  await expect.poll(() => frameOf(full)).toBe(1);
  await full.getByRole("button", { name: "Comment on this frame" }).click();
  const overlay = full.locator("[data-region-overlay]");
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4, { steps: 5 });
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, { steps: 5 });
  await page.mouse.up();
  await expect(full.locator("[data-region-rect]")).toBeVisible();
  const form = full.getByRole("form", { name: /Comment on frame 1/ });
  expect(Number(await form.getByRole("spinbutton", { name: "Left" }).inputValue())).toBeCloseTo(0.25, 1);
  expect(Number(await form.getByRole("spinbutton", { name: "Width" }).inputValue())).toBeCloseTo(0.5, 1);
  await form.getByRole("textbox", { name: "Comment" }).fill("The logo is too small here");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(250); // past the dialog's enter transition
    await page.screenshot({ path: path.join(QA, `media-comment-dark-${width}.png`) });
  }
  expect(await axe(page)).toEqual([]);
  await form.getByRole("button", { name: "Add comment" }).click();

  const emitted = full.locator("[data-frame-comment]");
  await expect(emitted).toBeVisible();
  const comment = FrameCommentSchema.parse(JSON.parse((await emitted.getAttribute("data-frame-comment"))!));
  expect(comment.frame).toBe(1);
  expect(comment.text).toBe("The logo is too small here");
  expect(comment.media).toMatchObject({ root: "out", path: "endings/ending-a.mp4" });
  expect(comment.region!.x).toBeCloseTo(0.25, 1);
  expect(comment.region!.y).toBeCloseTo(0.25, 1);
  expect(comment.region!.w).toBeCloseTo(0.5, 1);
  expect(comment.region!.h).toBeCloseTo(0.25, 1);

  // audio: the waveform is decoded from fetch() bytes (no blob: URL) and drawn on the canvas
  await page.keyboard.press("Escape");
  const assets = page.getByRole("button", { name: /^Assets/ });
  if ((await assets.getAttribute("aria-expanded")) === "false") await assets.click();
  await page.getByRole("tab", { name: "Grid" }).click();
  await page.getByRole("button", { name: "Open track-02.mp3" }).click();
  const waveform = page.getByRole("img", { name: "Waveform of track-02.mp3" });
  await expect(waveform).toBeVisible();
  await expect
    .poll(() =>
      waveform.evaluate((canvas: HTMLCanvasElement) => {
        const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 0) painted++;
        return painted;
      }),
    )
    .toBeGreaterThan(100);

  expect(await violations()).toEqual([]);
});

for (const theme of ["dark", "light"] as const) {
  for (const width of [1280, 390]) {
    test(`media viewer ${theme} ${width}px: screenshot and accessibility`, async ({ page }) => {
      await serveMedia(page);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`./?fixture=view-film-build&lang=en&theme=${theme}`);
      const compare = page.getByRole("region", { name: "Compare Ending A and Ending B" });
      await compare.scrollIntoViewIfNeeded();
      await expect(compare.locator("video").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal page scroll").toBe(width);
      await compare.screenshot({ path: path.join(QA, `media-compare-${theme}-${width}.png`) });
      // the wipe
      await compare.getByRole("button", { name: "Wipe" }).click();
      const wipe = compare.getByRole("slider", { name: "Wipe position" });
      await wipe.focus();
      await page.keyboard.press("Home");
      for (let step = 0; step < 3; step++) await page.keyboard.press("PageUp");
      await expect(compare.locator("video").nth(1)).toHaveCSS("clip-path", "inset(0px 0px 0px 30%)");
      await compare.screenshot({ path: path.join(QA, `media-wipe-${theme}-${width}.png`) });
      expect(await axe(page)).toEqual([]);
      // a thumbnail opens the large viewer with render facts and the Studio launcher (the fixture's Studio URL)
      await page.getByRole("button", { name: "Open Scene 3" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Large view of Scene 3" });
      await expect(dialog.locator("[data-stale]")).toContainText("Stale");
      await page
        .context()
        .route("http://127.0.0.1:3000/**", (route) =>
          route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Studio</title>" }),
        );
      const [studio] = await Promise.all([
        page.waitForEvent("popup"),
        dialog.getByRole("button", { name: "Open in Remotion Studio" }).click(),
      ]);
      await expect.poll(() => studio.url()).toBe("http://127.0.0.1:3000/Film");
      await studio.close();
      await expect(dialog.getByText("Studio is open in a new tab.")).toBeVisible();
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(QA, `media-viewer-${theme}-${width}.png`) });
      expect(await axe(page)).toEqual([]);
    });
  }
}
