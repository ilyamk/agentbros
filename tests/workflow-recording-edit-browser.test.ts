import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { reviewedRequest } from "./workflow-recording-edit-fixtures";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { planProjectRender } from "../src/lib/render-plan";
import { mediaProbe } from "../src/lib/audio/analysis";
function measure(file: string, start: number) {
  const bytes = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-ss", String(start), "-t", "0.4", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
    {
      maxBuffer: 1024 * 1024,
    },
  );
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  let square = 0,
    crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    square += samples[i] * samples[i];
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  }
  return {
    hz: crossings / 0.4,
    rms: Math.sqrt(square / samples.length),
  };
}
test(
  "actual ProductionRoot recut MP4 preserves first/last source audio and caption boundaries",
  {
    skip: process.env.RUN_WORKFLOW_RENDER_TESTS !== "1",
    timeout: 180000,
  },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "recording-workflow-browser-"));
    const retained = process.env.WORKFLOW_ARTIFACTS_DIR
      ? path.resolve(process.env.WORKFLOW_ARTIFACTS_DIR, "recording-edit")
      : undefined;
    try {
      const request = await reviewedRequest(root);
      await runRecordingEditWorkflow(request, {
        action: "create",
        rootDir: root,
      });
      const job = planProjectRender("recut", "landscape", root, {
        timeline: true,
      }).jobs[0];
      assert.equal(job.durationInFrames, 60);
      const serveUrl = await bundle({
        entryPoint: path.resolve("src/index.ts"),
        publicDir: path.join(root, "public"),
        outDir: path.join(root, "bundle"),
        webpackOverride: (config) => {
          const c = enableTailwind(config);
          return {
            ...c,
            resolve: {
              ...c.resolve,
              alias: {
                ...c.resolve?.alias,
                [path.resolve("src/lib/fonts")]: path.resolve("tests/fixtures/offline-fonts.ts"),
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
      const output = path.join(root, "recut.mp4");
      await renderMedia({
        serveUrl,
        composition,
        inputProps: job.props,
        codec: "h264",
        outputLocation: output,
        concurrency: 1,
        scale: 0.25,
        logLevel: "error",
      });
      const probe = mediaProbe(output);
      assert.ok(Math.abs(Number(probe.format.duration) - 2) < 1 / 30);
      assert.equal(probe.streams.filter((s) => s.codec_type === "audio").length, 1);
      assert.equal(probe.streams.find((s) => s.codec_type === "video")?.width, 480);
      const before = measure(request.source.file, 0.3),
        after = measure(output, 0.3),
        last = measure(output, 1.3);
      assert.ok(Math.abs(after.hz - 440) < 8, JSON.stringify(after));
      assert.ok(Math.abs(last.hz - 880) < 8, JSON.stringify(last));
      assert.ok(
        after.rms / before.rms > 0.85 && after.rms / before.rms < 1.15,
        "authentic speech must not double or disappear",
      );
      execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]);
      if (retained) {
        mkdirSync(retained, {
          recursive: true,
        });
        copyFileSync(output, path.join(retained, "production-root-recut.mp4"));
        for (const [label, frame] of [
          ["negation", 10],
          ["before-cut", 29],
          ["caveat-after-cut", 35],
          ["tail", 59],
        ] as const)
          await renderStill({
            serveUrl,
            composition,
            inputProps: job.props,
            frame,
            output: path.join(retained, label + ".png"),
            scale: 0.25,
            logLevel: "error",
          });
        writeFileSync(
          path.join(retained, "audio-probe-report.json"),
          JSON.stringify(
            {
              technicalOnly: true,
              fontMode: "offline-fixture-not-production-font-proof",
              review: "synthetic test declarations; human meaning/visual review required",
              probe,
              before,
              after,
              last,
              request,
              renderProps: job.props,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  },
);
