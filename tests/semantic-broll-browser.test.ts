import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { openBrowser, selectComposition, renderMedia } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { brollFixture } from "./helpers/semantic-broll";
import { planBroll, applyBroll } from "../src/lib/ingest/broll";
import { planProjectRender } from "../src/lib/render-plan";
import { digest } from "../src/lib/jobs/model-artifacts";
test(
  "actual B-roll video shows red/blue/red, keeps timed captions and bit-identical decoded original audio",
  {
    skip: process.env.RUN_RENDER_TESTS !== "1",
    timeout: 180000,
  },
  async () => {
    const f = brollFixture();
    const evidence = process.env.AGENTBROS_BROLL_ARTIFACT_ROOT
      ? path.resolve(process.env.AGENTBROS_BROLL_ARTIFACT_ROOT)
      : path.join(f.root, "evidence");
    mkdirSync(evidence, {
      recursive: true,
    });
    const browser = await openBrowser("chrome");
    try {
      const before = f.store.read();
      const serveUrl = await bundle({
        entryPoint: path.resolve("src/index.ts"),
        publicDir: path.join(f.root, "public"),
        outDir: path.join(f.root, "bundle"),
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
      const render = async (name: string) => {
        const job = planProjectRender("pilot", "square", f.root, {
          timeline: true,
        }).jobs[0]!;
        const composition = await selectComposition({
          serveUrl,
          id: job.compositionId,
          inputProps: job.props,
          puppeteerInstance: browser,
          logLevel: "error",
        });
        assert.equal(composition.durationInFrames, 90);
        const file = path.join(evidence, name + ".mp4");
        await renderMedia({
          serveUrl,
          composition,
          inputProps: job.props,
          puppeteerInstance: browser,
          outputLocation: file,
          codec: "h264",
          scale: 0.15,
          concurrency: 2,
          logLevel: "error",
        });
        return file;
      };
      const baseline = await render("before");
      const plan = planBroll(f.request, {
        rootDir: f.root,
      });
      const applied = applyBroll(plan, f.review(plan), {
        rootDir: f.root,
      });
      const edited = await render("after");
      assert.deepEqual(applied.timeline.tracks.slice(0, -1), before.timeline.tracks);
      const pcm = (file: string) =>
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-i",
          file,
          "-map",
          "0:a:0",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-f",
          "s16le",
          "pipe:1",
        ]);
      const original = pcm(baseline),
        actual = pcm(edited);
      assert.equal(digest(actual), digest(original));
      assert.ok(actual.length >= 144000 * 4);
      const pixels = [15, 39, 75].map((frame) => {
        const bytes = execFileSync("ffmpeg", [
          "-v",
          "error",
          "-i",
          edited,
          "-vf",
          `select=eq(n\\,${frame}),crop=8:8:78:16`,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]);
        const totals = [0, 0, 0];
        for (let i = 0; i < bytes.length; i++) totals[i % 3]! += bytes[i]!;
        assert.equal(bytes.length, 8 * 8 * 3);
        return totals.map((t) => t / 64);
      });
      assert.ok(pixels[0]![0]! > 200 && pixels[0]![2]! < 30);
      assert.ok(pixels[1]![2]! > 200 && pixels[1]![0]! < 30);
      assert.ok(pixels[2]![0]! > 200 && pixels[2]![2]! < 30);
      // Caption raster stays visible during the cutaway, not just in the unchanged JSON.
      const caption = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        edited,
        "-vf",
        "select=eq(n\\,39),crop=162:70:0:92",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ]);
      let yellow = 0;
      for (let i = 0; i < caption.length; i += 3)
        if (caption[i]! > 150 && caption[i + 1]! > 150 && caption[i + 2]! < 120) yellow++;
      assert.ok(yellow > 5, "Timed active caption has visible yellow glyph pixels during B-roll");
      const proof = {
        version: 1,
        source: "synthetic supplied fixture only",
        frames: 90,
        scale: 0.15,
        format: "square",
        outputWidth: 162,
        outputHeight: 162,
        planHash: plan.planHash,
        preservedOriginalTracks: true,
        decodedAudioSha256: digest(actual),
        decodedAudioBytes: actual.length,
        blueSourceAudioHz: 880,
        preservedSpeechFixtureHz: 440,
        pixels,
        captionYellowPixels: yellow,
        limits: "Offline font fixture, not production font QA; no semantic inference or human creative approval",
      };
      writeFileSync(path.join(evidence, "evidence.json"), JSON.stringify(proof, null, 2));
      writeFileSync(path.join(evidence, "plan.json"), JSON.stringify(plan, null, 2));
    } finally {
      await browser.close({
        silent: true,
      });
      f.cleanup();
    }
  },
);
