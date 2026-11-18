import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { adaptLegacyProject, TimelineEditStore } from "../src/lib/timeline-ir";
import { planProjectRender } from "../src/lib/render-plan";
const r = (num: number) => ({ num, den: 1 });

test(
  "actual edited timeline changes rendered pixels and undo restores identical pixels",
  { skip: process.env.RUN_RENDER_TESTS !== "1", timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "timeline-browser-"));
    try {
      const dir = path.join(root, "public/projects/edit-render");
      mkdirSync(dir, { recursive: true });
      for (const color of ["red", "blue"])
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=c=${color}:s=64x64`,
          "-frames:v",
          "1",
          path.join(dir, `${color}.png`),
        ]);
      const project = {
        name: "edit-render",
        productName: "edit-render",
        colors: {},
        formats: ["square"],
        musicVolume: 0,
        voiceoverEnabled: false,
        scenes: [
          {
            id: "a",
            text: "A",
            visualType: "title",
            durationInFrames: 60,
            transitionToNext: "cut",
          },
          { id: "b", text: "B", visualType: "title", durationInFrames: 60 },
        ],
      };
      writeFileSync(path.join(dir, "project.json"), JSON.stringify(project));
      const ir = adaptLegacyProject(project, "edit-render");
      ir.tracks[0].clips[0].assetId = "projects/edit-render/red.png";
      ir.tracks[0].clips[1].assetId = "projects/edit-render/blue.png";
      const store = new TimelineEditStore(path.join(dir, "pipeline/timeline-edit.json"));
      store.initialize(ir);
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x160:rate=24:duration=2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        path.join(dir, "source.mp4"),
      ]);
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
                [path.resolve("src/lib/fonts")]: path.resolve("tests/fixtures/offline-fonts.ts"),
              },
            },
          };
        },
      });
      const still = async (name: string) => {
        const job = planProjectRender("edit-render", "square", root, {
          timeline: true,
        }).jobs[0];
        const composition = await selectComposition({
          serveUrl,
          id: job.compositionId,
          inputProps: job.props,
          logLevel: "error",
        });
        assert.equal(composition.durationInFrames, job.durationInFrames);
        const output = path.join(root, `${name}.png`);
        await renderStill({
          serveUrl,
          composition,
          inputProps: job.props,
          frame: 20,
          output,
          imageFormat: "png",
          scale: 0.25,
          logLevel: "error",
        });
        return readFileSync(output);
      };
      const original = await still("original");
      store.apply(
        {
          type: "replace",
          trackId: "visual",
          clipId: "a",
          assetId: "projects/edit-render/blue.png",
          source: { start: r(0), end: r(60), timebase: r(30) },
        },
        0,
      );
      const edited = await still("edited");
      assert.equal(original.equals(edited), false);
      store.undo(1);
      assert.equal(original.equals(await still("undo")), true);
      store.apply(
        {
          type: "replace",
          trackId: "visual",
          clipId: "a",
          assetId: "projects/edit-render/source.mp4",
          source: { start: r(0), end: r(48), timebase: r(24) },
        },
        2,
      );
      const normalVideo = await still("video-normal");
      store.apply({ type: "rate", trackId: "visual", clipId: "a", rate: r(2) }, 3);
      assert.equal(normalVideo.equals(await still("video-rate2")), false);
      store.undo(4);
      assert.equal(normalVideo.equals(await still("video-rate-undo")), true);
      store.apply(
        {
          type: "trim",
          trackId: "visual",
          clipId: "a",
          start: r(24),
          end: r(48),
        },
        5,
      );
      assert.equal(normalVideo.equals(await still("video-trim")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
