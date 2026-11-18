import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, cpSync, copyFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { selectComposition, renderStill } from "@remotion/renderer";
import { educationFixture } from "./workflow-education-fixture";
import { runEducationWorkflow } from "../src/lib/workflows/education";
import { hashFile, importAsset } from "../src/lib/assets/registry";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { projectChapterPlan, renderChapters, remotionChapterBackend } from "../src/lib/longform/runner";
import { assembleChapters } from "../src/lib/longform/assembly";
import { mediaProbe, analyzeAudio } from "../src/lib/audio/analysis";
import { prepareLongformFonts } from "./helpers/longform-fonts";
import { decodeAudioWindows } from "./helpers/streamed-audio";
import { startProcessTreeMonitor } from "./helpers/process-tree-monitor";
import { assertFullHDFrameEvidence, type FullHDFrameEvidence } from "./workflow-fullhd-evidence";
import { DENSE_LAYERS, assertDensePixel, denseProbeFrames, type DensePixel } from "./workflow-dense-fullhd-evidence";

const durationSec = Number(process.env.WORKFLOW_DENSE_DURATION_SEC ?? 30);
if (![30, 180].includes(durationSec)) throw new Error("Dense diagnostic duration must be 30 or 180 seconds");
test(
  `actual dense ${durationSec}s Full HD, three independent decoders, original fonts and selective cache`,
  { skip: process.env.RUN_WORKFLOW_DENSE_FULLHD_TESTS !== "1", timeout: 1800000 },
  async () => {
    const started = Date.now(),
      loadedRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const artifact = path.resolve(process.env.WORKFLOW_ARTIFACTS_DIR ?? "out/qa/dense-fullhd", `dense-${durationSec}s`);
    mkdirSync(artifact, { recursive: true });
    const monitor = startProcessTreeMonitor(path.join(artifact, "process-tree-memory.json"));
    let fixture: ReturnType<typeof educationFixture> | undefined;
    try {
      await monitor.ready;
      fixture = educationFixture(false);
      const f = fixture,
        projectId = f.request.projectId,
        chapterFrames = durationSec * 10,
        beatFrames = chapterFrames / 6;
      const ff = (args: string[], binary = false) => {
        const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], {
          timeout: 180000,
          maxBuffer: 4 * 1024 * 1024,
        });
        assert.equal(result.status, 0, result.stderr.toString());
        return binary ? result.stdout : result.stdout.toString();
      };
      const toneInputs = Array.from({ length: 3 }, (_, ch) => [
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${330 + 60 * ch}:sample_rate=48000:duration=${durationSec / 3}`,
      ]).flat();
      ff([
        ...toneInputs,
        "-filter_complex",
        "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]",
        "-map",
        "[a]",
        "-c:a",
        "pcm_s16le",
        path.join(f.root, "voice.wav"),
      ]);
      ff([
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=110:sample_rate=48000:duration=${durationSec}`,
        "-c:a",
        "pcm_s16le",
        path.join(f.root, "music.wav"),
      ]);
      for (const id of ["voice", "music"])
        f.request.media.find((m) => m.id === id)!.sha256 = hashFile(path.join(f.root, `${id}.wav`));
      const template = f.request.chapters[0];
      f.request.chapters = Array.from({ length: 3 }, (_, ch) => ({
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
      const workflow = runEducationWorkflow(f.request, { action: "create", rootDir: f.root });
      const journal = path.join(f.root, "public/projects", projectId, "pipeline/timeline-edit.json"),
        store = new TimelineEditStore(journal);
      const sourceMetadata = [];
      for (const layer of DENSE_LAYERS) {
        const original = path.join(f.root, `${layer.id}.mp4`),
          sourceEnd = layer.trim + (durationSec * 30 * layer.rate.num) / layer.rate.den;
        ff([
          "-f",
          "lavfi",
          "-i",
          `color=c=${layer.color}:s=${layer.width}x${layer.height}:r=30:d=${(sourceEnd + 30) / 30}`,
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${layer.sentinel}:sample_rate=48000:duration=${(sourceEnd + 30) / 30}`,
          "-vf",
          `drawbox=x=0:y=0:w=iw:h=ih:color=${layer.darkColor}:t=fill:enable='lt(mod(t*30,120),60)'`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "20",
          "-threads",
          "2",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-shortest",
          original,
        ]);
        // Validate actual original palette before spending time on a browser render.
        for (const sourceFrame of [0, 75]) {
          const sourcePixel = [
            ...(ff(
              [
                "-ss",
                String(sourceFrame / 30),
                "-i",
                original,
                "-vf",
                "format=rgb24,crop=1:1:100:100",
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
              ],
              true,
            ) as Buffer),
          ];
          assert.ok(
            sourcePixel[layer.channel] > Math.max(...sourcePixel.filter((_, i) => i !== layer.channel)) + 50,
            "Original palette must preserve a saturated phase marker",
          );
          assert.ok(
            sourceFrame === 0
              ? sourcePixel[layer.channel] > 75 && sourcePixel[layer.channel] < 145
              : sourcePixel[layer.channel] > 185,
            "Original phase must match encoded source clock",
          );
        }
        const imported = importAsset({
          projectId,
          sourceFile: original,
          rootDir: f.root,
          provenance: f.request.media[0].provenance,
          rights: f.request.media[0].rights,
        });
        const prior = store.read();
        store.apply(
          {
            type: "add-track",
            track: {
              id: `decoder-${layer.id}`,
              kind: "visual",
              clips: [
                {
                  id: `source-${layer.id}`,
                  assetId: imported.asset.id,
                  start: { num: 0, den: 1 },
                  source: {
                    start: { num: layer.trim, den: 1 },
                    end: { num: sourceEnd, den: 1 },
                    timebase: { num: 30, den: 1 },
                  },
                  rate: layer.rate,
                  transition: { kind: "cut" },
                  captions: [],
                  payload: { transform: { scale: layer.scale, x: layer.x, y: layer.y } },
                },
              ],
            },
          },
          prior.revision,
        );
        assert.equal(
          imported.asset.media.hasAudio,
          true,
          "Each visible original has audible sentinel requiring muting",
        );
        sourceMetadata.push({ layer, asset: imported.asset, sourceEnd, bytes: statSync(original).size });
      }
      const fonts = prepareLongformFonts(f.root, projectId);
      const planOptions = { rootDir: f.root, codeDir: process.cwd(), fontContext: fonts.context };
      const plan = projectChapterPlan(projectId, workflow.metadata.chapterManifest, planOptions);
      const serveUrl = await bundle({
        entryPoint: path.resolve("src/index.ts"),
        publicDir: path.join(f.root, "public"),
        outDir: path.join(f.root, "bundle"),
        webpackOverride: (config) => {
          const c = enableTailwind(config);
          return {
            ...c,
            resolve: { ...c.resolve, alias: { ...c.resolve?.alias, [path.resolve("src/lib/fonts")]: fonts.alias } },
          };
        },
      });
      const render = remotionChapterBackend(f.root, {
        codeDir: process.cwd(),
        serveUrl,
        concurrency: 2,
        timeoutMs: 600000,
        stallTimeoutMs: 120000,
      });
      const initialStarted = Date.now(),
        rendered = await renderChapters(plan, { dryRun: false, render }),
        initialRenderMs = Date.now() - initialStarted;
      assert.equal(rendered.outputs.length, 3);
      const assemblyStarted = Date.now(),
        assembled = assembleChapters(plan, rendered, { rootDir: f.root }),
        assemblyMs = Date.now() - assemblyStarted;
      const master = assembled.outputs[0];
      copyFileSync(master, path.join(artifact, "dense.mp4"));
      cpSync(path.join(f.root, "public/projects", projectId), path.join(artifact, "initial-project"), {
        recursive: true,
      });
      const probe = mediaProbe(master),
        video = probe.streams.find((s) => s.codec_type === "video")!;
      assert.equal(video.width, 1920);
      assert.equal(video.height, 1080);
      assert.equal(video.avg_frame_rate, "30/1");
      assert.equal(Number(video.nb_frames), durationSec * 30);
      const decoded = ff(["-i", master, "-progress", "pipe:1", "-f", "null", "-"]) as string;
      assert.equal(
        Number([...decoded.matchAll(/^frame=(\d+)$/gm)].at(-1)![1]),
        durationSec * 30,
        "All actual master video frames decoded",
      );
      const boundarySeconds = Array.from({ length: 3 }, (_, ch) => [
        (ch * durationSec) / 3 + 0.25,
        ((ch + 1) * durationSec) / 3 - 0.25,
      ]).flat();
      const pcm = await decodeAudioWindows(
        master,
        boundarySeconds.map((sec) => ({ startSample: Math.round(sec * 48000), samples: 4800 })),
      );
      assert.equal(pcm.totalSamples, durationSec * 48000);
      const audio = analyzeAudio(master);
      assert.equal(audio.silence.length, 0);
      assert.ok(audio.integratedLufs! > -60);
      const amplitude = (window: Buffer, frequency: number) => {
        let real = 0,
          imaginary = 0;
        for (let i = 0; i < 4800; i++) {
          const sample = window.readFloatLE(i * 4),
            angle = (2 * Math.PI * frequency * i) / 48000;
          real += sample * Math.cos(angle);
          imaginary += sample * Math.sin(angle);
        }
        return Math.hypot(real, imaginary) / 4800;
      };
      const audioEvidence = boundarySeconds.map((sec, i) => {
        const data = pcm.windows[i].data,
          ch = Math.floor(sec / (durationSec / 3)),
          strength = amplitude(data, 330 + ch * 60),
          music = amplitude(data, 110);
        assert.ok(strength > 0.01 && music > 0.002, `Continuous independent audio missing at ${sec}`);
        for (let other = 0; other < 3; other++)
          if (other !== ch)
            assert.ok(amplitude(data, 330 + other * 60) < strength / 8, "Adjacent chapter voice cannot leak");
        const sentinels = DENSE_LAYERS.flatMap((l) => [l.sentinel, (l.sentinel * l.rate.num) / l.rate.den]).map(
          (frequency) => ({ frequency, amplitude: amplitude(data, frequency) }),
        );
        assert.ok(
          sentinels.every((s) => s.amplitude < 0.0005),
          "Embedded video source audio must be muted, never doubled",
        );
        return { seconds: sec, chapter: ch, voice: strength, music, sentinels };
      });
      const pixels: DensePixel[] = [];
      for (const frame of denseProbeFrames(durationSec * 30, chapterFrames)) {
        ff(["-ss", String(frame / 30), "-i", master, "-frames:v", "1", path.join(artifact, `decoded-${frame}.png`)]);
        for (const layer of DENSE_LAYERS) {
          const rgb = [
            ...(ff(
              [
                "-ss",
                String(frame / 30),
                "-i",
                master,
                "-vf",
                `format=rgb24,crop=1:1:${960 + layer.x}:${540 + layer.y}`,
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
              ],
              true,
            ) as Buffer),
          ];
          const sourceFrame = layer.trim + (frame * layer.rate.num) / layer.rate.den;
          const pixel = { frame, layer: layer.id, rgb, sourceFrame, dark: Math.floor(sourceFrame / 60) % 2 === 0 };
          assertDensePixel(pixel);
          pixels.push(pixel);
        }
      }
      const qa: Array<FullHDFrameEvidence & { chapterId: string }> = [];
      for (const job of plan.jobs) {
        const props = { ...job.props, qaEvidence: true },
          composition = await selectComposition({ serveUrl, id: job.compositionId, inputProps: props });
        for (const frame of [15, beatFrames * 3 + 15, chapterFrames - 1]) {
          let evidence: FullHDFrameEvidence | undefined;
          await renderStill({
            serveUrl,
            composition,
            inputProps: props,
            frame,
            output: path.join(artifact, `${job.chapterId}-${frame}.png`),
            logLevel: "error",
            onBrowserLog: (log) => {
              if (!log.text.startsWith("QA_EVIDENCE:")) return;
              const candidate = JSON.parse(log.text.slice(12)) as FullHDFrameEvidence;
              if (candidate.frame === frame) evidence = candidate;
            },
          });
          assert.ok(evidence, "Final-frame actual DOM caption/font probe required");
          assertFullHDFrameEvidence(evidence);
          const beat = f.request.chapters.find((ch) => ch.id === job.chapterId)!.beats[Math.floor(frame / beatFrames)];
          const localFrame = frame % beatFrames;
          const active = beat.captions.find((word) => word.startFrame <= localFrame && word.endFrame > localFrame);
          assert.ok(active, "Authored timed word must exist at sampled frame");
          assert.ok(
            evidence.measurements.some((m) => m.role === "spoken-caption" && m.text === active.text),
            `Chapter ${job.chapterId} frame ${frame} must display its authored timed word ${active.text}`,
          );
          qa.push({ ...evidence, chapterId: job.chapterId });
        }
      }
      copyFileSync(master, path.join(artifact, "dense.mp4"));
      copyFileSync(assembled.outputs[1], path.join(artifact, "assembly.json"));
      cpSync(path.join(f.root, "public/projects", projectId), path.join(artifact, "initial-project"), {
        recursive: true,
      });
      cpSync(path.join(f.root, "out"), path.join(artifact, "initial-render-cache"), { recursive: true });
      const reused = projectChapterPlan(projectId, workflow.metadata.chapterManifest, planOptions);
      assert.ok(reused.jobs.every((j) => j.action === "reuse"));
      await renderChapters(reused, {
        dryRun: false,
        render: async () => {
          throw new Error("Full chapter cache hit must not render");
        },
      });
      assert.equal(assembleChapters(plan, rendered, { rootDir: f.root }).metadata.reused, true);
      // One chapter-owned visual payload changes; continuous video sources stay unchanged.
      const doc = store.read();
      doc.timeline.tracks[0].clips[7].payload!.lessonEvidenceHash = "dense chapter-only revision";
      writeFileSync(journal, JSON.stringify(doc));
      const changed = projectChapterPlan(projectId, workflow.metadata.chapterManifest, planOptions);
      assert.deepEqual(
        changed.jobs.map((j) => j.action),
        ["reuse", "render", "reuse"],
      );
      let rerenders = 0;
      const selectiveStarted = Date.now();
      await renderChapters(changed, {
        dryRun: false,
        render: async (j, o) => {
          rerenders++;
          await render(j, o);
        },
      });
      assert.equal(rerenders, 1);
      const selectiveMs = Date.now() - selectiveStarted;
      cpSync(path.join(f.root, "out"), path.join(artifact, "render-cache"), { recursive: true });
      cpSync(path.join(f.root, "public/projects", projectId), path.join(artifact, "project"), { recursive: true });
      writeFileSync(
        path.join(artifact, "evidence.json"),
        JSON.stringify(
          {
            label: "Locally generated synthetic technical diagnostic, not speech or creative acceptance",
            loadedRevision,
            dimensions: { width: 1920, height: 1080, scale: 1, fps: 30 },
            probe,
            masterSha256: hashFile(master),
            masterBytes: statSync(master).size,
            sourceMetadata,
            audio,
            audioEvidence,
            pixels,
            qa,
            originalFontManifest: fonts.manifest,
            decodedVideoFrames: durationSec * 30,
            decodedAudioSamples: pcm.totalSamples,
            retainedPcmBytes: pcm.retainedBytes,
            cacheActions: changed.jobs.map((j) => ({ chapterId: j.chapterId, action: j.action })),
            timings: { initialRenderMs, assemblyMs, selectiveMs, totalMs: Date.now() - started },
          },
          null,
          2,
        ),
      );
    } finally {
      try {
        await monitor.stop();
      } finally {
        fixture?.cleanup();
      }
    }
  },
);
