import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { audioProject, amplitude } from "./helpers/review-audio";
import { planProjectRender } from "../src/lib/render-plan";
test(
  "actual TimelineComposition audio rendering honors clip gain/mute/loop without replacing speech and undo restores PCM",
  { skip: process.env.RUN_RENDER_TESTS !== "1", timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "review-gain-render-"));
    try {
      const { store } = audioProject(root),
        before = store.read();
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
      const render = async (name: string) => {
        const job = planProjectRender("demo", "square", root, { timeline: true }).jobs[0];
        assert.equal(job.durationInFrames, 90);
        const composition = await selectComposition({
          serveUrl,
          id: job.compositionId,
          inputProps: job.props,
          logLevel: "error",
        });
        const output = path.join(root, name + ".mp4");
        await renderMedia({
          serveUrl,
          composition: { ...composition, width: 160, height: 160 },
          inputProps: job.props,
          codec: "h264",
          outputLocation: output,
          concurrency: 1,
          logLevel: "error",
        });
        return execFileSync("ffmpeg", [
          "-v",
          "error",
          "-threads",
          "1",
          "-i",
          output,
          "-vn",
          "-ar",
          "48000",
          "-ac",
          "1",
          "-f",
          "f32le",
          "pipe:1",
        ]);
      };
      const original = await render("original");
      t.diagnostic(
        JSON.stringify({
          originalAmplitudes: [0.2, 1.7, 2.5].map((start) => ({
            start,
            music: amplitude(original, 880, start),
            speech: amplitude(original, 440, start),
            sfx: amplitude(original, 1320, start),
          })),
        }),
      );
      store.apply({ type: "audio-gain", trackId: "music", clipId: "clip", gain: 0 }, 0);
      const muted = await render("muted");
      assert.equal(muted.length, original.length);
      for (const start of [0.2, 1.7, 2.5]) {
        assert.ok(amplitude(original, 880, start) > 0.035, "looped original music audible");
        assert.ok(amplitude(muted, 880, start) < 0.0005, "selected music muted");
        assert.ok(Math.abs(amplitude(muted, 440, start) - amplitude(original, 440, start)) < 0.002, "speech unchanged");
        assert.ok(Math.abs(amplitude(muted, 1320, start) - amplitude(original, 1320, start)) < 0.002, "SFX unchanged");
      }
      assert.deepEqual(store.read().timeline.tracks[1], before.timeline.tracks[1]);
      store.undo(1);
      const undo = await render("undo");
      assert.deepEqual(undo, original);
      assert.deepEqual(store.read().timeline, before.timeline);
      const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
      const facts = {
        durationFrames: 90,
        fps: 30,
        outputSize: [160, 160],
        decodedSamples: original.length / 4,
        originalPcmSha: sha(original),
        mutedPcmSha: sha(muted),
        undoPcmSha: sha(undo),
        speechTrackSha: sha(JSON.stringify(before.timeline.tracks[1])),
        captionSha: sha(JSON.stringify(before.timeline.tracks[1].clips[0].captions)),
        sourceAssetIds: before.timeline.tracks.filter((t) => t.kind !== "visual").map((t) => t.clips[0].assetId),
      };
      t.diagnostic(JSON.stringify(facts));
      if (process.env.AUDIO_REVIEW_EVIDENCE) {
        const evidence = path.resolve(process.env.AUDIO_REVIEW_EVIDENCE);
        mkdirSync(evidence, { recursive: true });
        for (const name of ["original", "muted", "undo"])
          copyFileSync(path.join(root, name + ".mp4"), path.join(evidence, name + ".mp4"));
        for (const [name, bytes] of [
          ["original", original],
          ["muted", muted],
          ["undo", undo],
        ] as const)
          writeFileSync(path.join(evidence, name + ".f32le"), bytes);
        writeFileSync(path.join(evidence, "evidence.json"), JSON.stringify(facts, null, 2));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
