import { ensureBrowser, openBrowser } from "@remotion/renderer";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { assertPathWithin } from "../cli";

async function main() {
  const [root, job] = process.argv.slice(2);
  if (!root || !job) throw new Error("Missing internal review render request.");
  process.chdir(fileURLToPath(new URL("../../../", import.meta.url)));
  assertPathWithin(root, job);
  const pages = JSON.parse(readFileSync(job, "utf8")) as Array<{
    html: string;
    path: string;
    width: number;
    height: number;
  }>;
  await ensureBrowser({
    onBrowserDownload: () => {
      throw new Error("Chromium missing; run pnpm exec remotion browser ensure.");
    },
  });
  const browser = await openBrowser("chrome", { logLevel: "error" });
  const terminate = () => {
    void browser.close({ silent: true }).finally(() => process.exit(1));
  };
  process.once("SIGTERM", terminate);
  try {
    const page = await browser.newPage({
      context: () => null,
      logLevel: "error",
      indent: false,
      pageIndex: 0,
      onBrowserLog: null,
      onLog: () => {},
    });
    for (const item of pages) {
      const file = path.resolve(root, item.html),
        output = path.resolve(root, item.path);
      assertPathWithin(root, file);
      assertPathWithin(root, output);
      if (Math.max(item.width, item.height) > 2000) throw new Error("Review page exceeds the viewer budget.");
      await page.setViewport({ width: item.width, height: item.height, deviceScaleFactor: 1 });
      await page.goto({ url: pathToFileURL(file).href, timeout: 30000 });
      const measurements = await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode()));
        return {
          ready: [...document.images].every((image) => image.naturalWidth > 0),
          fontReady: document.fonts.check("20px Arial"),
          overflow:
            document.documentElement.scrollHeight > window.innerHeight ||
            document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      if (!measurements.ready || !measurements.fontReady || measurements.overflow)
        throw new Error("Review page image/font/layout readiness failed.");
      const result = await page._client().send("Page.captureScreenshot", { format: "png" });
      writeFileSync(output, Buffer.from(result.value.data, "base64"), { flag: "wx" });
    }
  } finally {
    process.removeListener("SIGTERM", terminate);
    await browser.close({ silent: true });
  }
}
void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
