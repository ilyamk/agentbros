import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { bundle } from "@remotion/bundler";
import { getCompositions, openBrowser, renderStill, selectComposition } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { offlineSmokeFontAliases } from "./helpers/offline-smoke-fonts";
import { ProjectVideoSchema } from "../src/lib/project-props";

test(
  "retained TalkingHeadDemo alias lists and renders identically to canonical landscape",
  { skip: process.env.RUN_RENDER_TESTS !== "1", timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "root-compositions-"));
    const publicDir = path.join(root, "public");
    mkdirSync(publicDir);
    const props = ProjectVideoSchema.parse({
      projectId: "fixture",
      format: "landscape",
      productName: "Fixture",
      tagline: "",
      accentColor: "#71e8c3",
      bgColor: "#10121a",
      textColor: "#ffffff",
      scenes: [
        { id: "one", text: "Legacy scene", headline: "Legacy scene", visualType: "title", durationInFrames: 33 },
      ],
      voiceoverEnabled: false,
      musicVolume: 0,
    });
    const browser = await openBrowser("chrome", { logLevel: "error" });
    try {
      const serveUrl = await bundle({
        entryPoint: path.resolve("src/index.ts"),
        publicDir,
        webpackOverride: (config) => {
          const enhanced = enableTailwind(config);
          return {
            ...enhanced,
            resolve: {
              ...enhanced.resolve,
              alias: { ...enhanced.resolve?.alias, ...offlineSmokeFontAliases(path.resolve(".")) },
            },
          };
        },
      });
      const compositions = await getCompositions(serveUrl, {
        inputProps: props,
        puppeteerInstance: browser,
        logLevel: "error",
      });
      for (const id of [
        "ProjectVertical",
        "ProjectSquare",
        "ProjectLandscape",
        "TalkingHeadDemo",
        "Vertical",
        "Square",
      ])
        assert.ok(
          compositions.some((composition) => composition.id === id),
          id,
        );
      const canonical = await selectComposition({
          serveUrl,
          id: "ProjectLandscape",
          inputProps: props,
          puppeteerInstance: browser,
          logLevel: "error",
        }),
        legacy = await selectComposition({
          serveUrl,
          id: "TalkingHeadDemo",
          inputProps: props,
          puppeteerInstance: browser,
          logLevel: "error",
        });
      const metadata = (composition: typeof canonical) => ({
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        durationInFrames: composition.durationInFrames,
        props: composition.props,
      });
      assert.deepEqual(metadata(legacy), metadata(canonical));
      for (const frame of [0, 30]) {
        const outputs = [];
        for (const composition of [canonical, legacy]) {
          const output = path.join(root, `${composition.id}-${frame}.png`);
          await renderStill({
            serveUrl,
            composition,
            inputProps: props,
            puppeteerInstance: browser,
            output,
            imageFormat: "png",
            frame,
            logLevel: "error",
          });
          outputs.push(readFileSync(output));
        }
        assert.deepEqual(outputs[0], outputs[1], `Retained alias differs at frame ${frame}`);
      }
    } finally {
      await browser.close({ silent: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
