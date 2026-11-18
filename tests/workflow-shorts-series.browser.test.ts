import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { planProjectRender } from "../src/lib/render-plan";
import { runShortsSeriesWorkflow, assertShortsSeriesReady } from "../src/lib/workflows/shorts-series";
import { shortsFixture, addSuppliedEducation } from "./workflow-shorts-series.fixture";

function frequency(file: string, time: number) {
  const pcm = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    String(time),
    "-i",
    file,
    "-t",
    "0.2",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "8000",
    "-f",
    "s16le",
    "pipe:1",
  ]);
  const candidates = [220, 440, 880, 1100];
  const energies = candidates.map((hz) => {
    let re = 0,
      im = 0;
    for (let i = 0; i < pcm.length / 2; i++) {
      const sample = pcm.readInt16LE(i * 2);
      re += sample * Math.cos((2 * Math.PI * hz * i) / 8000);
      im += sample * Math.sin((2 * Math.PI * hz * i) / 8000);
    }
    return re * re + im * im;
  });
  return candidates[energies.indexOf(Math.max(...energies))];
}

test(
  "three real ProductionRoot MP4 derivatives retain exact source audio and Russian caveat",
  { skip: process.env.RUN_WORKFLOW_RENDER_TESTS !== "1", timeout: 240000 },
  async (t) => {
    const fixture = shortsFixture(t);
    addSuppliedEducation(fixture, true);
    runShortsSeriesWorkflow(fixture.request, {
      action: "create",
      rootDir: fixture.root,
    });
    const retained = process.env.WORKFLOW_ARTIFACTS_DIR;
    if (retained && !path.isAbsolute(retained)) throw new Error("WORKFLOW_ARTIFACTS_DIR must be absolute");
    const output = retained ? path.join(retained, `shorts-series-${Date.now()}`) : path.join(fixture.root, "proof");
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "request.json"), JSON.stringify(fixture.request, null, 2));
    const serveUrl = await bundle({
      entryPoint: path.resolve("src/index.ts"),
      publicDir: path.join(fixture.root, "public"),
      outDir: path.join(fixture.root, "bundle"),
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
    for (const [id, seconds, tones] of [
      ["hook", 1, [220]],
      ["caveat", 2, [440, 880]],
      ["conclusion", 1, [1100]],
    ] as const) {
      const projectId = `technical-series-${id}`;
      const projectDirectory = path.join(fixture.root, "public/projects", projectId);
      assertShortsSeriesReady(projectDirectory, {
        rootDir: fixture.root,
        timeline: true,
      });
      const job = planProjectRender(projectId, "vertical", fixture.root, {
        timeline: true,
      }).jobs[0];
      const inputProps = { ...job.props, qaEvidence: true };
      const composition = await selectComposition({
        serveUrl,
        id: job.compositionId,
        inputProps,
      });
      const movie = path.join(output, `${id}.mp4`);
      await renderMedia({
        serveUrl,
        composition,
        inputProps: { ...job.props, qaEvidence: false },
        codec: "h264",
        outputLocation: movie,
        concurrency: 1,
        logLevel: "error",
        scale: 0.2,
      });
      const probe = JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", movie], {
          encoding: "utf8",
        }),
      );
      writeFileSync(path.join(output, `${id}.probe.json`), JSON.stringify(probe, null, 2));
      assert.ok(Math.abs(Number(probe.format.duration) - seconds) < 0.08);
      assert.ok(probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio"));
      assert.deepEqual(
        tones.map((_, i) => frequency(movie, i + 0.15)),
        [...tones],
      );
      const pixel = execFileSync("ffmpeg", [
        "-v",
        "error",
        "-ss",
        "0.15",
        "-i",
        movie,
        "-frames:v",
        "1",
        "-vf",
        "crop=2:2:(iw-2)/2:(ih-2)/2,format=rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ]);
      const rgb = [pixel[0], pixel[1], pixel[2]];
      const expectedChannel = id === "hook" ? 0 : 2;
      assert.ok(
        id === "conclusion"
          ? rgb[0] > 180 && rgb[1] > 180 && rgb[2] < 30
          : rgb[expectedChannel] > 80 && rgb[expectedChannel] > rgb[(expectedChannel + 1) % 3] * 2,
        `Wrong source video colour: ${rgb}`,
      );
      for (const [label, frame] of [
        ["start", 0],
        ["caption", id === "caveat" ? 10 : 10],
        ["tail", seconds * 30 - 1],
      ] as const) {
        let measurements = "";
        let rows: {
          text: string;
          font: string;
          role?: string;
          rect: { x: number; y: number; width: number };
        }[] = [];
        await renderStill({
          serveUrl,
          composition,
          inputProps,
          frame,
          output: path.join(output, `${id}-${label}.png`),
          logLevel: "error",
          onBrowserLog: (log) => {
            if (log.text.startsWith("QA_EVIDENCE:")) {
              const evidence = JSON.parse(log.text.slice(12));
              if (evidence.frame === frame) {
                measurements = JSON.stringify(evidence.measurements);
                rows = evidence.measurements;
              }
            }
          },
        });
        if (id === "caveat" && label === "caption") {
          assert.ok(measurements.includes("не"), measurements);
          const words = rows.filter((row) => row.role === "spoken-caption").sort((a, b) => a.rect.x - b.rect.x);
          assert.deepEqual(
            words.map((row) => row.text),
            ["Это", "не", "гарантия"],
          );
          const fontSize = Number(words[0].font.match(/([\d.]+)px/)?.[1]);
          assert.ok(fontSize > 0, "Font size must come from actual computed browser style");
          const gaps = words.slice(1).map((word, index) => word.rect.x - words[index].rect.x - words[index].rect.width);
          assert.ok(
            gaps.every((gap) => gap >= fontSize * 0.3 - 0.05),
            `Caption words join: computed font ${fontSize}, actual glyph gaps ${gaps}`,
          );
          writeFileSync(
            path.join(output, "caveat.caption-gaps.json"),
            JSON.stringify({ fontSize, gaps, words }, null, 2),
          );
        }
      }
      if (id === "caveat") {
        copyFileSync(
          path.join(projectDirectory, "pipeline/workflow-claims.json"),
          path.join(output, "caveat.claims.json"),
        );
        await renderStill({
          serveUrl,
          composition,
          inputProps,
          frame: 40,
          output: path.join(output, "caveat-condition.png"),
          logLevel: "error",
        });
      }
      copyFileSync(
        path.join(projectDirectory, "pipeline/shorts-evidence.json"),
        path.join(output, `${id}.evidence.json`),
      );
      // Square is independently registered from exactly the same source mapping.
      const square = planProjectRender(projectId, "square", fixture.root, {
        timeline: true,
      }).jobs[0];
      const squareComposition = await selectComposition({
        serveUrl,
        id: square.compositionId,
        inputProps: square.props,
      });
      assert.equal(squareComposition.width, squareComposition.height);
      await renderStill({
        serveUrl,
        composition: squareComposition,
        inputProps: square.props,
        frame: 10,
        output: path.join(output, `${id}-square.png`),
        logLevel: "error",
      });
    }
    if (retained) console.error(`Shorts visual evidence: ${output}`);
  },
);
