import { ensureBrowser, openBrowser } from "@remotion/renderer";
import { readFileSync, writeFileSync } from "node:fs";
import { encodeLosslessWebp } from "./webp";
import { parseIconSvg } from "./svg";

async function main() {
  const [input, output, format] = process.argv.slice(2);
  if (!input || !output || !["png", "webp"].includes(format)) throw Error("Invalid internal export request");
  const svg = readFileSync(input, "utf8"),
    doc = parseIconSvg(svg),
    size = Number(doc.documentElement!.getAttribute("width"));
  if (!Number.isInteger(size) || size < 16 || size > 4096) throw Error("Invalid raster dimensions");
  await ensureBrowser({
    onBrowserDownload: () => {
      throw Error("Chromium is missing; prepare it with pnpm exec remotion browser ensure before exporting");
    },
  });
  const browser = await openBrowser("chrome", { logLevel: "error" });
  const terminate = () => {
    void browser.close({ silent: true }).finally(() => process.exit(1));
  };
  process.once("SIGTERM", terminate);
  let bytes: Buffer;
  try {
    const page = await browser.newPage({
      context: () => null,
      logLevel: "error",
      indent: false,
      pageIndex: 0,
      onBrowserLog: null,
      onLog: () => {},
    });
    const data = await page.evaluate(
      async (source: string, dimension: number, format: string) => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = dimension;
        canvas.height = dimension;
        const context = canvas.getContext("2d");
        if (!context) throw Error("Canvas unavailable");
        context.drawImage(image, 0, 0, dimension, dimension);
        if (format === "png") return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
        const bytes = context.getImageData(0, 0, dimension, dimension).data;
        let binary = "";
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return btoa(binary);
      },
      `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
      size,
      format,
    );
    bytes = Buffer.from(data, "base64");
  } finally {
    process.removeListener("SIGTERM", terminate);
    await browser.close({ silent: true });
  }
  writeFileSync(output, format === "png" ? bytes : await encodeLosslessWebp(new Uint8ClampedArray(bytes), size, size), {
    flag: "wx",
  });
}
void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
