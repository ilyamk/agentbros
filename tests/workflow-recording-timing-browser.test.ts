import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { planProjectRender } from "../src/lib/render-plan";
import { mediaProbe } from "../src/lib/audio/analysis";
import { hashFile } from "../src/lib/assets/registry";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { timingFixture, keepMasterBoundary, tone, colorAt } from "./workflow-recording-timing-fixtures";

test(
  "actual full-HD ProductionRoot VFR and 29.97 MP4 retain source clock, colors, complete conditional captions and one authentic speech",
  {
    skip: process.env.RUN_WORKFLOW_RENDER_TESTS !== "1",
    timeout: 360000,
  },
  async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "recording-timing-browser-")));
    const retained = path.resolve(
      process.env.WORKFLOW_ARTIFACTS_DIR ?? path.resolve(import.meta.dirname, "../out/qa/vfr-fullhd"),
      "recording-timing",
    );
    try {
      const fixtures = [];
      for (const mode of ["ntsc", "vfr", "vfr-boundary"] as const) {
        const fixture = timingFixture(root, mode);
        if (mode === "vfr-boundary") {
          fixture.four++;
          fixture.request.keepSpans[1].startFrame = fixture.four;
          fixture.request.cuts[0].endFrame = fixture.four;
          fixture.request.protectedSpans[1].startFrame = fixture.four;
          fixture.request.transcript.words[4].startFrame = fixture.four;
          fixture.request.transcript.words[4].endFrame = fixture.four + 4;
          fixture.request.transcript.words[5].startFrame = fixture.four + 4;
        }
        const plan = await runRecordingEditWorkflow(fixture.request, { action: "plan", rootDir: root });
        const reviewed = {
          ...fixture.request,
          review: {
            reviewer: "SYNTHETIC TECHNICAL FIXTURE ONLY",
            reviewedAt: "2026-10-11T00:00:00Z",
            approvedEditHash: plan.metadata.editHash,
            meaningPreserved: true,
          },
        };
        const created = await runRecordingEditWorkflow(reviewed, { action: "create", rootDir: root });
        fixtures.push({ mode, fixture, reviewed, created });
      }
      const serveUrl = await bundle({
        entryPoint: path.resolve("src/index.ts"),
        publicDir: path.join(root, "public"),
        outDir: path.join(root, "bundle"),
        webpackOverride: (config) => {
          const enabled = enableTailwind(config);
          return {
            ...enabled,
            resolve: {
              ...enabled.resolve,
              alias: {
                ...enabled.resolve?.alias,
                [path.resolve("src/lib/fonts")]: path.resolve("tests/fixtures/offline-fonts.ts"),
              },
            },
          };
        },
      });
      for (const { mode, fixture, reviewed, created } of fixtures) {
        const outputDir = path.join(retained, mode);
        mkdirSync(outputDir, { recursive: true });
        const job = planProjectRender(fixture.request.projectId, "landscape", root, { timeline: true }).jobs[0];
        const expectedFrames =
          keepMasterBoundary(fixture, fixture.two, "end") +
          keepMasterBoundary(fixture, fixture.pts.length, "end") -
          keepMasterBoundary(fixture, fixture.four, "start");
        assert.equal(job.durationInFrames, expectedFrames);
        const composition = await selectComposition({
          serveUrl,
          id: job.compositionId,
          inputProps: job.props,
          logLevel: "error",
        });
        const output = path.join(outputDir, "production-root-fullhd.mp4");
        await renderMedia({
          serveUrl,
          composition,
          inputProps: job.props,
          codec: "h264",
          outputLocation: output,
          concurrency: 1,
          scale: 1,
          logLevel: "error",
        });
        const probe = mediaProbe(output),
          video = probe.streams.find((s) => s.codec_type === "video")!;
        assert.equal(video.width, 1920);
        assert.equal(video.height, 1080);
        assert.equal(Number(video.nb_frames), expectedFrames);
        assert.equal(video.avg_frame_rate, "30/1");
        assert.equal(probe.streams.filter((s) => s.codec_type === "audio").length, 1);
        assert.ok(Math.abs(Number(video.duration) - expectedFrames / 30) < 0.0001);
        execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"], { timeout: 120000 });
        const cutFrame = keepMasterBoundary(fixture, fixture.two, "end"),
          cutSec = cutFrame / 30;
        const before = tone(output, 0.3),
          after = tone(output, cutSec + 0.3),
          tail = tone(output, expectedFrames / 30 - 0.35),
          original = tone(fixture.request.source.file, 0.3);
        assert.ok(Math.abs(before.hz - 440) <= 8, JSON.stringify(before));
        assert.ok(Math.abs(after.hz - 880) <= 8, JSON.stringify(after));
        assert.ok(Math.abs(tail.hz - 880) <= 8, "final spoken interval must preserve its source tone");
        assert.ok(
          before.rms / original.rms > 0.85 && before.rms / original.rms < 1.15,
          "authentic speech cannot double or disappear",
        );
        let firstPhoneme:
          { sourcePulse: number; outputPulse: number; sourceStartSec: number; sourcePhonemeSec: number } | undefined;
        if (mode === "vfr-boundary") {
          const start = keepMasterBoundary(fixture, fixture.four, "start") / 30;
          const pulseRms = (file: string, time: number) => {
            const bytes = execFileSync("ffmpeg", [
              "-v",
              "error",
              "-i",
              file,
              "-ss",
              String(time),
              "-t",
              "0.008",
              "-ac",
              "1",
              "-ar",
              "48000",
              "-f",
              "f32le",
              "-",
            ]);
            let square = 0;
            for (let i = 0; i < bytes.length; i += 4) square += bytes.readFloatLE(i) ** 2;
            return Math.sqrt(square / (bytes.length / 4));
          };
          const sourcePulse = pulseRms(fixture.request.source.file, 4.051);
          const outputPulse = pulseRms(output, cutSec + 4.051 - start);
          firstPhoneme = { sourcePulse, outputPulse, sourceStartSec: start, sourcePhonemeSec: 4.051 };
          assert.ok(
            sourcePulse > 0.2 && outputPulse > sourcePulse * 0.45,
            JSON.stringify({ sourcePulse, outputPulse, start, cutSec, firstPhonemeRetained: true }),
          );
        }
        const red = colorAt(output, 0.3),
          blue = colorAt(output, cutSec + 0.3);
        assert.ok(red[0] > red[1] + 100 && red[0] > red[2] + 100, JSON.stringify(red));
        assert.ok(blue[2] > blue[0] + 100 && blue[2] > blue[1] + 100, JSON.stringify(blue));
        const ir = new TimelineEditStore(
          path.join(root, "public/projects", fixture.request.projectId, "pipeline/timeline-edit.json"),
        ).read().timeline;
        const compiled = compileTimelineIR(ir);
        const captionClips = compiled.tracks.find((track) => track.kind === "captions")!.clips;
        const firstCondition = captionClips[1].captions[0],
          finalWord = captionClips[1].captions.at(-1)!;
        assert.equal(firstCondition.text, "Если");
        assert.equal(finalWord.text, "проверено.");
        assert.ok(firstCondition.start.num >= cutFrame);
        assert.ok(finalWord.end.num <= expectedFrames);
        const proofProps = { ...job.props, qaEvidence: true };
        const proofComposition = await selectComposition({
          serveUrl,
          id: job.compositionId,
          inputProps: proofProps,
          logLevel: "error",
        });
        const evidence: unknown[] = [];
        for (const [label, frame, expectedWord] of [
          ["negation", 5, "не"],
          ["condition-after-cut", firstCondition.start.num + 2, "Если"],
          ["final-word", expectedFrames - 10, "проверено."],
        ] as const) {
          let measurement:
            | { measurements: { role?: string; text: string; opacity: number }[]; findings: { code: string }[] }
            | undefined;
          await renderStill({
            serveUrl,
            composition: proofComposition,
            inputProps: proofProps,
            frame,
            output: path.join(outputDir, `${label}.png`),
            scale: 1,
            logLevel: "error",
            onBrowserLog: (log) => {
              if (log.text.startsWith("QA_EVIDENCE:")) {
                const measured = JSON.parse(log.text.slice(12));
                if (measured.frame === frame) measurement = measured;
              }
            },
          });
          assert.ok(
            measurement?.measurements.some(
              (row) => row.role === "spoken-caption" && row.text.includes(expectedWord) && row.opacity > 0.5,
            ),
            `${mode}: actual visible caption must preserve ${expectedWord}: ${JSON.stringify(measurement)}`,
          );
          assert.equal(
            measurement!.findings.filter((row) => ["TEXT_OVERLAP", "TEXT_CLIPPED", "TEXT_SAFEZONE"].includes(row.code))
              .length,
            0,
            JSON.stringify(measurement),
          );
          evidence.push({ label, frame, expectedWord, measurement });
        }
        copyFileSync(fixture.request.source.file, path.join(outputDir, "immutable-original.mp4"));
        for (const artifact of [
          "recording-edit.json",
          "recording-edit-transcript.json",
          "recording-edit-original-timeline.json",
          "timeline-edit.json",
          "asset-registry.json",
        ]) {
          copyFileSync(
            path.join(root, "public/projects", fixture.request.projectId, "pipeline", artifact),
            path.join(outputDir, artifact),
          );
        }
        assert.equal(hashFile(fixture.request.source.file), fixture.request.source.sha256);
        writeFileSync(
          path.join(outputDir, "acceptance.json"),
          JSON.stringify(
            {
              technicalOnly: true,
              apiCalls: 0,
              apiSpendUsd: 0,
              fontMode: "offline-fixture-not-production-font-proof",
              humanCreativeReviewRequired: true,
              sourcePts: fixture.pts,
              sourceDurationSec: fixture.duration,
              expectedFrames,
              cutFrame,
              reviewed,
              metadata: created.metadata,
              probe,
              tones: { original, before, after, tail },
              firstPhoneme,
              colors: { red, blue },
              evidence,
              normalization: JSON.parse(readFileSync(path.join(outputDir, "recording-edit.json"), "utf8"))
                .normalization,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
