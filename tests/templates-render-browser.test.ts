import { offlineSmokeFontAliases, blockGoogleFontRequests } from "./helpers/offline-smoke-fonts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { openBrowser, selectComposition, renderStill } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { TEMPLATE_REGISTRY } from "../src/lib/templates/registry";
import { ProjectConfigSchema } from "../src/types/video";
import { projectToVideoProps, PROJECT_COMPOSITION_IDS } from "../src/lib/project-props";

test(
  "registered scenes and caption profiles render deterministic frames in all formats",
  // The finite budget covers two stills per entry/format, including shared-host scheduling.
  { skip: process.env.RUN_RENDER_TESTS !== "1", timeout: 480000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "templates-browser-"));
    let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
    try {
      const directory = path.join(root, "public/projects/preview/assets");
      mkdirSync(directory, { recursive: true });
      const image = "projects/preview/assets/proof.svg";
      writeFileSync(
        path.join(directory, "proof.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500" fill="#ddd"/><circle cx="250" cy="250" r="100" fill="#6C5CE7"/></svg>',
      );
      const serveUrl = await bundle({
        entryPoint: path.resolve("src/index.ts"),
        publicDir: path.join(root, "public"),
        outDir: path.join(root, "bundle"),
        webpackOverride: (config) => {
          const enhanced = enableTailwind(config);
          return {
            ...enhanced,
            resolve: {
              ...enhanced.resolve,
              alias: {
                ...enhanced.resolve?.alias,
                ...offlineSmokeFontAliases(path.resolve(".")),
              },
            },
          };
        },
      });
      browser = await openBrowser("chrome", { logLevel: "error" });
      const googleFontRequests = blockGoogleFontRequests(browser);
      const entries = TEMPLATE_REGISTRY.filter((entry) => entry.level === "scene" || entry.id.startsWith("caption."));
      for (const entry of entries) {
        const template = structuredClone(entry.sample);
        if ("imageUrl" in template.props) template.props.imageUrl = image;
        if ("headline" in template.props)
          template.props.headline = "Длинный русский заголовок о понятном доказательстве";
        const project = ProjectConfigSchema.parse({
          name: "preview",
          productName: "preview",
          colors: { accent: "#6C5CE7", background: "#FAFAFA", text: "#111111" },
          musicVolume: 0,
          scenes: [
            {
              id: "sample",
              text: "",
              visualType: "photo",
              imageUrl: image,
              durationInFrames: 120,
              template,
            },
          ],
        });
        for (const format of ["vertical", "square", "landscape"] as const) {
          const started = performance.now();
          const props = projectToVideoProps(project, "preview", format, false);
          const composition = await selectComposition({
            serveUrl,
            puppeteerInstance: browser,
            id: PROJECT_COMPOSITION_IDS[format],
            inputProps: props,
            logLevel: "error",
          });
          const selectedAt = performance.now();
          assert.equal(composition.durationInFrames, 120);
          const first = path.join(root, `${entry.id}-${format}-first.png`),
            second = path.join(root, `${entry.id}-${format}-second.png`);
          await renderStill({
            serveUrl,
            puppeteerInstance: browser,
            composition,
            inputProps: props,
            output: first,
            frame: 15,
            logLevel: "error",
          });
          const firstAt = performance.now();
          await renderStill({
            serveUrl,
            puppeteerInstance: browser,
            composition,
            inputProps: props,
            output: second,
            frame: 15,
            logLevel: "error",
          });
          const secondAt = performance.now();
          const bytes = readFileSync(first);
          assert.ok(bytes.length > 1000);
          assert.deepEqual(readFileSync(second), bytes, `${entry.id}/${format} seek must be deterministic`);
          assert.equal(bytes.readUInt32BE(16), composition.width);
          assert.equal(bytes.readUInt32BE(20), composition.height);
          console.error(
            JSON.stringify({
              templateCase: `${entry.id}/${format}`,
              selectMs: Math.round(selectedAt - started),
              firstMs: Math.round(firstAt - selectedAt),
              secondMs: Math.round(secondAt - firstAt),
              googleFontRequests: googleFontRequests.length,
            }),
          );
        }
      }
      assert.deepEqual(googleFontRequests, [], "Template smoke must not request Google fonts");
    } finally {
      await browser?.close({ silent: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
