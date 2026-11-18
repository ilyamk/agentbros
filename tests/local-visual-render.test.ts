import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { ensureBrowser, openBrowser, selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { readSourceIndex } from "../src/lib/ingest";
import { hashFile, importAsset, readAssetRegistry } from "../src/lib/assets/registry";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { planBroll, applyBroll } from "../src/lib/ingest/broll";
import { digest } from "../src/lib/jobs/model-artifacts";
import { ProjectVideoSchema } from "../src/lib/project-props";
import { stableHash } from "../src/lib/longform/plans";
test(
  "actual native image retrieval → rendered muted cutaway preserves synthetic speech PCM, captions, clocks and undo",
  { skip: process.env.RUN_LOCAL_VISUAL_RENDER_TESTS !== "1", timeout: 240000 },
  async () => {
    const checkout = process.cwd(),
      receiptFile = process.env.LOCAL_VISUAL_ACCEPTANCE!,
      artifacts = process.env.LOCAL_VISUAL_RENDER_ARTIFACTS!,
      speech = process.env.LOCAL_VISUAL_SPEECH!;
    assert.ok(receiptFile && artifacts && speech, "Explicit retained native acceptance/speech/output required");
    mkdirSync(artifacts, { recursive: true });
    const native = JSON.parse(readFileSync(receiptFile, "utf8"));
    assert.equal(native.workerSourceHash, "b2ed975a9a61d25875ac234c5a87f46fec207eef1451c6669149c4d9832f1376");
    const originalRoot = path.dirname(receiptFile),
      root = mkdtempSync(path.join(artifacts, "render-")),
      project = path.join(root, "public/projects/test");
    cpSync(path.join(originalRoot, "public"), path.join(root, "public"), { recursive: true });
    const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };
    const ff = (args: string[]) =>
      execFileSync("ffmpeg", ["-v", "error", ...args], { timeout: 30000, maxBuffer: 8 * 1024 * 1024, env });
    const save = (name: string, value: unknown) =>
      writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n");
    const report: any = {
      sourceCommit: "e1b13b4a814eecbeab4169db1ae297f2307f5a0b",
      nativeAcceptance: receiptFile,
      nativeAcceptanceHash: hashFile(receiptFile),
      apiCalls: 0,
      providerSpendUsd: 0,
      limits:
        "Retained synthetic speech excerpt and supplied caption layout, not measured word alignment or human creative approval. Copied immutable native receipt; no fresh inference. Quarter-scale render, local font substitution.",
    };
    let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
    process.chdir(root);
    try {
      const indexFile = path.join(project, native.plan.request.indexFile),
        index = readSourceIndex("test", indexFile);
      assert.equal(hashFile(indexFile), native.indexHash);
      assert.equal(index.visualAnalysis!.receipt.hash, native.receiptHash);
      const source = path.join(root, "public", index.source.path);
      assert.equal(hashFile(source), native.sourceHash);
      const excerpt = path.join(root, "speech.wav");
      ff(["-i", speech, "-t", "3", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", excerpt]);
      const spoken = importAsset({
        projectId: "test",
        sourceFile: excerpt,
        provenance: { origin: "manual", tool: "retained synthetic speech excerpt; no provider" },
        rights: {
          licence: "Synthetic test-only declaration",
          checkedAsOf: "2026-10-12T00:00:00Z",
          attributionRequired: false,
          commercialAllowed: false,
        },
      }).asset;
      const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json")),
        old = store.read();
      save("copied-original-timeline.json", old);
      unlinkSync(store.file);
      const timeline = structuredClone(native.before.timeline);
      const audio = timeline.tracks.find((t: any) => t.kind === "voiceover");
      assert.ok(audio);
      audio.clips[0].assetId = spoken.id;
      const words = "This product helps you organize your videos".split(" ");
      timeline.tracks.push({
        id: "supplied-caption-layout",
        kind: "captions",
        clips: [
          {
            id: "supplied-layout",
            assetId: spoken.id,
            start: { num: 0, den: 1 },
            source: { start: { num: 0, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
            captions: words.map((text, i) => ({
              id: `w${i}`,
              text,
              start: { num: i * 12, den: 1 },
              end: { num: i === words.length - 1 ? 90 : (i + 1) * 12, den: 1 },
            })),
          },
        ],
      });
      store.initialize(timeline);
      const before = store.read();
      save("timeline-before.json", before);
      const plan = planBroll({ ...native.plan.request, expectedRevision: before.revision }, { rootDir: root });
      assert.equal(plan.selection.startSec, 0);
      assert.equal(plan.selection.endSec, 1.5);
      assert.deepEqual(plan.command.track.clips[0].source, {
        start: { num: 0, den: 1 },
        end: { num: 45, den: 1 },
        timebase: { num: 30, den: 1 },
      });
      assert.deepEqual(plan.outputEnd, { num: 75, den: 1 });
      const review = {
        planHash: plan.planHash,
        assetHash: plan.assetHash,
        reviewedBy: "synthetic-local-acceptance",
        evidence: "Explicit fixture declaration; no human publication approval",
      };
      save("broll-plan.json", plan);
      applyBroll(plan, review, { rootDir: root, dryRun: true });
      assert.deepEqual(store.read(), before);
      const installed = await ensureBrowser({
        logLevel: "error",
        onBrowserDownload: () => {
          throw new Error("Installed Chromium required; no downloads");
        },
      });
      if (!("path" in installed)) throw new Error("Installed Chromium required");
      browser = await openBrowser("chrome", { browserExecutable: installed.path, logLevel: "error" });
      const serveUrl = await bundle({
        entryPoint: path.join(checkout, "tests/fixtures/visual-frame-render.tsx"),
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
                [path.join(checkout, "src/lib/fonts")]: path.join(checkout, "tests/fixtures/offline-fonts.ts"),
              },
            },
          };
        },
      });
      const render = async (name: string) => {
        const registry = readAssetRegistry("test"),
          props = ProjectVideoSchema.parse({
            projectId: "test",
            format: "landscape",
            productName: "Fixture",
            tagline: "",
            accentColor: "#FFE600",
            bgColor: "#000000",
            textColor: "#FFFFFF",
            scenes: [],
            voiceoverEnabled: true,
            musicVolume: 0,
            timeline: store.read().timeline,
            timelineAssets: Object.fromEntries(
              registry.assets.map((asset) => [
                asset.id,
                {
                  source: asset.files.original,
                  kind: asset.kind,
                  durationSec: asset.media.durationSec,
                  hasAudio: asset.media.hasAudio,
                },
              ]),
            ),
          });
        const composition = await selectComposition({
            serveUrl,
            id: "VisualFrameAcceptance",
            inputProps: props,
            puppeteerInstance: browser,
            logLevel: "error",
          }),
          file = path.join(root, name + ".mp4");
        await renderMedia({
          serveUrl,
          composition,
          inputProps: props,
          puppeteerInstance: browser,
          outputLocation: file,
          codec: "h264",
          scale: 0.25,
          concurrency: 2,
          logLevel: "error",
        });
        for (const frame of [29, 30, 60, 74, 75])
          await renderStill({
            serveUrl,
            composition,
            inputProps: props,
            puppeteerInstance: browser,
            output: path.join(root, `${name}-${frame}.png`),
            frame,
            imageFormat: "png",
            scale: 0.25,
            logLevel: "error",
          });
        return file;
      };
      const baseline = await render("before");
      const after = applyBroll(plan, review, { rootDir: root });
      assert.deepEqual(after.timeline.tracks.slice(0, -1), before.timeline.tracks);
      save("timeline-after.json", after);
      const edited = await render("after");
      const undo = store.undo(after.revision);
      assert.deepEqual(undo.timeline, before.timeline);
      save("timeline-undo.json", undo);
      const undone = await render("undo");
      const pcm = (file: string) =>
        ff(["-i", file, "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1"]);
      const samples = [baseline, edited, undone].map(pcm);
      assert.ok(samples[0]!.length >= 3 * 48000 * 4);
      assert.deepEqual(samples[1], samples[0]);
      assert.deepEqual(samples[2], samples[0]);
      Object.assign(report, {
        pcmBytes: samples[0]!.length,
        pcmSha256: samples.map(digest),
        codec: "H264 delivery movies; unencoded PNG renderStill boundary evidence",
        outputs: [baseline, edited, undone].map((file) => ({ file, hash: hashFile(file) })),
      });
      // Exact frame mapping: B-roll output30..74 maps source0..44; before/after this range remains master.
      const image = (file: string, frame: number, original = false) =>
        ff([
          "-i",
          file,
          "-vf",
          `select=eq(n\\,${frame}),${original ? "scale=720:270,crop=480:270," : ""}crop=480:130:0:0`,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]);
      const mae = (a: Buffer, b: Buffer) => {
        assert.equal(a.length, b.length);
        return a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / a.length;
      };
      const checks: any[] = [];
      report.frameChecks = checks;
      for (const output of [29, 30, 60, 74, 75]) {
        const mapped = output >= 30 && output < 75 ? output - 30 : output,
          target = image(source, mapped, true),
          got = image(path.join(root, `after-${output}.png`), 0),
          base = image(path.join(root, `before-${output}.png`), 0),
          reverted = image(path.join(root, `undo-${output}.png`), 0);
        const match = mae(got, target),
          againstBaseline = mae(got, base);
        checks.push({
          outputFrame: output,
          mappedSourceFrame: mapped,
          sourceMatchMae: match,
          baselineDifferenceMae: againstBaseline,
          undoMae: mae(base, reverted),
        });
        assert.ok(match < 4, JSON.stringify({ output, mapped, match }));
        assert.ok(mae(base, reverted) < 0.01, "Undo reproduces same rendered frame");
        if (output === 60)
          assert.ok(againstBaseline > match + 1, "Cutaway must visibly differ from master and match mapped source");
        if (output === 29 || output === 75)
          assert.ok(againstBaseline < 0.01, "Boundary outside cutaway remains master");
      }
      for (const file of [baseline, edited, undone]) {
        const probe = JSON.parse(
          execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file], {
            encoding: "utf8",
            timeout: 10000,
            env,
          }),
        );
        const v = probe.streams.find((s: any) => s.codec_type === "video");
        assert.equal(v.nb_read_frames, "90");
        assert.equal(v.width, 480);
        assert.equal(v.height, 270);
        assert.equal(v.avg_frame_rate, "30/1");
      }
      Object.assign(report, {
        passed: true,
        root,
        indexHash: hashFile(indexFile),
        receiptHash: index.visualAnalysis!.receipt.hash,
        queryHash: native.queryHash,
        sourceHash: hashFile(source),
        speechOriginalHash: hashFile(speech),
        speechExcerptHash: spoken.hash,
        sourceAudioSentinel: true,
        stillFrames: [29, 30, 60, 74, 75].flatMap((frame) =>
          ["before", "after", "undo"].map((stage) => ({
            stage,
            frame,
            file: path.join(root, `${stage}-${frame}.png`),
            hash: hashFile(path.join(root, `${stage}-${frame}.png`)),
          })),
        ),
        pcmBytes: samples[0]!.length,
        pcmSha256: samples.map(digest),
        frameChecks: checks,
        originalTracksHash: stableHash(before.timeline.tracks),
        afterOriginalTracksHash: stableHash(after.timeline.tracks.slice(0, -1)),
        undoTimelineHash: stableHash(undo.timeline),
        beforeTimelineHash: stableHash(before.timeline),
        outputs: [baseline, edited, undone].map((file) => ({ file, hash: hashFile(file) })),
      });
      save("acceptance.json", report);
    } catch (error) {
      report.passed = false;
      report.error = String(error);
      save("acceptance.json", report);
      throw error;
    } finally {
      try {
        if (browser) await browser.close({ silent: true });
      } finally {
        process.chdir(checkout);
      }
    }
  },
);
