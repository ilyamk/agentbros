import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { projectToVideoProps, PROJECT_COMPOSITION_IDS } from "../src/lib/project-props";
import { materializeRecipe } from "../src/lib/templates/materialize";
import type { RecipeRequest } from "../src/types/recipes";
import { offlineSmokeFontAliases, blockGoogleFontRequests } from "./helpers/offline-smoke-fonts";

const briefCases = [
  {
    id: "stops",
    style: "paper-signal@1",
    headline: "A tram stop is a shared resource",
    from: 2,
    to: 4,
    shape: "disc",
    unit: "One object per stop",
  },
  {
    id: "returns",
    style: "paper-signal@1",
    headline: "Show the return before asking",
    from: 3,
    to: 8,
    shape: "tile",
    unit: "One object per form",
  },
  {
    id: "benches",
    style: "physical-data@1",
    headline: "Work benches reopened",
    from: 4,
    to: 12,
    shape: "tile",
    unit: "One tile per work bench",
  },
  {
    id: "lockers",
    style: "physical-data@1",
    headline: "Free cycle lockers",
    from: 9,
    to: 5,
    shape: "disc",
    unit: "One disc per locker",
  },
] as const;

test(
  "style pilots render paired original briefs in landscape and portrait",
  {
    skip: process.env.RUN_RENDER_TESTS !== "1",
    timeout: 360_000,
  },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "film-style-pilot-"));
    const output = process.env.FILM_STYLE_ARTIFACTS
      ? path.resolve(process.env.FILM_STYLE_ARTIFACTS)
      : path.join(root, "pilot");
    let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
    try {
      mkdirSync(output, { recursive: true });
      mkdirSync(path.join(root, "public"), { recursive: true });
      const projects = [];
      for (const item of briefCases) {
        for (const variant of ["control", "card"] as const) {
          const projectId = `pilot-${item.id}-${variant}`;
          const physical = item.style === "physical-data@1";
          const instance = physical
            ? variant === "card"
              ? ({
                  id: "scene.physical-data",
                  version: 1,
                  props: {
                    headline: item.headline,
                    unitLabel: item.unit,
                    from: item.from,
                    to: item.to,
                    firstFrame: 12,
                    stepFrames: 4,
                    shape: item.shape,
                  },
                } as const)
              : ({
                  id: "scene.metric",
                  version: 1,
                  props: { headline: item.headline, to: item.to, suffix: "" },
                } as const)
            : ({
                id: "text.word-reveal",
                version: 1,
                props: {
                  text: item.headline,
                  staggerSec: 0.12,
                  ...(variant === "card" ? { accentWordIndex: item.id === "stops" ? 5 : 2 } : {}),
                },
              } as const);
          const input: RecipeRequest = {
            projectId,
            recipeId: "educational-explainer",
            topic: item.headline,
            formats: ["landscape", "vertical"],
            durationSec: 15,
            ...(variant === "card" ? { styleCard: item.style } : {}),
            beats: [{ id: "question", headline: item.headline, template: instance, selfContained: true }],
          };
          const { project } = materializeRecipe(input, root);
          projects.push({ item, variant, projectId, project });
        }
      }
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
      const fontRequests = blockGoogleFontRequests(browser);
      const results: { id: string; format: string; variant: string; png: string; hash: string }[] = [];
      for (const { item, variant, projectId, project } of projects) {
        for (const format of ["landscape", "vertical"] as const) {
          const identity = captureRenderIdentity(projectId, format, { rootDir: root });
          assert.equal(
            identity.sources.some(({ path }) => path.endsWith("/film-style.json")),
            variant === "card",
          );
          const props = projectToVideoProps(project, projectId, format, false);
          const composition = await selectComposition({
            serveUrl,
            id: PROJECT_COMPOSITION_IDS[format],
            inputProps: props,
            puppeteerInstance: browser,
            logLevel: "error",
          });
          const name = `${item.id}-${format}-${variant}`;
          const video = path.join(output, name + ".mp4");
          const png = path.join(output, name + ".png");
          await renderStill({
            serveUrl,
            composition,
            inputProps: props,
            puppeteerInstance: browser,
            output: png,
            frame: 49,
            logLevel: "error",
          });
          await renderMedia({
            serveUrl,
            composition,
            inputProps: props,
            puppeteerInstance: browser,
            outputLocation: video,
            codec: "h264",
            concurrency: 2,
            x264Preset: "ultrafast",
            frameRange: [12, 51],
            muted: true,
            logLevel: "error",
          });
          const dimensions = execFileSync(
            "ffprobe",
            [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-show_entries",
              "stream=width,height,nb_frames",
              "-of",
              "csv=p=0",
              video,
            ],
            { encoding: "utf8" },
          ).trim();
          assert.equal(dimensions, format === "landscape" ? "1920,1080,40" : "1080,1920,40");
          results.push({
            id: item.id,
            format,
            variant,
            png: path.basename(png),
            hash: createHash("sha256").update(readFileSync(png)).digest("hex"),
          });
        }
      }
      for (const row of results.filter((result) => result.variant === "card")) {
        const control = results.find(
          (result) => result.id === row.id && result.format === row.format && result.variant === "control",
        );
        assert.ok(control);
        assert.notEqual(row.hash, control.hash);
      }
      assert.equal(fontRequests.length, 0);
      writeFileSync(
        path.join(output, "proof.json"),
        JSON.stringify({ fixtures: "synthetic", results }, null, 2) + "\n",
      );
    } finally {
      await browser?.close({ silent: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
