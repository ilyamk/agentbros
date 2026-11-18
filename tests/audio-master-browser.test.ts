import { offlineSmokeFontAliases } from "./helpers/offline-smoke-fonts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import { planProjectRender } from "../src/lib/render-plan";
import { hashFile } from "../src/lib/assets/registry";

test(
  "actual mastered presenter render contains master tone and no original embedded voice",
  { skip: process.env.RUN_RENDER_TESTS !== "1", timeout: 120000 },
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "master-browser-"));
    try {
      const dir = path.join(root, "public/projects/master");
      mkdirSync(dir, { recursive: true });
      const video = path.join(dir, "presenter.mp4"),
        audio = path.join(dir, "master.wav");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x160:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-pix_fmt",
        "yuv420p",
        "-shortest",
        video,
      ]);
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", audio]);
      writeFileSync(
        path.join(dir, "project.json"),
        JSON.stringify({
          name: "master",
          productName: "master",
          formats: ["square"],
          colors: {},
          musicVolume: 0,
          talkingHead: {
            enabled: true,
            presenterVideo: "projects/master/presenter.mp4",
            audioSource: "embedded",
          },
          scenes: [
            {
              id: "hook",
              text: "",
              visualType: "title",
              durationInFrames: 30,
              leftPanel: { kind: "text", text: "A" },
            },
          ],
        }),
      );
      const sidecar = path.join(dir, "master.wav.json");
      writeFileSync(
        sidecar,
        JSON.stringify({
          source: "projects/master/master.wav",
          sourceSha256: hashFile(audio),
          durationSec: 1,
          integratedLufs: -16,
          truePeakDb: -1.5,
          targetLufs: -16,
          createdAt: "2026-10-11T00:00:00Z",
        }),
      );
      const job = planProjectRender("master", "square", root, {
        audioMaster: sidecar,
      }).jobs[0];
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
      const composition = await selectComposition({
        serveUrl,
        id: job.compositionId,
        inputProps: job.props,
      });
      const output = path.join(root, "master.mp4");
      await renderMedia({
        serveUrl,
        composition: { ...composition, width: 320, height: 320 },
        inputProps: job.props,
        codec: "h264",
        outputLocation: output,
        concurrency: 2,
      });
      const pcm = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        output,
        "-ss",
        "0.2",
        "-t",
        "0.6",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
      const amplitude = (frequency: number) => {
        let sin = 0,
          cos = 0;
        for (let i = 0; i < samples.length; i++) {
          const angle = (2 * Math.PI * frequency * i) / 48000;
          sin += samples[i] * Math.sin(angle);
          cos += samples[i] * Math.cos(angle);
        }
        return (2 * Math.hypot(sin, cos)) / samples.length;
      };
      assert.ok(amplitude(880) > 0.1, "master tone audible");
      assert.ok(amplitude(440) < 0.002, "embedded original must be muted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
