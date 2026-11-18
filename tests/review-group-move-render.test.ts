import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { ensureBrowser, openBrowser, selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { buildVisualGroupMove } from "../src/lib/review-ui/group-move";
import { ProjectVideoSchema } from "../src/lib/project-props";
import { rational as r } from "./helpers/review-group-move";

test(
  "actual visual atomic group move renders source boundaries, immutable originals, protected PCM and exact Undo pixels",
  { skip: process.env.RUN_GROUP_MOVE_RENDER_TESTS !== "1", timeout: 180000 },
  async () => {
    const checkout = process.cwd(),
      artifacts = process.env.GROUP_MOVE_ARTIFACTS;
    assert.ok(artifacts, "Explicit artifact directory required");
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(path.join(artifacts, "render-")),
      pub = path.join(root, "public"),
      project = path.join(pub, "projects/demo");
    mkdirSync(path.join(project, "pipeline"), { recursive: true });
    const ff = (args: string[]) =>
      execFileSync("ffmpeg", ["-v", "error", ...args], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex"),
      digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const video = path.join(pub, "original.mp4"),
      voice = path.join(pub, "voice.wav"),
      image = path.join(pub, "background.png");
    ff([
      "-f",
      "lavfi",
      "-i",
      "color=size=480x270:rate=30:duration=3",
      "-vf",
      "geq=r=mod(N*17\\,240):g=mod(N*29\\,240):b=mod(N*43\\,240),scale=out_color_matrix=bt709",
      "-an",
      "-c:v",
      "libx264",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-colorspace",
      "bt709",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-color_range",
      "tv",
      video,
    ]);
    ff([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=3",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      voice,
    ]);
    ff(["-f", "lavfi", "-i", "color=c=blue:size=480x270", "-frames:v", "1", "-threads", "1", image]);
    const originals = [video, voice, image].map((file) => ({ file, hash: hash(file) }));
    const clip = (id: string, assetId: string, start: number, sourceStart: number, span: number) => ({
      id,
      assetId,
      start: r(start),
      source: { start: r(sourceStart), end: r(sourceStart + span), timebase: r(30) },
      rate: r(1),
      transition: { kind: "cut" as const },
      captions: [],
      payload: {
        originalHash: originals.find((row) =>
          row.file.endsWith(
            assetId === "video" ? "original.mp4" : assetId === "voice" ? "voice.wav" : "background.png",
          ),
        )!.hash,
      },
    });
    const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
    store.initialize({
      version: 1,
      projectId: "demo",
      timebase: r(30),
      tracks: [
        { id: "master", kind: "visual", clips: [clip("background", "image", 0, 0, 90)] },
        { id: "cutaways", kind: "visual", clips: [clip("a", "video", 15, 7, 15), clip("b", "video", 30, 22, 15)] },
        { id: "speech", kind: "voiceover", clips: [clip("speech", "voice", 0, 0, 90)] },
      ],
    });
    const before = store.read(),
      command = buildVisualGroupMove(before.timeline, {
        expectedRevision: before.revision,
        members: [
          { trackId: "cutaways", clipId: "a" },
          { trackId: "cutaways", clipId: "b" },
        ],
        delta: r(30),
      });
    const report: any = {
      runtimeSource: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(),
      limits: "Synthetic frame-coded RGB/tone diagnostic; quarter-scale 480x270, not human creative acceptance.",
      apiCalls: 0,
      providerSpendUsd: 0,
      originals,
      command,
    };
    let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
    try {
      const installed = await ensureBrowser({
        logLevel: "error",
        onBrowserDownload: () => {
          throw Error("Installed Chrome required; no downloads");
        },
      });
      if (!("path" in installed)) throw Error("Installed Chrome unavailable");
      browser = await openBrowser("chrome", { browserExecutable: installed.path, logLevel: "error" });
      const serveUrl = await bundle({
        entryPoint: path.join(checkout, "tests/fixtures/visual-frame-render.tsx"),
        publicDir: pub,
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
      const frames = [14, 15, 29, 30, 44, 45, 59, 60, 74, 75];
      const render = async (name: string) => {
        const props = ProjectVideoSchema.parse({
          projectId: "demo",
          format: "landscape",
          productName: "Diagnostic",
          tagline: "",
          accentColor: "#FFE600",
          bgColor: "#000000",
          textColor: "#FFFFFF",
          scenes: [],
          voiceoverEnabled: true,
          musicVolume: 0,
          timeline: store.read().timeline,
          timelineAssets: {
            video: { source: "original.mp4", kind: "video", durationSec: 3, hasAudio: false },
            voice: { source: "voice.wav", kind: "audio", durationSec: 3, hasAudio: true },
            image: { source: "background.png", kind: "image" },
          },
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
        for (const frame of frames)
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
      const baseline = await render("before"),
        after = store.apply(command, before.revision);
      assert.equal(after.undo.length, 1);
      assert.deepEqual(after.timeline.tracks[2], before.timeline.tracks[2]);
      const edited = await render("after"),
        undo = store.undo(after.revision);
      assert.deepEqual(undo.timeline, before.timeline);
      const undone = await render("undo");
      const pcm = [baseline, edited, undone].map((file) =>
        ff(["-i", file, "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1"]),
      );
      assert.deepEqual(pcm[1], pcm[0]);
      assert.deepEqual(pcm[2], pcm[0]);
      assert.ok(pcm[0]!.length >= 576000);
      const pixels = (file: string, frame = 0) =>
        ff([
          "-i",
          file,
          "-vf",
          `select=eq(n\\,${frame})`,
          "-frames:v",
          "1",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ]);
      const checks = frames.map((frame) => {
        const base = pixels(path.join(root, `before-${frame}.png`)),
          restored = pixels(path.join(root, `undo-${frame}.png`)),
          got = pixels(path.join(root, `after-${frame}.png`));
        assert.deepEqual(restored, base);
        const inside = frame >= 45 && frame < 75,
          mapped = inside ? frame - 45 + 7 : undefined;
        let mae: number | undefined;
        const adjacent: number[] = [];
        if (mapped !== undefined) {
          assert.deepEqual(
            got,
            pixels(path.join(root, `before-${frame - 30}.png`)),
            "Identical source span at moved output frame",
          );
          const target = pixels(video, mapped);
          assert.equal(got.length, target.length);
          mae = got.reduce((sum, value, i) => sum + Math.abs(value - target[i]!), 0) / got.length;
          assert.ok(mae < 5, JSON.stringify({ frame, mapped, mae }));
          for (const neighbor of [mapped - 1, mapped + 1]) {
            const other = pixels(video, neighbor),
              difference = got.reduce((sum, value, i) => sum + Math.abs(value - other[i]!), 0) / got.length;
            adjacent.push(difference);
            assert.ok(difference > mae + 5, "Mapped source frame distinguishable from adjacent physical frame");
          }
        } else if (frame < 15 || frame >= 75) assert.deepEqual(got, base);
        return {
          frame,
          mappedSourceFrame: mapped,
          sourceMatchMae: mae,
          adjacentSourceMae: adjacent,
          before: digest(base),
          after: digest(got),
          undo: digest(restored),
        };
      });
      for (const original of originals) assert.equal(hash(original.file), original.hash);
      for (const file of [baseline, edited, undone]) {
        const probe = JSON.parse(
          execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file], {
            encoding: "utf8",
            timeout: 10000,
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
        before,
        after,
        undo,
        checks,
        pcmBytes: pcm[0]!.length,
        pcmSha256: pcm.map(digest),
        movies: [baseline, edited, undone].map((file) => ({ file, hash: hash(file) })),
      });
    } catch (error) {
      report.passed = false;
      report.error = String(error);
      throw error;
    } finally {
      try {
        if (browser) await browser.close({ silent: true });
      } finally {
        writeFileSync(path.join(root, "acceptance.json"), JSON.stringify(report, null, 2) + "\n");
      }
    }
  },
);
