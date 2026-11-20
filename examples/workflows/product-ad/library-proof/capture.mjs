// Run from the repository root after pnpm console:build.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const project = "projects/library-proof/captures";
const output = "out/qa/proof";
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const capture = {
  title: "Motion library",
  beforeValue: "12",
  afterValue: "02",
  beforeLabel: "motion blocks",
  afterLabel: "matching blocks",
  accent: "#5538cc",
};
try {
  await mkdir(`public/${project}`, { recursive: true });
  await mkdir(output, { recursive: true });
  for (const [format, width, height] of [
    ["landscape", 1140, 710],
    ["portrait", 760, 840],
  ]) {
    const page = await browser.newPage({
      viewport: { width: width + 290, height: height + 260 },
      deviceScaleFactor: 2,
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const preview = url.pathname.startsWith("/library/preview/");
      const name = path.basename(url.pathname) || "index.html";
      const file = preview ? `docs/library/previews/${name}.jpg` : `out/console/dist/${name}`;
      const contentType = preview
        ? "image/jpeg"
        : { "app.js": "text/javascript", "style.css": "text/css", "index.html": "text/html" }[name];
      if (url.hostname !== "console.test" || !contentType) return route.abort();
      await route.fulfill({ body: await readFile(file), contentType });
    });
    await page.goto("http://console.test/?fixture=projects-response&lang=en&theme=light#/library");
    const cards = page.locator("[data-block]");
    await cards.first().waitFor();
    const main = await page.locator("main:has([data-search])").boundingBox();
    const clip = {
      x: Math.round(main.x),
      y: Math.round(main.y),
      width: Math.min(width, Math.floor(main.width)),
      height,
    };
    const category = page.getByRole("button", { name: /^transitions /i });
    const snapshot = async (state) => {
      await cards.locator("img").evaluateAll(async (imgs) => {
        for (const img of imgs) img.loading = "eager";
        await Promise.all(imgs.map((img) => img.decode()));
      });
      const src = `${project}/${format}-${state}.png`;
      await page.screenshot({ path: `public/${src}`, clip, animations: "disabled" });
      return src;
    };
    capture.beforeValue = String(await cards.count());
    const before = await snapshot("before");
    await category.click();
    await page.waitForFunction(() => document.querySelectorAll("[data-block]").length === 2);
    capture.afterValue = String(await cards.count()).padStart(2, "0");
    const blocks = await cards.evaluateAll((nodes) => nodes.map((el) => el.getAttribute("data-block")));
    if (blocks.join(",") !== "ground-swap-cut,caused-morph")
      throw new Error("The live results no longer match the performed transitions.");
    capture.performance = { blocks, score: "projects/library-proof/score.wav" };
    capture.resultNames = await cards.locator("h2").allTextContents();
    const after = await snapshot("after");
    const button = await category.boundingBox();
    const first = await cards.first().locator("img").boundingBox();
    const second = await cards.nth(1).locator("img").boundingBox();
    capture[format] = {
      before,
      after,
      width: clip.width,
      height: clip.height,
      target: {
        x: (button.x + button.width / 2 - clip.x) / clip.width,
        y: (button.y + button.height / 2 - clip.y) / clip.height,
      },
      control: { width: button.width, height: button.height },
      result: {
        x: (first.x + (second.x + second.width - first.x) / 2 - clip.x) / clip.width,
        y: (first.y + first.height * 0.8 - clip.y) / clip.height,
      },
      resultZoom: format === "portrait" ? 1.03 : 1.42,
    };
    await page.close();
  }
  await writeFile(
    `${output}/props.json`,
    JSON.stringify(
      {
        capture,
        styleId: "paper-signal",
        brand: "Motion library",
        hookLines: ["Find the cut."],
        hookVerticalLines: ["Find the cut."],
        action: "pnpm library:list",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
