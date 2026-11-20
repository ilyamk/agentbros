/**
 * Ratings and frame feedback end to end (RFC 0004 WP9, A16, A17) in fixture mode (RUN_CONSOLE_E2E=1 pnpm console:e2e):
 * rate a styleframe with the user's words and see the rating come back in the view, comment on a frame of the latest
 * render and see it confirmed; axe with no serious violation; screenshots into out/qa/console/ (`ratings-*.png`).
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
let clip: Buffer;

/** Fixture mode has no server: a tiny real clip answers /media (with ranges, as the console server does). */
test.beforeAll(() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    test.skip(true, "ffmpeg is needed to make the test clip (brew install ffmpeg)");
  }
  dir = mkdtempSync(path.join(os.tmpdir(), "console-ratings-e2e-"));
  const mp4 = path.join(dir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=270x480:rate=30:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "10", "-movflags", "+faststart", mp4,
  ]); // prettier-ignore
  clip = readFileSync(mp4);
});

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function serveClip(page: Page) {
  await page.route("**/media/**", async (route) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers()["range"] ?? "");
    const start = range?.[1] ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), clip.length - 1) : clip.length - 1;
    const slice = clip.subarray(start, end + 1);
    await route.fulfill({
      status: range ? 206 : 200,
      body: slice,
      headers: {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "content-length": String(slice.length),
        ...(range ? { "content-range": `bytes ${start}-${end}/${clip.length}` } : {}),
      },
    });
  });
}

for (const width of [1280, 390])
  test(`rate a styleframe and comment on a frame ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await serveClip(page);
    await page.goto("./?fixture=view-film-build&lang=en&theme=light");
    const look = page.locator('[data-panel="film.look"]');
    const toggle = look.locator("> h2 > button");
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    const frame = look.locator('[data-styleframe="pipeline/look/frame-end.png"]');
    await expect(frame).toContainText("Not rated yet");
    await frame.getByRole("radio", { name: "3 out of 5" }).click();
    await frame
      .getByRole("textbox", { name: "Your words about it (optional)" })
      .fill("Closer, but the type is too thin");
    await frame.getByRole("button", { name: "Save rating" }).click();
    await expect(frame.getByRole("status")).toContainText("Rating saved: 3 of 5.");
    await expect(frame).toContainText("Your rating: 3 of 5");

    const build = page.locator('[data-panel="film.build"]');
    await expect(build).toBeVisible();
    await build.getByRole("button", { name: "Mark the frame" }).first().click();
    const form = build.locator("[data-frame-comment-form]").first();
    await form.getByRole("textbox", { name: "Comment" }).fill("The logo is cut off here");
    await form.getByRole("button", { name: "Add comment" }).click();
    await expect(
      page.getByText("Your comment on frame 0 goes to the build; the fixer answers it next round."),
    ).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal page scroll").toBe(width);
    await look.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(QA, `ratings-${width}.png`), fullPage: true });
    const results = await new AxeBuilder({ page }).include('[data-panel="film.look"]').analyze();
    const serious = results.violations
      .filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))
      .map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target.join(" ")) }));
    expect(serious).toEqual([]);
  });
