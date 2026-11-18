import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { ensureBrowser, openBrowser, selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { splitProject, r } from "./helpers/review-visual-split";
import { ReviewService } from "../src/lib/review-ui/service";
import { planProjectRender } from "../src/lib/render-plan";
test(
  "actual plain video split preserves rendered source phase and protected PCM; independent right move and Undo",
  { skip: process.env.RUN_VISUAL_SPLIT_RENDER_TESTS !== "1", timeout: 180000 },
  async () => {
    const artifacts = process.env.VISUAL_SPLIT_ARTIFACTS;
    assert.ok(artifacts, "Explicit retained artifact directory required");
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(path.join(artifacts, "render-")),
      f = splitProject(root, true),
      service = new ReviewService("demo", root),
      original = f.store.read(),
      frames = [14, 15, 30, 31, 33, 43, 44, 45, 59, 60, 62, 72, 73, 74, 75];
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex"),
      ff = (args: string[]) =>
        execFileSync("ffmpeg", ["-v", "error", "-threads", "1", ...args], {
          timeout: 15000,
          maxBuffer: 16 * 1024 * 1024,
        }),
      video = path.join(f.project, "original.mp4"),
      originals = [
        video,
        path.join(f.project, "blue.png"),
        path.join(f.project, "red.jpg"),
        ...["voiceover", "music", "sfx"].map((name) => path.join(f.project, name + ".wav")),
      ].map((file) => ({ file, hash: sha(readFileSync(file)) }));
    const evidenceFiles = ["project.json", "pipeline/asset-registry.json"].map((name) => ({
        file: path.join(f.project, name),
        sha256: sha(readFileSync(path.join(f.project, name))),
      })),
      protectedCaptions = () =>
        sha(
          Buffer.from(
            JSON.stringify(
              f.store.read().timeline.tracks.map((track) => ({
                id: track.id,
                clips: track.clips
                  .filter((clip) => clip.captions.length > 0)
                  .map((clip) => ({ id: clip.id, captions: clip.captions })),
              })),
            ),
          ),
        ),
      captionShaBefore = protectedCaptions();
    let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
    const report: Record<string, unknown> = {
      runtimeSource: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      limits:
        "Clean-caption diagnostic (caption data protected); nonzero source7/rate3/2/split31; Synthetic3s480x270diagnostic; no human creative or arbitrary unaligned source phase acceptance",
      apiCalls: 0,
      originals,
      evidenceFiles,
      captionShaBefore,
    };
    try {
      const installed = await ensureBrowser({
        logLevel: "error",
        onBrowserDownload: () => {
          throw Error("Installed Chrome required; no downloads");
        },
      });
      if (!("path" in installed)) throw Error("Installed browser required");
      browser = await openBrowser("chrome", { browserExecutable: installed.path, logLevel: "error" });
      const checkout = process.cwd(),
        serveUrl = await bundle({
          entryPoint: path.resolve("src/index.ts"),
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
        const job = planProjectRender("demo", "landscape", root, { timeline: true, captions: "off" }).jobs[0];
        assert.equal(job.durationInFrames, 90);
        const selected = await selectComposition({
            serveUrl,
            id: job.compositionId,
            inputProps: job.props,
            puppeteerInstance: browser,
            logLevel: "error",
          }),
          composition = { ...selected, width: 480, height: 270 },
          file = path.join(root, name + ".mp4");
        await renderMedia({
          serveUrl,
          composition,
          inputProps: job.props,
          puppeteerInstance: browser,
          codec: "h264",
          outputLocation: file,
          concurrency: 2,
          logLevel: "error",
        });
        for (const frame of frames)
          await renderStill({
            serveUrl,
            composition,
            inputProps: job.props,
            puppeteerInstance: browser,
            output: path.join(root, `${name}-${frame}.png`),
            frame,
            imageFormat: "png",
            logLevel: "error",
          });
        return file;
      };
      const baseline = await render("baseline"),
        proposal = service.visualSplitProposal({
          expectedRevision: 0,
          trackId: "cutaways",
          clipId: "cutaway",
          at: r(31),
          newClipId: "right",
        });
      assert.deepEqual(f.store.read(), original);
      const png = service.visualSplitProposal({
          expectedRevision: 0,
          trackId: "visual",
          clipId: "hook",
          at: r(45),
          newClipId: "png-right",
        }),
        jpeg = service.visualSplitProposal({
          expectedRevision: 0,
          trackId: "jpeg",
          clipId: "jpeg",
          at: r(60),
          newClipId: "jpeg-right",
        });
      f.store.apply({ type: "batch", commands: [proposal.command, png.command, jpeg.command] }, 0);
      assert.equal(f.store.read().undo.length, 1);
      assert.deepEqual(
        f.store.read().timeline.tracks.filter((t) => t.kind !== "visual"),
        original.timeline.tracks.filter((t) => t.kind !== "visual"),
      );
      const split = await render("split");
      f.store.apply({ type: "move", trackId: "cutaways", clipId: "right", start: r(60) }, 1);
      const moved = await render("moved");
      f.store.undo(2);
      f.store.undo(3);
      assert.deepEqual(f.store.read().timeline, original.timeline);
      const undo = await render("undo");
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
        const base = pixels(path.join(root, `baseline-${frame}.png`)),
          divided = pixels(path.join(root, `split-${frame}.png`)),
          restored = pixels(path.join(root, `undo-${frame}.png`)),
          got = pixels(path.join(root, `moved-${frame}.png`));
        assert.deepEqual(divided, base, "Split must not restart or shift source frames");
        assert.deepEqual(restored, base);
        let sourceFrame: number | undefined, mae: number | undefined;
        const adjacent: number[] = [];
        if (frame >= 60 && frame < 74) {
          const mapped = 31 + (frame - 60) * 1.5;
          assert.deepEqual(got, pixels(path.join(root, `baseline-${frame - 29}.png`)));
          if (Number.isInteger(mapped)) {
            sourceFrame = mapped;
            const target = pixels(video, sourceFrame);
            mae = got.reduce((sum, value, i) => sum + Math.abs(value - target[i]!), 0) / got.length;
            assert.ok(mae < 5);
            for (const n of [sourceFrame - 1, sourceFrame + 1]) {
              const other = pixels(video, n),
                difference = got.reduce((sum, value, i) => sum + Math.abs(value - other[i]!), 0) / got.length;
              adjacent.push(difference);
              assert.ok(difference > mae + 5);
            }
          }
        } else if (frame >= 31 && frame < 45) assert.deepEqual(got, pixels(path.join(root, "baseline-14.png")));
        else assert.deepEqual(got, base);
        return {
          frame,
          sourceFrame,
          mae,
          adjacent,
          baseline: sha(base),
          split: sha(divided),
          moved: sha(got),
          undo: sha(restored),
        };
      });
      const movies = [baseline, split, moved, undo],
        pcm = movies.map((file) =>
          ff(["-i", file, "-map", "0:a:0", "-ar", "48000", "-ac", "2", "-f", "s16le", "pipe:1"]),
        );
      for (const b of pcm.slice(1)) assert.deepEqual(b, pcm[0]);
      assert.ok(pcm[0].length >= 576000);
      const probes = movies.map((file) => {
        const probe = JSON.parse(
          execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-of", "json", file], {
            encoding: "utf8",
            timeout: 10000,
          }),
        );
        const v = probe.streams.find((s: any) => s.codec_type === "video");
        assert.equal(v.nb_read_frames, "90");
        assert.equal(v.avg_frame_rate, "30/1");
        assert.equal(v.width, 480);
        assert.equal(v.height, 270);
        return { file, video: v, hash: sha(readFileSync(file)) };
      });
      for (const source of originals) assert.equal(sha(readFileSync(source.file)), source.hash);
      const evidenceAfter = evidenceFiles.map((entry) => ({ file: entry.file, sha256: sha(readFileSync(entry.file)) }));
      assert.deepEqual(evidenceAfter, evidenceFiles);
      const captionShaAfter = protectedCaptions();
      assert.equal(captionShaAfter, captionShaBefore);
      Object.assign(report, {
        passed: true,
        evidenceAfter,
        captionShaAfter,
        commands: [proposal.command, png.command, jpeg.command],
        checks,
        movies: probes,
        decodedPcmBytes: pcm.map((b) => b.length),
        pcmSha256: pcm.map(sha),
        speechTrackSha: sha(Buffer.from(JSON.stringify(original.timeline.tracks.find((t) => t.kind === "voiceover")))),
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
