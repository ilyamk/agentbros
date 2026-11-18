import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { productAdFixture } from "./workflow-product-ad-fixtures";
import { runProductAdWorkflow } from "../src/lib/workflows/product-ad";
import { planProjectRender } from "../src/lib/render-plan";
import { FORMAT_CONFIGS } from "../src/types/video";
test(
  "product workflow renders real offline MP4 audio, owned captions and three requested format sizes",
  {
    skip: process.env.RUN_WORKFLOW_RENDER_TESTS !== "1",
    timeout: 600000,
  },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "product-ad-browser-"));
    const retained = process.env.WORKFLOW_ARTIFACTS_DIR
      ? path.resolve(process.env.WORKFLOW_ARTIFACTS_DIR, "product-ad")
      : undefined;
    try {
      const request = productAdFixture(root);
      runProductAdWorkflow(request, {
        action: "create",
        rootDir: root,
      });
      const output = retained ?? path.join(root, "acceptance");
      mkdirSync(output, {
        recursive: true,
      });
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
      const reports: unknown[] = [];
      for (const captions of ["off", "on"] as const) {
        for (const job of planProjectRender(request.projectId, undefined, root, {
          timeline: true,
          captions,
        }).jobs) {
          const composition = await selectComposition({
            serveUrl,
            id: job.compositionId,
            inputProps: job.props,
            logLevel: "error",
          });
          const video = path.join(output, `${job.format}-${captions === "on" ? "captioned" : "clean"}.mp4`);
          await renderMedia({
            serveUrl,
            composition,
            inputProps: job.props,
            outputLocation: video,
            codec: "h264",
            audioCodec: "aac",
            concurrency: 2,
            x264Preset: "ultrafast",
            logLevel: "error",
          });
          const probe = JSON.parse(
            execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", video], {
              encoding: "utf8",
            }),
          );
          const visual = probe.streams.find((s: any) => s.codec_type === "video"),
            audio = probe.streams.find((s: any) => s.codec_type === "audio");
          assert.equal(visual.width, FORMAT_CONFIGS[job.format].width);
          assert.equal(visual.height, FORMAT_CONFIGS[job.format].height);
          assert.ok(audio);
          assert.ok(Math.abs(Number(probe.format.duration) - 5) < 0.1);
          const loudness = execFileSync(
            "ffmpeg",
            ["-v", "error", "-i", video, "-f", "f32le", "-ac", "1", "-ar", "8000", "-"],
            {
              maxBuffer: 1024 * 1024,
            },
          );
          let energy = 0;
          let peak = 0;
          for (let i = 0; i < loudness.length; i += 4) {
            const sample = loudness.readFloatLE(i);
            energy += sample ** 2;
            peak = Math.max(peak, Math.abs(sample));
          }
          assert.ok(peak < 0.99, "fixture voice plus independent music must not clip");
          assert.ok(Math.sqrt(energy / (loudness.length / 4)) > 0.001, "rendered audio must not be silent");
          for (const frequency of [110, 440]) {
            let real = 0,
              imaginary = 0;
            const samples = loudness.length / 4;
            for (let i = 0; i < samples; i++) {
              const sample = loudness.readFloatLE(i * 4),
                angle = (2 * Math.PI * frequency * i) / 8000;
              real += sample * Math.cos(angle);
              imaginary += sample * Math.sin(angle);
            }
            assert.ok(
              (2 * Math.hypot(real, imaginary)) / samples > 0.0003,
              `actual output must contain independent ${frequency}Hz fixture music/voice component`,
            );
          }
          const proofProps = { ...job.props, qaEvidence: true };
          const proofComposition = await selectComposition({
            serveUrl,
            id: job.compositionId,
            inputProps: proofProps,
            logLevel: "error",
          });
          for (const [label, frame] of [
            ["start", 12],
            ["demo", 75],
            ["proof", 105],
            ["cta", 135],
            ["tail", 142],
          ] as const) {
            let ctaVisible = false;
            let ctaMeasurement = "";
            let ctaFindings: { code: string }[] = [];
            await renderStill({
              serveUrl,
              composition: proofComposition,
              inputProps: proofProps,
              frame,
              output: path.join(output, `${job.format}-${captions}-${label}.png`),
              imageFormat: "png",
              scale: 0.25,
              logLevel: "error",
              onBrowserLog: (log) => {
                if (!log.text.startsWith("QA_EVIDENCE:")) return;
                const measured = JSON.parse(log.text.slice(12));
                if (measured.frame !== frame || label !== "cta") return;
                ctaMeasurement = JSON.stringify(measured.measurements);
                const cta = measured.measurements.find(
                  (row: { role?: string; text: string; opacity: number }) =>
                    row.role === "media-subtext" && row.text.toLowerCase() === request.cta.url,
                );
                ctaVisible = !!cta && cta.opacity >= 0.95;
                ctaFindings = measured.findings;
              },
            });
            if (label === "cta") {
              assert.ok(
                ctaVisible,
                `CTA destination must become fully readable before the one-second scene exit: ${ctaMeasurement}`,
              );
              assert.equal(
                ctaFindings.filter((finding) =>
                  ["TEXT_OVERLAP", "TEXT_CLIPPED", "TEXT_SAFEZONE"].includes(finding.code),
                ).length,
                0,
                JSON.stringify(ctaFindings),
              );
            }
          }
          reports.push({
            format: job.format,
            variant: captions === "on" ? "captioned" : "clean",
            width: visual.width,
            height: visual.height,
            durationSec: Number(probe.format.duration),
            hasAudio: true,
            syntheticAudio: true,
            offlineTestFonts: "Arial/Georgia",
            productionReady: false,
          });
        }
      }
      for (const format of ["vertical", "square", "landscape"]) {
        assert.notDeepEqual(
          readFileSync(path.join(output, `${format}-on-demo.png`)),
          readFileSync(path.join(output, `${format}-off-demo.png`)),
          "supplied word captions must change rendered pixels",
        );
        const raw = execFileSync(
          "ffmpeg",
          ["-v", "error", "-i", path.join(output, `${format}-on-demo.png`), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
          {
            maxBuffer: 5 * 1024 * 1024,
          },
        );
        const size = FORMAT_CONFIGS[format as keyof typeof FORMAT_CONFIGS];
        const pixel = (Math.floor(size.height / 8) * Math.floor(size.width / 4) + Math.floor(size.width / 8)) * 3;
        assert.ok(
          raw[pixel + 1] > raw[pixel] + 30 && raw[pixel + 1] > raw[pixel + 2] + 30,
          "critical center product interaction/result must remain visible in every crop",
        );
      }
      writeFileSync(path.join(output, "probe-report.json"), JSON.stringify(reports, null, 2));
      writeFileSync(
        path.join(output, "ACCEPTANCE.txt"),
        "Synthetic technical fixtures and offline test fonts only. Human visual/audio/rights/claim approval remains pending. No services/API budget used.\n",
      );
      copyFileSync(
        path.join(root, "public/projects", request.projectId, "pipeline/captions.srt"),
        path.join(output, "captions.srt"),
      );
      if (retained) process.stderr.write(`Product ad workflow acceptance artifacts retained at ${output}\n`);
    } finally {
      rmSync(root, {
        recursive: true,
        force: true,
      });
    }
  },
);
