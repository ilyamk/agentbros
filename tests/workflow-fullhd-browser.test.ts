import test from "node:test";
import { assertFullHDFrameEvidence, type FullHDFrameEvidence } from "./workflow-fullhd-evidence";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  statSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { prepareLongformFonts, generateLongformFontAlias } from "./helpers/longform-fonts";
import { decodeAudioWindows } from "./helpers/streamed-audio";
import { startProcessTreeMonitor } from "./helpers/process-tree-monitor";
import { assembleChapters } from "../src/lib/longform/assembly";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { runEducationWorkflow } from "../src/lib/workflows/education";
import { educationFixture } from "./workflow-education-fixture";
import { projectChapterPlan, renderChapters } from "../src/lib/longform/runner";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { mediaProbe, analyzeAudio } from "../src/lib/audio/analysis";
const durationSec = Number(process.env.WORKFLOW_FULLHD_DURATION_SEC ?? 180);
if (![180, 600, 1200].includes(durationSec)) throw new Error("FullHD duration must be 180, 600 or 1200 seconds");
const chapterSec = durationSec / 6;
const beatFrames = (durationSec * 30) / 36;
for (const long of [true])
  test(
    `fullHD actual ProductionRoot ${durationSec}s six-chapter render, decode, boundary audio and selective reuse`,
    {
      skip: process.env.RUN_WORKFLOW_FULLHD_TESTS !== "1",
      timeout: 3600000,
    },
    async () => {
      const started = Date.now();
      const f = educationFixture(long);
      const artifact = process.env.WORKFLOW_ARTIFACTS_DIR
        ? path.resolve(
            process.env.WORKFLOW_ARTIFACTS_DIR,
            durationSec === 180 ? "fullhd-longform" : `fullhd-${durationSec}s`,
          )
        : undefined;
      if (artifact) mkdirSync(artifact, { recursive: true });
      const monitor = artifact ? startProcessTreeMonitor(path.join(artifact, "process-tree-memory.json")) : undefined;
      const resume = process.env.RUN_WORKFLOW_FULLHD_RESUME === "1";
      const originalFixtureRoot = f.root;
      try {
        await monitor?.ready;
        if (long) {
          const template = f.request.chapters[0];
          // Each chapter has a distinct local diagnostic tone, never synthetic speech.
          const toneArgs = Array.from({ length: 6 }, (_, ch) => [
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=${330 + ch * 55}:duration=${chapterSec}`,
          ]).flat();
          const tones = spawnSync(
            "ffmpeg",
            [
              "-v",
              "error",
              "-y",
              ...toneArgs,
              "-filter_complex",
              "[0:a][1:a][2:a][3:a][4:a][5:a]concat=n=6:v=0:a=1[a]",
              "-map",
              "[a]",
              "-c:a",
              "pcm_s16le",
              path.join(f.root, "voice.wav"),
            ],
            { encoding: "utf8" },
          );
          assert.equal(tones.status, 0, tones.stderr);
          const { hashFile } = await import("../src/lib/assets/registry");
          f.request.media.find((m) => m.id === "voice")!.sha256 = hashFile(path.join(f.root, "voice.wav"));
          const music = spawnSync(
            "ffmpeg",
            [
              "-v",
              "error",
              "-y",
              "-f",
              "lavfi",
              "-i",
              `sine=frequency=110:duration=${durationSec}`,
              "-c:a",
              "pcm_s16le",
              path.join(f.root, "music.wav"),
            ],
            { encoding: "utf8" },
          );
          assert.equal(music.status, 0, music.stderr);
          f.request.media.find((m) => m.id === "music")!.sha256 = hashFile(path.join(f.root, "music.wav"));
          f.request.chapters = Array.from({ length: 6 }, (_, ch) => ({
            ...structuredClone(template),
            id: `chapter-${ch}`,
            title: `Proportions ${ch + 1}`,
            beats: template.beats.map((b, i) => ({
              ...b,
              id: `beat-${ch}-${i}`,
              durationFrames: beatFrames,
              sourceStartFrame: (ch * 6 + i) * beatFrames,
              captions: b.spokenText.split(" ").map((text, j, words) => ({
                text,
                startFrame: Math.floor((j * beatFrames) / words.length),
                endFrame: Math.floor(((j + 1) * beatFrames) / words.length),
              })),
            })),
          }));
        }
        if (resume) {
          assert.ok(artifact, "Resume needs retained artifact directory");
          const cached = JSON.parse(
            readFileSync(
              path.join(artifact, "initial-render-cache/education-demo/chapters/landscape/cache.json"),
              "utf8",
            ),
          );
          const restoreRoot = Object.values(cached)[0] as { output: string };
          const restored = restoreRoot.output.split(`${path.sep}out${path.sep}`)[0];
          assert.equal(path.dirname(restored), realpathSync(tmpdir()));
          assert.ok(path.basename(restored).startsWith("education-workflow-"));
          assert.equal(existsSync(restored), false, "Never overwrite an existing fixture on resume");
          mkdirSync(path.join(restored, "public/projects"), { recursive: true });
          cpSync(path.join(artifact, "initial-project"), path.join(restored, "public/projects/education-demo"), {
            recursive: true,
          });
          cpSync(path.join(artifact, "initial-render-cache"), path.join(restored, "out"), { recursive: true });
          f.root = restored;
        }
        const result = resume
          ? {
              metadata: {
                resumedRetainedActualRender: true,
                chapterManifest: JSON.parse(
                  readFileSync(path.join(f.root, "public/projects/education-demo/pipeline/chapters.json"), "utf8"),
                ),
              },
            }
          : runEducationWorkflow(f.request, {
              action: "create",
              rootDir: f.root,
            });
        const manifest = result.metadata.chapterManifest;
        const localFonts =
          durationSec > 180
            ? resume
              ? generateLongformFontAlias(
                  f.root,
                  f.request.projectId,
                  path.join(f.root, "public/projects", f.request.projectId, "fonts.json"),
                )
              : prepareLongformFonts(f.root, f.request.projectId)
            : undefined;
        const plan = projectChapterPlan(f.request.projectId, manifest, {
          rootDir: f.root,
          codeDir: process.cwd(),
          fontContext: localFonts?.context,
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
                  [path.resolve("src/lib/fonts")]: localFonts?.alias ?? path.resolve("tests/fixtures/offline-fonts.ts"),
                },
              },
            };
          },
        });
        const render = async (job: (typeof plan.jobs)[number], output: string) => {
          let lastProgress = 0;
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
            concurrency: 2,
            logLevel: "error",
            scale: 1,
            onProgress: (progress) => {
              if (Date.now() - lastProgress < 30000) return;
              lastProgress = Date.now();
              process.stderr.write(
                `FullHD ${durationSec}s ${job.chapterId}: ${progress.renderedFrames}/${job.durationInFrames} rendered frames\n`,
              );
            },
          });
        };
        const initialStarted = Date.now();
        if (resume)
          assert.ok(
            plan.jobs.every((j) => j.action === "reuse"),
            "Recovery must reuse all actual rendered chunks",
          );
        const rendered = await renderChapters(plan, {
          dryRun: false,
          render: resume
            ? async () => {
                throw new Error("Recovery must not re-render initial full-HD chapters");
              }
            : render,
        });
        const initialRenderMs = Date.now() - initialStarted;
        assert.equal(rendered.outputs.length, long ? 6 : 2);
        const assemblyStarted = Date.now();
        const assembly = assembleChapters(plan, rendered, { rootDir: f.root });
        const assemblyMs = Date.now() - assemblyStarted;
        const assembled = assembly.outputs[0];
        assert.equal(assembly.metadata.totalFrames, durationSec * 30);
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
        assert.ok(Math.abs(Number(probe.format.duration) - durationSec) < 0.1);
        assert.ok(probe.streams.some((s) => s.codec_type === "audio"));
        if (artifact) {
          cpSync(path.join(f.root, "out"), path.join(artifact, "initial-render-cache"), { recursive: true });
          cpSync(path.join(f.root, "public/projects", f.request.projectId), path.join(artifact, "initial-project"), {
            recursive: true,
          });
        }
        const audio = analyzeAudio(assembled);
        assert.ok(audio.integratedLufs !== null && audio.integratedLufs > -60);
        assert.equal(audio.silence.length, 0);
        const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", assembled, "-f", "null", "-"], {
          encoding: "utf8",
          timeout: 120000,
        });
        assert.equal(decoded.status, 0, decoded.stderr);
        const video = probe.streams.find((s) => s.codec_type === "video")!;
        assert.equal(video.width, 1920);
        assert.equal(video.height, 1080);
        assert.equal(video.avg_frame_rate, "30/1");
        assert.equal(Number(video.nb_frames), durationSec * 30);
        // Full decoded samples prove authentic per-chapter timing on both sides of every cut.
        const boundarySeconds = Array.from({ length: 6 }, (_, ch) => [
          ch * chapterSec + 0.25,
          (ch + 1) * chapterSec - 0.25,
        ]).flat();
        const pcm = await decodeAudioWindows(
          assembled,
          boundarySeconds.map((sec) => ({ startSample: Math.round(sec * 48000), samples: 4800 })),
        );
        assert.ok(Math.abs(pcm.totalSamples - durationSec * 48000) <= 1024);
        const amplitude = (sec: number, hz: number) => {
          let real = 0,
            imaginary = 0;
          const start = Math.round(sec * 48000),
            length = 4800;
          for (let i = 0; i < length; i++) {
            const sample = pcm.windows.find((w) => w.startSample === start)!.data.readFloatLE(i * 4);
            const angle = (2 * Math.PI * hz * i) / 48000;
            real += sample * Math.cos(angle);
            imaginary += sample * Math.sin(angle);
          }
          return Math.hypot(real, imaginary) / length;
        };
        const boundaries: Array<{ seconds: number; frequency: number; amplitude: number }> = [];
        for (let ch = 0; ch < 6; ch++)
          for (const sec of [ch * chapterSec + 0.25, (ch + 1) * chapterSec - 0.25]) {
            const hz = 330 + ch * 55,
              strength = amplitude(sec, hz);
            assert.ok(strength > 0.01, `Expected chapter ${ch} tone ${hz} at ${sec}s, amplitude ${strength}`);
            for (let other = 0; other < 6; other++)
              if (other !== ch)
                assert.ok(
                  strength > amplitude(sec, 330 + other * 55) * 8,
                  "Chapter boundary cannot retain adjacent source tone",
                );
            boundaries.push({ seconds: sec, frequency: hz, amplitude: strength });
          }
        // Inspect decoded output pixels, not just metadata or separately rendered stills.
        const frames = [
          15,
          beatFrames - 1,
          beatFrames + 15,
          ...Array.from({ length: 5 }, (_, i) => [
            (i + 1) * chapterSec * 30 - 15,
            (i + 1) * chapterSec * 30 + 15,
          ]).flat(),
          durationSec * 30 - 15,
          durationSec * 30 - 1,
        ];
        const pixels: Array<{ frame: number; rgb: number[] }> = [];
        for (const frame of frames) {
          const pixel = spawnSync(
            "ffmpeg",
            [
              "-v",
              "error",
              "-ss",
              String(Math.floor((frame / 30) * 1e6) / 1e6),
              "-i",
              assembled,
              "-vf",
              "format=rgb24,crop=1:1:960:180",
              "-frames:v",
              "1",
              "-f",
              "rawvideo",
              "-pix_fmt",
              "rgb24",
              "pipe:1",
            ],
            { timeout: 120000 },
          );
          assert.equal(pixel.status, 0, pixel.stderr.toString());
          assert.equal(pixel.stdout.length, 3);
          const rgb = [...pixel.stdout];
          assert.ok(Math.max(...rgb) > 3, `No black tail/frame ${frame}: ${rgb}`);
          {
            const orange = Math.floor(frame / beatFrames) % 2 === 1;
            assert.ok(
              orange ? rgb[0] > rgb[2] + 10 : rgb[1] > rgb[0] + 10 && rgb[2] > rgb[0] + 10,
              `Expected source colour at frame ${frame}: ${rgb}`,
            );
          }
          pixels.push({ frame, rgb });
          if (artifact) {
            const image = spawnSync(
              "ffmpeg",
              [
                "-v",
                "error",
                "-ss",
                String(Math.floor((frame / 30) * 1e6) / 1e6),
                "-i",
                assembled,
                "-frames:v",
                "1",
                "-y",
                path.join(artifact, `decoded-${frame}.png`),
              ],
              { timeout: 120000 },
            );
            assert.equal(image.status, 0, image.stderr.toString());
          }
        }
        if (artifact)
          writeFileSync(
            path.join(artifact, "boundary-evidence.json"),
            JSON.stringify({ boundaries, pixels, decodedAudioSamples: pcm.totalSamples }, null, 2),
          );
        const reused = projectChapterPlan(f.request.projectId, manifest, {
          rootDir: f.root,
          fontContext: localFonts?.context,
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
        const qaFrames: FullHDFrameEvidence[] = [];
        const props = { ...lastJob.props, qaEvidence: true };
        const composition = await selectComposition({
          serveUrl,
          id: lastJob.compositionId,
          inputProps: props,
        });
        for (const [label, frame] of [
          ["chapter", 15],
          ["worked-example", beatFrames * 3 + 15],
          ["recap", beatFrames * 5 + 15],
          ["tail", lastJob.durationInFrames - 1],
        ] as const) {
          const output = path.join(f.root, `${label}.png`);
          let finalEvidence: FullHDFrameEvidence | undefined;
          await renderStill({
            serveUrl,
            composition,
            inputProps: props,
            frame,
            output,
            logLevel: "error",
            onBrowserLog: (log) => {
              if (!log.text.startsWith("QA_EVIDENCE:")) return;
              const evidence = JSON.parse(log.text.slice(12)) as FullHDFrameEvidence;
              if (evidence.frame === frame) finalEvidence = evidence;
            },
          });
          assert.ok(finalEvidence, `Frame ${frame} QA probe missing`);
          assertFullHDFrameEvidence(finalEvidence);
          qaFrames.push(finalEvidence);
          captionMounted = true;
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
          fontContext: localFonts?.context,
        });
        assert.equal(updated.jobs.filter((j) => j.action === "render").length, 1);
        assert.equal(updated.jobs[1].action, "render");
        let count = 0;
        const selectiveStarted = Date.now();
        await renderChapters(updated, {
          dryRun: false,
          render: async (j, o) => {
            count++;
            await render(j, o);
          },
        });
        assert.equal(count, 1);
        const selectiveMs = Date.now() - selectiveStarted;
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
                localFontManifest: localFonts?.manifest,
                audioDecode: { samples: pcm.totalSamples, retainedWindowBytes: pcm.retainedBytes },
                metadata: result.metadata,
                timings: { initialRenderMs, assemblyMs, selectiveMs, totalMs: Date.now() - started },
                resumedRetainedActualRender: resume,
                fileBytes: statSync(assembled).size,
                dimensions: { width: 1920, height: 1080, scale: 1, fps: 30 },
                cacheActions: updated.jobs.map((j) => ({
                  id: j.chapterId,
                  action: j.action,
                })),
              },
              null,
              2,
            ),
          );
          writeFileSync(path.join(artifact, "qa-evidence.json"), JSON.stringify(qaFrames, null, 2));
          cpSync(path.join(f.root, "out"), path.join(artifact, "render-cache"), { recursive: true });
          cpSync(path.join(f.root, "public/projects", f.request.projectId), path.join(artifact, "project"), {
            recursive: true,
          });
          copyFileSync(
            path.join(f.root, "public/projects", f.request.projectId, "pipeline/education.json"),
            path.join(artifact, "treatment.json"),
          );
        }
      } finally {
        try {
          await monitor?.stop();
        } finally {
          if (resume && f.root !== originalFixtureRoot) rmSync(f.root, { recursive: true, force: true });
          f.cleanup();
        }
      }
    },
  );
