import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assembleChapters } from "../src/lib/longform/assembly";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { runEducationWorkflow } from "../src/lib/workflows/education";
import { educationFixture } from "./workflow-education-fixture";
import { projectChapterPlan, renderChapters } from "../src/lib/longform/runner";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { mediaProbe, analyzeAudio } from "../src/lib/audio/analysis";
import type { measureCompositionText } from "../src/lib/qa-evidence/measure";
for (const long of [false, true])
  test(
    `actual ProductionRoot education ${long ? "180s six-chapter" : "12s short"} render, audio, captions and selective reuse`,
    {
      skip: process.env.RUN_WORKFLOW_RENDER_TESTS !== "1" || (long && process.env.RUN_WORKFLOW_LONGFORM_TESTS !== "1"),
      timeout: 900000,
    },
    async () => {
      const f = educationFixture(long);
      const artifact = process.env.WORKFLOW_ARTIFACTS_DIR
        ? path.resolve(process.env.WORKFLOW_ARTIFACTS_DIR, long ? "education-long" : "education-short")
        : undefined;
      if (artifact) mkdirSync(artifact, { recursive: true });
      if (long) {
        const template = f.request.chapters[0];
        f.request.chapters = Array.from({ length: 6 }, (_, ch) => ({
          ...structuredClone(template),
          id: `chapter-${ch}`,
          title: `Proportions ${ch + 1}`,
          beats: template.beats.map((b, i) => ({
            ...b,
            id: `beat-${ch}-${i}`,
            durationFrames: 150,
            sourceStartFrame: (ch * 6 + i) * 150,
            captions: b.spokenText.split(" ").map((text, j, words) => ({
              text,
              startFrame: Math.floor((j * 150) / words.length),
              endFrame: Math.floor(((j + 1) * 150) / words.length),
            })),
          })),
        }));
      }
      try {
        const result = runEducationWorkflow(f.request, {
          action: "create",
          rootDir: f.root,
        });
        const manifest = result.metadata.chapterManifest;
        const plan = projectChapterPlan(f.request.projectId, manifest, {
          rootDir: f.root,
          codeDir: process.cwd(),
        });
        const serveUrl = await bundle({
          entryPoint: path.resolve("src/index.ts"),
          publicDir: path.join(f.root, "public"),
          outDir: path.join(f.root, "bundle"),
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
        const render = async (job: (typeof plan.jobs)[number], output: string) => {
          const composition = await selectComposition({
            serveUrl,
            id: job.compositionId,
            inputProps: job.props,
          });
          await renderMedia({
            serveUrl,
            composition,
            inputProps: job.props,
            codec: "h264",
            outputLocation: output,
            concurrency: 1,
            logLevel: "error",
            scale: long ? 0.15 : 0.25,
          });
        };
        const rendered = await renderChapters(plan, { dryRun: false, render });
        assert.equal(rendered.outputs.length, long ? 6 : 2);
        const assembly = assembleChapters(plan, rendered, { rootDir: f.root });
        const assembled = assembly.outputs[0];
        assert.equal(assembly.metadata.totalFrames, long ? 5400 : 360);
        assert.equal(assembleChapters(plan, rendered, { rootDir: f.root }).metadata.reused, true);
        const probe = mediaProbe(assembled);
        if (artifact) {
          copyFileSync(assembled, path.join(artifact, "education.mp4"));
          copyFileSync(assembly.outputs[1], path.join(artifact, "assembly.json"));
          writeFileSync(
            path.join(artifact, "probe.json"),
            JSON.stringify(
              {
                label: "Synthetic technical fixture; not final narration",
                probe,
              },
              null,
              2,
            ),
          );
        }
        assert.ok(Math.abs(Number(probe.format.duration) - (long ? 180 : 12)) < 0.1);
        assert.ok(probe.streams.some((s) => s.codec_type === "audio"));
        const audio = analyzeAudio(assembled);
        assert.ok(audio.integratedLufs !== null && audio.integratedLufs > -60);
        assert.equal(audio.silence.length, 0);
        const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", assembled, "-f", "null", "-"], {
          encoding: "utf8",
          timeout: 120000,
        });
        assert.equal(decoded.status, 0, decoded.stderr);
        const video = probe.streams.find((s) => s.codec_type === "video")!;
        assert.equal(Number(video.nb_frames), (long ? 180 : 12) * 30);
        const reused = projectChapterPlan(f.request.projectId, manifest, {
          rootDir: f.root,
        });
        assert.ok(reused.jobs.every((j) => j.action === "reuse"));
        await renderChapters(reused, {
          dryRun: false,
          render: async () => {
            throw new Error("Paid/repeated generation or render forbidden on cache hit");
          },
        });
        const lastJob = plan.jobs.at(-1)!;
        let captionMounted = false;
        const props = { ...lastJob.props, qaEvidence: true };
        const composition = await selectComposition({
          serveUrl,
          id: lastJob.compositionId,
          inputProps: props,
        });
        for (const [label, frame] of [
          ["chapter", 15],
          ["worked-example", long ? 465 : 105],
          ["recap", long ? 765 : 165],
          ["tail", lastJob.durationInFrames - 1],
        ] as const) {
          const output = path.join(f.root, `${label}.png`);
          let measurement: ReturnType<typeof measureCompositionText> | undefined;
          await renderStill({
            serveUrl,
            composition,
            inputProps: props,
            frame,
            output,
            logLevel: "error",
            onBrowserLog: (log) => {
              if (log.text.startsWith("QA_EVIDENCE:")) {
                const e = JSON.parse(log.text.slice(12));
                if (e.frame === frame) measurement = e;
              }
            },
          });
          // The final measurement describes the rendered viewport; premount
          // mutations may temporarily report an offscreen composition.
          assert.ok(measurement, "Actual composition measurement required");
          assert.equal(measurement.fontsReady, true);
          assert.deepEqual(measurement.findings, []);
          assert.ok(measurement.measurements.every((row) => row.loaded));
          const title = measurement.measurements.find((row) => row.role === "media-headline");
          assert.ok(title, "Actual instructional title must be mounted");
          const captions = measurement.measurements.filter((row) => row.role === "spoken-caption");
          if (captions.length) captionMounted = true;
          for (const word of captions)
            assert.ok(
              title.rect.y + title.rect.height <= word.rect.y,
              "Editorial title must not collide with spoken caption",
            );
          if (artifact) copyFileSync(output, path.join(artifact, `${label}.png`));
        }
        assert.ok(captionMounted, "Actual timed caption glyph is mounted in production composition");
        const store = new TimelineEditStore(
          path.join(f.root, "public/projects", f.request.projectId, "pipeline/timeline-edit.json"),
        );
        const document = store.read();
        document.timeline.tracks[0].clips[7].payload!.lessonEvidenceHash = "changed evidence review";
        writeFileSync(
          path.join(f.root, "public/projects", f.request.projectId, "pipeline/timeline-edit.json"),
          JSON.stringify(document),
        );
        const updated = projectChapterPlan(f.request.projectId, manifest, {
          rootDir: f.root,
        });
        assert.equal(updated.jobs.filter((j) => j.action === "render").length, 1);
        assert.equal(updated.jobs[1].action, "render");
        let count = 0;
        await renderChapters(updated, {
          dryRun: false,
          render: async (j, o) => {
            count++;
            await render(j, o);
          },
        });
        assert.equal(count, 1);
        if (artifact) {
          copyFileSync(assembled, path.join(artifact, "education.mp4"));
          copyFileSync(assembly.outputs[1], path.join(artifact, "assembly.json"));
          writeFileSync(
            path.join(artifact, "probe.json"),
            JSON.stringify(
              {
                label:
                  "Synthetic offline technical test: tones are not speech; solid test images are not final educational visuals",
                probe,
                audio,
                metadata: result.metadata,
                cacheActions: updated.jobs.map((j) => ({
                  id: j.chapterId,
                  action: j.action,
                })),
              },
              null,
              2,
            ),
          );
          copyFileSync(
            path.join(f.root, "public/projects", f.request.projectId, "pipeline/education.json"),
            path.join(artifact, "treatment.json"),
          );
        }
      } finally {
        f.cleanup();
      }
    },
  );
test(
  "video worked-example preserves nonzero original source trim, instructional title and caption layout",
  { skip: process.env.RUN_WORKFLOW_RENDER_TESTS !== "1", timeout: 120000 },
  async () => {
    const f = educationFixture();
    try {
      const file = path.join(f.root, "motion.mp4");
      const made = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=red:s=640x360:r=30:d=2",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=640x360:r=30:d=2",
          "-filter_complex",
          "[0:v][1:v]concat=n=2:v=1:a=0[v]",
          "-map",
          "[v]",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          file,
        ],
        { encoding: "utf8" },
      );
      assert.equal(made.status, 0, made.stderr);
      const { hashFile } = await import("../src/lib/assets/registry");
      const source = f.request.media[0];
      f.request.media.push({
        ...structuredClone(source),
        id: "motion",
        kind: "video",
        file,
        sha256: hashFile(file),
      });
      f.request.chapters[0].beats[3].visualId = "motion";
      f.request.chapters[0].beats[3].visualStartFrame = 60;
      const created = runEducationWorkflow(f.request, {
        action: "create",
        rootDir: f.root,
      });
      const plan = projectChapterPlan(f.request.projectId, created.metadata.chapterManifest, { rootDir: f.root });
      const job = plan.jobs[0];
      assert.equal(job.timeline.tracks[0].clips[3].source.start.num, 60);
      const serveUrl = await bundle({
        entryPoint: path.resolve("src/index.ts"),
        publicDir: path.join(f.root, "public"),
        outDir: path.join(f.root, "bundle"),
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
      const props = { ...job.props, qaEvidence: true },
        composition = await selectComposition({
          serveUrl,
          id: job.compositionId,
          inputProps: props,
        });
      let evidence:
        | {
            measurements: Array<{
              text: string;
              role: string;
              rect: { x: number; y: number; width: number; height: number };
            }>;
            findings: Array<{ code: string }>;
          }
        | undefined;
      const image = path.join(f.root, "video-proof.png");
      await renderStill({
        serveUrl,
        composition,
        inputProps: props,
        frame: 105,
        output: image,
        logLevel: "error",
        onBrowserLog: (log) => {
          if (!log.text.startsWith("QA_EVIDENCE:")) return;
          const e = JSON.parse(log.text.slice(12));
          if (e.frame === 105) evidence = e;
        },
      });
      assert.ok(evidence);
      const headline = evidence.measurements.find((m) => m.text === "2 ÷ 4 = 0.5");
      assert.ok(headline);
      const captions = evidence.measurements.filter((m) => m.role === "spoken-caption");
      assert.ok(captions.length);
      for (const word of captions)
        assert.ok(
          headline.rect.y + headline.rect.height <= word.rect.y,
          `Video headline must be above captions: ${JSON.stringify({ headline, word })}`,
        );
      assert.equal(evidence.findings.length, 0);
      const title = true,
        caption = true;
      const pixel = spawnSync("ffmpeg", [
        "-v",
        "error",
        "-i",
        image,
        "-vf",
        "crop=1:1:960:180",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ]);
      assert.equal(pixel.status, 0);
      assert.equal(pixel.stdout.length, 3);
      assert.ok(
        pixel.stdout[2] > 100 && pixel.stdout[2] > pixel.stdout[0] * 2,
        "Pixel must be blue source at2.5s, never red at0.5s",
      );
      if (process.env.WORKFLOW_ARTIFACTS_DIR) {
        const dir = path.resolve(process.env.WORKFLOW_ARTIFACTS_DIR, "education-video");
        mkdirSync(dir, { recursive: true });
        copyFileSync(image, path.join(dir, "worked-example.png"));
        writeFileSync(
          path.join(dir, "source-proof.json"),
          JSON.stringify(
            {
              sourceSha256: hashFile(file),
              originalSourceStartFrame: 60,
              renderFrame: 105,
              expectedColor: "blue",
              actualRgb: [...pixel.stdout],
              headline: title,
              captions: caption,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      f.cleanup();
    }
  },
);
