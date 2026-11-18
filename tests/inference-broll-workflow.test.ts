import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { openBrowser, selectComposition, renderMedia } from "@remotion/renderer";
import { importAsset, hashFile } from "../src/lib/assets/registry";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { planBroll, applyBroll } from "../src/lib/ingest/broll";
import { planProjectRender } from "../src/lib/render-plan";
import { SourceIndexSchema } from "../src/types/source-index";
import { LocalWorkerConfigSchema } from "../src/lib/ingest/local-worker";
import { digest } from "../src/lib/jobs/model-artifacts";
import { evaluateLocalAsr, evaluateLocalRetrieval } from "../src/lib/ingest/local-evaluation";

// Independent supplied caption layout timing, not measured/forced ASR word alignment.
const reference = {
  english:
    "This product helps you organize your videos. The demonstration shows a simple editing workflow. Results depend on the material you provide.",
  russian:
    "Этот инструмент помогает создавать видео. Сначала мы выбираем нужные материалы. Результат зависит от качества исходной записи.",
};
// Labels fixed before running retrieval; no threshold or label tuning for success.
const queryLabels = [
  {
    text: "Как показать работу видеоредактора?",
    expected: "english",
  },
  {
    text: "Почему качество исходной записи влияет на результат?",
    expected: "russian",
  },
];
const r = (num: number) => ({
  num,
  den: 1,
});
type Envelope = {
  ok: boolean;
  error?: string;
  message?: string;
  outputs?: string[];
  metadata: any;
};
test(
  "actual offline video ASR and semantic B-roll preserve recorded synthetic speech/captions through render and undo",
  {
    skip: process.env.RUN_INFERENCE_BROLL_WORKFLOW_TESTS !== "1",
    timeout: 600000,
  },
  async () => {
    const checkout = process.cwd();
    const configRoot = process.env.LOCAL_INFERENCE_CONFIG_DIR;
    const fixtureRoot = process.env.LOCAL_INFERENCE_FIXTURE_ROOT;
    const artifactRoot = process.env.INFERENCE_BROLL_ARTIFACTS_DIR;
    assert.ok(configRoot && fixtureRoot && artifactRoot);
    assert.ok([configRoot, fixtureRoot, artifactRoot].every((p) => path.isAbsolute(p)));
    assert.equal(process.platform, "darwin", "This acceptance requires the macOS deny-network sandbox");
    mkdirSync(artifactRoot, {
      recursive: true,
    });
    const root = mkdtempSync(path.join(artifactRoot, "actual-run-"));
    const projectId = "offline-video";
    const project = path.join(root, "public/projects", projectId);
    const env = {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      HF_DATASETS_OFFLINE: "1",
    };
    const policy = "(version 1)(allow default)(deny network*)";
    const loader = path.resolve(checkout, "node_modules/tsx/dist/loader.mjs");
    const cliFile = path.resolve(checkout, "scripts/media-local.ts");
    const report: Record<string, any> = {
      version: 1,
      fixture: "Retained synthetic macOS speech; not genuine speaker/human creative/publication approval",
      inferenceNetwork: "OS deny network; Chrome local bundle runs separately",
      apiCalls: 0,
      providerSpendUsd: 0,
      references: reference,
      queryLabels,
      receipts: [],
    };
    let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
    const save = (name: string, value: unknown) =>
      writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n");
    const ff = (args: string[]) =>
      execFileSync("ffmpeg", ["-v", "error", "-y", ...args], {
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
        env,
      });
    const probe = (file: string) =>
      JSON.parse(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file],
          {
            encoding: "utf8",
            timeout: 30000,
            env,
          },
        ),
      );
    const pcm = (file: string) =>
      execFileSync(
        "ffmpeg",
        ["-v", "error", "-i", file, "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1"],
        {
          maxBuffer: 8 * 1024 * 1024,
          timeout: 30000,
          env,
        },
      );
    const receipt = (args: string[]) => {
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", policy, process.execPath, "--import", loader, cliFile, ...args],
        {
          cwd: root,
          env,
          encoding: "utf8",
          timeout: 300000,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      assert.equal(result.error, undefined);
      const lines = result.stdout.trim().split("\n");
      assert.equal(lines.length, 1, result.stdout);
      const value = JSON.parse(lines[0]!) as Envelope;
      assert.equal(value.ok, true, JSON.stringify(value));
      assert.equal(result.status, 0, result.stderr);
      const file = `receipt-${report.receipts.length}.json`;
      save(file, value);
      writeFileSync(path.join(root, file + ".stderr.txt"), result.stderr);
      report.receipts.push({
        file,
        sha256: hashFile(path.join(root, file)),
        args,
      });
      return value;
    };
    try {
      const asrRaw = JSON.parse(readFileSync(path.join(configRoot, "asr.json"), "utf8"));
      const embedRaw = JSON.parse(readFileSync(path.join(configRoot, "embedding.json"), "utf8"));
      const configs = ["en", "ru"].map((language) =>
        LocalWorkerConfigSchema.parse({
          ...asrRaw,
          language,
          workerFile: path.resolve(checkout, "scripts/workers/local-analysis.py"),
        }),
      );
      const embedding = LocalWorkerConfigSchema.parse({
        ...embedRaw,
        workerFile: path.resolve(checkout, "scripts/workers/local-analysis.py"),
      });
      const probeDenied = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", policy, embedding.executable, "-c", 'import socket; socket.socket().bind(("127.0.0.1",0))'],
        {
          env,
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.notEqual(probeDenied.status, 0);
      assert.match(probeDenied.stderr, /Operation not permitted|Permission denied/);
      report.networkProbe = {
        denied: true,
        stderr: probeDenied.stderr,
      };
      configs.forEach((config, i) => save(`asr-${i}.json`, config));
      save("embedding.json", embedding);
      const englishWav = path.join(fixtureRoot, "english.wav"),
        russianWav = path.join(fixtureRoot, "russian.wav");
      assert.ok(existsSync(englishWav) && existsSync(russianWav));
      const fixtureHashes = {
        english: hashFile(englishWav),
        russian: hashFile(russianWav),
      };
      const englishVideo = path.join(root, "english-master.mp4"),
        russianVideo = path.join(root, "russian-cutaway.mp4");
      ff([
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=320x180:r=30:d=9",
        "-i",
        englishWav,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-af",
        "apad",
        "-t",
        "9",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        englishVideo,
      ]);
      ff([
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:r=30:d=9",
        "-i",
        russianWav,
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:sample_rate=48000:duration=9",
        "-filter_complex",
        "[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=cyan:t=fill:enable=gte(t\\,4.5)[v];[1:a]apad[a];[2:a]volume=0.15[s];[a][s]amix=inputs=2:normalize=0:duration=longest[out]",
        "-map",
        "[v]",
        "-map",
        "[out]",
        "-t",
        "9",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        russianVideo,
      ]);
      const englishHash = hashFile(englishVideo),
        russianHash = hashFile(russianVideo);
      const sourceProbes = [englishVideo, russianVideo].map((file) => probe(file));
      for (const evidence of sourceProbes) {
        const video = evidence.streams.find((s: any) => s.codec_type === "video");
        const audio = evidence.streams.find((s: any) => s.codec_type === "audio");
        assert.equal(video.avg_frame_rate, "30/1");
        assert.equal(Number(video.nb_read_frames), 270);
        assert.equal(Number(video.start_time), 0);
        assert.equal(Number(audio.start_time), 0);
      }
      report.sourceProbes = sourceProbes;
      report.fixtureHashes = fixtureHashes;
      const rights = {
        licence: "Synthetic internal integration fixture only; publication rights not accepted",
        checkedAsOf: "2026-10-11T00:00:00Z",
        commercialAllowed: false,
        attributionRequired: false,
      };
      const words = reference.english.split(/\s+/).map((text, i) => ({
        id: `supplied-${i}`,
        text,
        startFrame: 6 + i * 12,
        endFrame: 6 + i * 12 + 10,
      }));
      const workflow = {
        version: 1,
        workflow: "recording-edit",
        projectId,
        name: "Synthetic real-inference integration",
        profile: "recording-only",
        formats: ["landscape"],
        source: {
          file: englishVideo,
          sha256: englishHash,
          version: "synthetic-video-v1",
          fps: r(30),
          rights,
        },
        transcript: {
          version: "authored-coarse-caption-layout-v1-not-word-alignment",
          language: "en",
          words,
        },
        keepSpans: [
          {
            id: "whole",
            startFrame: 0,
            endFrame: 270,
            reason: "No speech deletion; entire supplied synthetic recording retained",
          },
        ],
        cuts: [],
        protectedSpans: [
          {
            startFrame: 0,
            endFrame: 270,
            kind: "complete-statement",
            reason: "Fixture-only full statement/context preservation",
          },
        ],
        revision: 1,
      };
      const workflowPlan = await runRecordingEditWorkflow(workflow, {
        action: "plan",
        rootDir: root,
      });
      const reviewed = {
        ...workflow,
        review: {
          reviewer: "synthetic-fixture-declaration-only",
          reviewedAt: "2026-10-11T00:00:00Z",
          approvedEditHash: workflowPlan.metadata.editHash,
          meaningPreserved: true,
        },
      };
      save("recording-request.json", reviewed);
      await runRecordingEditWorkflow(reviewed, {
        action: "create",
        rootDir: root,
      });
      importAsset({
        projectId,
        sourceFile: russianVideo,
        rootDir: root,
        provenance: {
          origin: "manual",
          tool: "local-synthetic-video-with-retained-speech-and-sentinel",
        },
        rights,
      });
      const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
      const before = store.read();
      save("timeline-before.json", before);
      assert.equal(before.timeline.tracks.find((t) => t.kind === "captions")!.clips[0]!.captions.length, words.length);
      save("ingest-options.json", {
        proxyWidth: 320,
        thumbnailEverySec: 3,
        protectedSpans: [
          {
            startSec: 0,
            endSec: 8.7,
            reason: "Fixture-only complete synthetic statement protection",
          },
        ],
      });
      const indexes = [englishVideo, russianVideo].map((source, i) => {
        const args = [
          "--action",
          "asr",
          "--config",
          path.join(root, `asr-${i}.json`),
          "--project",
          projectId,
          "--source",
          source,
          "--options",
          path.join(root, "ingest-options.json"),
        ];
        const fresh = receipt(args),
          replay = receipt(args);
        assert.equal(fresh.metadata.workerCacheHit, false);
        assert.equal(replay.metadata.workerCacheHit, true);
        assert.equal(replay.metadata.cacheHit, true);
        const index = SourceIndexSchema.parse(JSON.parse(readFileSync(fresh.metadata.file, "utf8")));
        assert.equal(index.source.kind, "video");
        assert.equal(index.source.originSec, 0);
        assert.equal(index.source.variableFrameRate, false);
        assert.equal(index.source.timestamps.length, 270);
        assert.deepEqual(index.source.fps, r(30));
        assert.ok(index.proxy && index.thumbnails.length === 3);
        assert.equal(index.localAnalysis!.segmentation, "sentence-boundaries-v1");
        assert.equal(index.sourceHash, i === 0 ? englishHash : russianHash);
        report.asr ??= [];
        report.asr.push({
          sample: i === 0 ? "english" : "russian",
          indexFile: fresh.metadata.file,
          cacheKey: index.cacheKey,
          sourceHash: index.sourceHash,
          hypothesis: index.segments.map((s) => ({
            text: s.text,
            startSec: s.startSec,
            endSec: s.endSec,
          })),
          metrics: evaluateLocalAsr(
            [
              {
                text: i === 0 ? reference.english : reference.russian,
                startSec: 0,
                endSec: 9,
              },
            ],
            index.segments.map((s) => ({
              text: s.text,
              startSec: s.startSec,
              endSec: s.endSec,
            })),
          ),
          workerEvidence: fresh.metadata.workerEvidence,
          workerCacheReplay: true,
          sourceIndexReplay: true,
        });
        return index;
      });
      const corpusArgs = ["--action", "corpus", "--project", projectId, "--config", path.join(root, "embedding.json")];
      const corpus = receipt(corpusArgs);
      assert.equal(corpus.metadata.cacheHit, false);
      assert.equal(receipt(corpusArgs).metadata.cacheHit, true);
      const quality = [];
      let chosen: Envelope | undefined;
      for (const label of queryLabels) {
        const args = [
          "--action",
          "query",
          "--project",
          projectId,
          "--config",
          path.join(root, "embedding.json"),
          "--corpus",
          corpus.metadata.file,
          "--query",
          label.text,
          "--limit",
          "100",
          "--context",
          "0",
        ];
        const query = receipt(args),
          replay = receipt(args);
        assert.equal(query.metadata.cacheHit, false);
        assert.equal(replay.metadata.cacheHit, true);
        assert.deepEqual(replay.metadata.query, query.metadata.query);
        const expected = indexes[label.expected === "english" ? 0 : 1]!;
        quality.push({
          expectedSegmentIds: expected.segments.map((s) => `${expected.cacheKey}:${s.id}`),
          rankedSegmentIds: query.metadata.hits.map((hit: any) => `${hit.cacheKey}:${hit.segmentId}`),
        });
        report.queries ??= [];
        report.queries.push({
          ...label,
          ...query.metadata,
        });
        if (label.expected === "russian") chosen = query;
      }
      report.retrievalMetrics = evaluateLocalRetrieval(quality);
      // Render a supplied review of a Russian-source candidate from the real results even if another source ranks first.
      const selected = chosen!.metadata.hits.find((hit: any) => hit.cacheKey === indexes[1]!.cacheKey);
      assert.ok(selected, "Selected labelled Russian source must occur in returned corpus results");
      const queryFile = path.join(project, "pipeline/semantic-query.json");
      writeFileSync(queryFile, JSON.stringify(chosen!.metadata.query) + "\n");
      assert.deepEqual(JSON.parse(readFileSync(queryFile, "utf8")), chosen!.metadata.query);
      const request = {
        version: 1,
        projectId,
        indexFile: path.relative(project, report.asr[1].indexFile),
        retrieval: {
          method: "supplied-embedding",
          packFile: path.relative(project, corpus.metadata.file),
          queryFile: path.relative(project, queryFile),
        },
        segmentId: selected.segmentId,
        contextSec: 0,
        trackId: "semantic-cutaway",
        clipId: "russian-proof",
        outputStart: r(6),
        expectedRevision: before.revision,
      };
      const plan = planBroll(request, {
        rootDir: root,
      });
      save("broll-plan.json", plan);
      const review = {
        planHash: plan.planHash,
        assetHash: plan.assetHash,
        reviewedBy: "synthetic-fixture-only",
        evidence: "Internal synthetic integration assertion, not human creative or publication approval",
      };
      const dry = applyBroll(plan, review, {
        rootDir: root,
        dryRun: true,
      });
      assert.equal(dry.dryRun, true);
      assert.deepEqual(store.read(), before);
      assert.equal(plan.sourceAudio, "muted-visual-track");
      assert.equal(plan.productionApproved, false);
      report.broll = {
        request,
        planHash: plan.planHash,
        source: plan.command.track.clips[0]!.source,
        outputEnd: plan.outputEnd,
        selection: plan.selection,
        rank: chosen!.metadata.hits.indexOf(selected) + 1,
        dryRunUnchanged: true,
        review,
      };
      browser = await openBrowser("chrome");
      const serveUrl = await bundle({
        entryPoint: path.resolve(checkout, "src/index.ts"),
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
                [path.resolve(checkout, "src/lib/fonts")]: path.resolve(checkout, "tests/fixtures/offline-fonts.ts"),
              },
            },
          };
        },
      });
      const render = async (name: string) => {
        const job = planProjectRender(projectId, "landscape", root, {
          timeline: true,
        }).jobs[0]!;
        assert.equal(job.durationInFrames, 270);
        const composition = await selectComposition({
          serveUrl,
          id: job.compositionId,
          inputProps: job.props,
          puppeteerInstance: browser,
          logLevel: "error",
        });
        const file = path.join(root, name + ".mp4");
        await renderMedia({
          serveUrl,
          composition,
          inputProps: job.props,
          puppeteerInstance: browser,
          outputLocation: file,
          codec: "h264",
          scale: 0.25,
          concurrency: 2,
          logLevel: "error",
        });
        return file;
      };
      const baseline = await render("before");
      const applied = applyBroll(plan, review, {
        rootDir: root,
      });
      assert.deepEqual(applied.timeline.tracks.slice(0, -1), before.timeline.tracks);
      save("timeline-after.json", store.read());
      const edited = await render("after");
      const originalPcm = pcm(baseline),
        editedPcm = pcm(edited);
      assert.ok(originalPcm.length >= 9 * 48000 * 4);
      assert.equal(digest(editedPcm), digest(originalPcm));
      const average = (file: string, frame: number) => {
        const bytes = execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            file,
            "-vf",
            `select=eq(n\\,${frame}),crop=16:16:20:20`,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          {
            env,
            timeout: 30000,
          },
        );
        assert.equal(bytes.length, 16 * 16 * 3);
        return [0, 1, 2].map(
          (channel) =>
            Array.from(
              {
                length: 256,
              },
              (_, i) => bytes[i * 3 + channel]!,
            ).reduce((a, b) => a + b, 0) / 256,
        );
      };
      const sourceClip = plan.command.track.clips[0]!;
      const firstFrame = 6,
        lastFrame = Math.ceil(Number(plan.outputEnd.num) / plan.outputEnd.den);
      const boundary = firstFrame + 135 - sourceClip.source.start.num / sourceClip.source.start.den;
      const frameEvidence = [0, 30, boundary - 1, boundary, lastFrame].map((frame) => {
        const active = frame >= firstFrame && frame < lastFrame;
        const sourceFrame = active
          ? Math.floor(frame - firstFrame + sourceClip.source.start.num / sourceClip.source.start.den)
          : frame;
        const expected = average(active ? russianVideo : englishVideo, sourceFrame);
        const actual = average(edited, frame);
        // Browser decode / encoder color-space conversion changes exact RGB values.
        // Verify the distinct source color category at the precise mapped frame.
        const classify = (rgb: number[]) =>
          rgb[0]! > 200 && rgb[1]! < 50 && rgb[2]! < 50
            ? "red"
            : rgb[0]! < 50 && rgb[1]! < 50 && rgb[2]! > 200
              ? "blue"
              : rgb[0]! < 50 && rgb[1]! > 200 && rgb[2]! > 200
                ? "cyan"
                : "unexpected";
        assert.notEqual(classify(expected), "unexpected");
        assert.equal(
          classify(actual),
          classify(expected),
          JSON.stringify({
            frame,
            sourceFrame,
            expected,
            actual,
          }),
        );
        return {
          frame,
          sourceFrame,
          active,
          expected,
          actual,
        };
      });
      assert.ok(frameEvidence.some((row) => row.active && row.actual[1]! < 30 && row.actual[2]! > 200));
      assert.ok(frameEvidence.some((row) => row.active && row.actual[1]! > 200 && row.actual[2]! > 200));
      const captionPixels = (file: string) => {
        const bytes = execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            file,
            "-vf",
            "select=eq(n\\,30),crop=480:135:0:135",
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          {
            env,
            timeout: 30000,
          },
        );
        let yellow = 0;
        for (let i = 0; i < bytes.length; i += 3)
          if (bytes[i]! > 150 && bytes[i + 1]! > 150 && bytes[i + 2]! < 120) yellow++;
        assert.ok(yellow > 5, "Supplied timed caption glyphs visible");
        return yellow;
      };
      const yellowBefore = captionPixels(baseline),
        yellowAfter = captionPixels(edited);
      const undo = store.undo(applied.revision);
      assert.deepEqual(undo.timeline, before.timeline);
      assert.equal(hashFile(englishVideo), englishHash);
      assert.equal(hashFile(russianVideo), russianHash);
      assert.equal(hashFile(englishWav), fixtureHashes.english);
      assert.equal(hashFile(russianWav), fixtureHashes.russian);
      const sourceTone = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          russianVideo,
          "-t",
          "0.3",
          "-af",
          "bandpass=f=880:w=30",
          "-ar",
          "48000",
          "-ac",
          "1",
          "-f",
          "f32le",
          "pipe:1",
        ],
        {
          env,
          timeout: 30000,
        },
      );
      const floats = new Float32Array(sourceTone.buffer, sourceTone.byteOffset, sourceTone.length / 4);
      const sentinelRms = Math.sqrt(Array.from(floats).reduce((sum, v) => sum + v * v, 0) / floats.length);
      assert.ok(
        sentinelRms > 0.001,
        "Source cutaway contains audible sentinel; source audio cannot silently be absent",
      );
      const renderedProbe = probe(edited);
      const renderedVideo = renderedProbe.streams.find((s: any) => s.codec_type === "video");
      assert.equal(renderedVideo.width, 480);
      assert.equal(renderedVideo.height, 270);
      assert.equal(Number(renderedVideo.nb_read_frames), 270);
      assert.equal(renderedVideo.avg_frame_rate, "30/1");
      report.render = {
        before: baseline,
        after: edited,
        sourceDimensions: [320, 180],
        scale: 0.25,
        width: renderedProbe.streams.find((s: any) => s.codec_type === "video").width,
        height: renderedProbe.streams.find((s: any) => s.codec_type === "video").height,
        frames: 270,
        decodedPcmSha256: digest(editedPcm),
        decodedPcmBytes: editedPcm.length,
        originalSpeechBitIdenticalBetweenRenders: true,
        captionsMetadataUnchanged: true,
        captionYellowPixels: {
          before: yellowBefore,
          after: yellowAfter,
        },
        frameEvidence,
        cutawaySentinelHz: 880,
        cutawaySentinelRms: sentinelRms,
        cutawayAudioMuted: true,
        undoRestoresOriginalTimeline: true,
        originalSourceHashesUnchanged: true,
        fontMode: "offline fixture, not production font QA",
        captionTiming: "independently authored coarse supplied intervals, not ASR word accuracy",
      };
      report.acceptance =
        "Actual local video inference, reviewed synthetic integration and rendering; no genuine-speaker, quality threshold or human creative/publication approval";
    } finally {
      if (browser)
        await browser.close({
          silent: true,
        });
      save("report.json", report);
      writeFileSync(
        path.join(artifactRoot, "latest-run.json"),
        JSON.stringify({
          root,
          report: path.join(root, "report.json"),
        }) + "\n",
      );
    }
  },
);
