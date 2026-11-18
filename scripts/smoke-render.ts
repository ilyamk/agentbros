/** Synthetic local render acceptance. Never loads .env or calls generation APIs. */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { enableTailwind } from "@remotion/tailwind-v4";
import {
  parseArgs,
  runScript,
  emitProgress,
  CliErrorObject,
  ensureFfmpeg,
  ensureFfprobe,
} from "../src/lib/cli/index.js";
import { planProjectRender } from "../src/lib/render-plan.js";

function local(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({ code: "FFMPEG_FAILED", message: result.error?.message ?? result.stderr });
  return result;
}

runScript(async () => {
  const args = parseArgs([
    { name: "output", default: "out/qa/phase0", description: "Synthetic verification directory" },
    { name: "comparisons-only", type: "boolean", description: "Compare legacy IDs against an existing smoke run" },
  ] as const);
  ensureFfmpeg();
  ensureFfprobe();
  const root = path.resolve(args.output!);
  const fixtureRoot = path.join(root, "fixtures");
  const publicDir = path.join(fixtureRoot, "public");
  const outputs: string[] = [];
  const cases: Record<string, unknown>[] = [];
  const base = {
    name: "Synthetic acceptance",
    formats: ["vertical", "square", "landscape"],
    productName: "Local QA",
    tagline: "No API calls",
    voice: "drew",
    colors: { accent: "#6C5CE7", background: "#F4B89C", text: "#111111" },
    musicVolume: 0,
  };
  for (const mode of ["promo", "embedded", "tts", "manual"] as const) {
    const id = `synthetic-${mode}-new-id`;
    const directory = path.join(publicDir, "projects", id);
    for (const child of ["talking-head", "voiceover", "assets/images"])
      mkdirSync(path.join(directory, child), { recursive: true });
    const presenter = path.join(directory, "talking-head/full.mp4");
    local("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      presenter,
    ]);
    const scenes = ["first", "second"].map((sceneId, index) => {
      if (mode !== "embedded")
        local("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${660 + index * 220}:duration=1:sample_rate=48000`,
          path.join(directory, "voiceover", `${sceneId}.mp3`),
        ]);
      writeFileSync(
        path.join(directory, "voiceover", `${sceneId}.words.json`),
        JSON.stringify({
          words: [
            { text: index ? "Второй" : "Первый", start: 0, end: 0.4, loss: 0 },
            { text: "кадр", start: 0.4, end: 0.8, loss: 0 },
          ],
        }),
      );
      return {
        id: sceneId,
        text: index ? "Второй кадр" : "Первый кадр",
        headline: index ? "Second scene" : "First scene",
        visualType: "title",
        durationInFrames: mode === "promo" ? 36 : 30,
        transitionDurationFrames: 6,
        ...(mode === "promo"
          ? {}
          : {
              presenterStartSec: index,
              presenterEndSec: index + 1,
              leftPanel: {
                kind: "text",
                text: index ? "Второй кадр" : "Первый кадр",
                size: "bigTitle",
                entrance: "fade",
              },
            }),
      };
    });
    const project = {
      ...base,
      scenes,
      ...(mode === "promo"
        ? {}
        : {
            talkingHead: {
              enabled: true,
              presenterVideo: `projects/${id}/talking-head/full.mp4`,
              audioSource: mode === "embedded" ? "embedded" : "elevenlabs",
              leftPanelCanvas: "light",
            },
          }),
    };
    writeFileSync(path.join(directory, "project.json"), JSON.stringify(project));
  }
  emitProgress("Bundling production Root with smoke-only offline font substitution");
  const serveUrl = await bundle({
    entryPoint: path.resolve("src/index.ts"),
    publicDir,
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
  for (const mode of ["promo", "embedded", "tts", "manual"] as const) {
    const plan = planProjectRender(`synthetic-${mode}-new-id`, undefined, fixtureRoot);
    // Promo and embedded cover every format; TTS/manual each cover one independent audio mode.
    const jobs = args["comparisons-only"]
      ? []
      : mode === "tts"
        ? plan.jobs.filter((job) => job.format === "square")
        : mode === "manual"
          ? plan.jobs.filter((job) => job.format === "landscape")
          : plan.jobs;
    for (const job of jobs) {
      emitProgress(`Rendering ${mode}/${job.format}, ${job.durationInFrames} frames`);
      const composition = await selectComposition({
        serveUrl,
        id: job.compositionId,
        inputProps: job.props,
        logLevel: "error",
      });
      assert.equal(composition.durationInFrames, job.durationInFrames);
      const output = path.join(root, `${mode}-${job.format}.mp4`);
      const started = Date.now();
      await renderMedia({
        serveUrl,
        composition,
        inputProps: job.props,
        outputLocation: output,
        codec: "h264",
        concurrency: 2,
        logLevel: "error",
        overwrite: true,
      });
      const probe = JSON.parse(
        local("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]).stdout,
      ) as {
        streams: { codec_type: string; width?: number; height?: number; nb_frames?: string }[];
        format: { duration: string };
      };
      const video = probe.streams.find((stream) => stream.codec_type === "video")!;
      assert.equal(Number(video.nb_frames), job.durationInFrames);
      assert.equal(video.width, composition.width);
      assert.equal(video.height, composition.height);
      assert.ok(
        probe.streams.some((stream) => stream.codec_type === "audio"),
        "Expected speech audio stream",
      );
      assert.ok(Math.abs(Number(probe.format.duration) - job.durationInFrames / 30) < 0.09);
      for (const frame of [27, 30, job.durationInFrames - 1]) {
        const screenshot = path.join(root, `${mode}-${job.format}-${frame}.png`);
        await renderStill({
          serveUrl,
          composition,
          inputProps: job.props,
          output: screenshot,
          frame,
          imageFormat: "png",
          logLevel: "error",
        });
        outputs.push(screenshot);
      }
      if (mode === "embedded") {
        const raw = path.join(root, `${mode}-${job.format}.f32`);
        local("ffmpeg", ["-v", "error", "-y", "-i", output, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", raw]);
        const buffer = readFileSync(raw);
        const rmsAt = (sec: number) => {
          let sum = 0;
          const start = Math.round(sec * 48000);
          const length = 4800;
          for (let i = start; i < start + length; i++) sum += buffer.readFloatLE(i * 4) ** 2;
          return Math.sqrt(sum / length);
        };
        const before = rmsAt(0.7),
          boundary = rmsAt(0.97),
          after = rmsAt(1.2);
        assert.ok(
          boundary / before > 0.8 && boundary / before < 1.2,
          `Embedded speech doubled or faded at boundary: ${boundary / before}`,
        );
        assert.ok(after / before > 0.8 && after / before < 1.2);
        cases.push({
          mode,
          format: job.format,
          durationInFrames: job.durationInFrames,
          elapsedMs: Date.now() - started,
          rms: { before, boundary, after },
        });
      } else
        cases.push({
          mode,
          format: job.format,
          durationInFrames: job.durationInFrames,
          elapsedMs: Date.now() - started,
        });
      outputs.push(output);
    }
  }
  const comparisons: { compositionId: string; frame: number; equal: boolean }[] = [];
  for (const [mode, format, compositionId] of [
    ["promo", "vertical", "Vertical"],
    ["promo", "square", "Square"],
  ] as const) {
    const job = planProjectRender(`synthetic-${mode}-new-id`, format, fixtureRoot).jobs[0];
    const composition = await selectComposition({
      serveUrl,
      id: compositionId,
      inputProps: job.props,
      logLevel: "error",
    });
    const snapshot = path.join(root, `${compositionId}-legacy-30.png`);
    await renderStill({
      serveUrl,
      composition,
      inputProps: job.props,
      output: snapshot,
      frame: 30,
      imageFormat: "png",
      logLevel: "error",
    });
    const equal = readFileSync(snapshot).equals(readFileSync(path.join(root, `${mode}-${format}-30.png`)));
    assert.ok(equal, `Generic and retained legacy composition differ: ${compositionId}`);
    comparisons.push({ compositionId, frame: 30, equal });
    outputs.push(snapshot);
  }
  const report = path.join(root, "report.json");
  const previous = args["comparisons-only"]
    ? (JSON.parse(readFileSync(report, "utf8")) as { cases: Record<string, unknown>[] })
    : undefined;
  const allCases = previous?.cases ?? cases;
  writeFileSync(
    report,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        apiCalls: 0,
        apiSpendUsd: 0,
        fontMode: "smoke-only Arial/Georgia substitute; typography QA pending",
        cases: allCases,
        comparisons,
      },
      null,
      2,
    ),
  );
  return { outputs: [report, ...outputs], metadata: { cases: allCases, comparisons, apiCalls: 0, apiSpendUsd: 0 } };
});
