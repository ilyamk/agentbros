import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia, ensureBrowser, openBrowser } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { audioProject, amplitude } from "./helpers/review-audio";
import { planProjectRender } from "../src/lib/render-plan";
import { ReviewService } from "../src/lib/review-ui/service";
test(
  "actual TimelineComposition inward SFX trim preserves protected speech/music, expected audible windows and exact Undo PCM",
  { skip: process.env.RUN_AUDIO_POSITION_RENDER_TESTS !== "1", timeout: 120000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "review-position-render-"));
    let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
    try {
      const installed = await ensureBrowser({
        logLevel: "error",
        onBrowserDownload: () => {
          throw Error("No browser downloads");
        },
      });
      if (!("path" in installed)) throw Error("Installed browser required");
      browser = await openBrowser("chrome", { browserExecutable: installed.path, logLevel: "error" });
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
          puppeteerInstance: browser,
          logLevel: "error",
        });
        const output = path.join(root, name + ".mp4");
        await renderMedia({
          serveUrl,
          composition: { ...composition, width: 160, height: 160 },
          inputProps: job.props,
          puppeteerInstance: browser,
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
      const service = new ReviewService("demo", root),
        proposal = service.audioPositionProposal({
          expectedRevision: 0,
          trackId: "sfx",
          clipId: "clip",
          mode: "trim",
          sourceStart: { num: 15, den: 1 },
          sourceEnd: { num: 75, den: 1 },
        });
      store.apply(proposal.command, 0);
      const edited = await render("edited");
      assert.equal(edited.length, original.length);
      const windows = [
        { start: 0.1, seconds: 0.2, active: false },
        { start: 0.8, seconds: 0.3, active: true },
        { start: 2.6, seconds: 0.3, active: false },
      ];
      const measurements = windows.map((window) => {
        const { start, seconds, active } = window,
          sfx = amplitude(edited, 1320, start, seconds),
          oldSfx = amplitude(original, 1320, start, seconds),
          speechDelta = Math.abs(amplitude(edited, 440, start, seconds) - amplitude(original, 440, start, seconds)),
          musicDelta = Math.abs(amplitude(edited, 880, start, seconds) - amplitude(original, 880, start, seconds));
        assert.ok(active ? sfx > 0.04 : sfx < 0.0005, JSON.stringify({ window, sfx }));
        assert.ok(oldSfx > 0.04);
        assert.ok(speechDelta < 0.002);
        assert.ok(musicDelta < 0.002);
        return { ...window, sfx, oldSfx, speechDelta, musicDelta };
      });
      assert.deepEqual(store.read().timeline.tracks.slice(0, 3), before.timeline.tracks.slice(0, 3));
      assert.equal(store.read().undo.length, 1);
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
        codec:
          "h264/AAC; spectral windows avoid edges and codec padding; thresholds0.0005 silence/0.002 protected tones",
        measurements,
        originalPcmSha: sha(original),
        editedPcmSha: sha(edited),
        undoPcmSha: sha(undo),
        speechTrackSha: sha(JSON.stringify(before.timeline.tracks[1])),
        captionSha: sha(JSON.stringify(before.timeline.tracks[1].clips[0].captions)),
        sourceAssetIds: before.timeline.tracks.filter((t) => t.kind !== "visual").map((t) => t.clips[0].assetId),
      };
      t.diagnostic(JSON.stringify(facts));
      if (process.env.AUDIO_POSITION_EVIDENCE) {
        const evidence = path.resolve(process.env.AUDIO_POSITION_EVIDENCE);
        mkdirSync(evidence, { recursive: true });
        for (const name of ["original", "edited", "undo"])
          copyFileSync(path.join(root, name + ".mp4"), path.join(evidence, name + ".mp4"));
        for (const [name, bytes] of [
          ["original", original],
          ["edited", edited],
          ["undo", undo],
        ] as const)
          writeFileSync(path.join(evidence, name + ".f32le"), bytes);
        writeFileSync(path.join(evidence, "evidence.json"), JSON.stringify(facts, null, 2));
      }
    } finally {
      if (browser) await browser.close({ silent: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
