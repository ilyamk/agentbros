import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { ensureBrowser, openBrowser, selectComposition, renderMedia, renderStill } from "@remotion/renderer";
import { splitProject } from "./helpers/review-visual-split";
import { ReviewService } from "../src/lib/review-ui/service";
import { planProjectRender } from "../src/lib/render-plan";
test(
  "actual visual remove leaves rendered gap and exact protected PCM/Undo",
  { skip: process.env.RUN_VISUAL_REMOVE_RENDER_TESTS !== "1", timeout: 180000 },
  async () => {
    const artifacts = process.env.VISUAL_REMOVE_ARTIFACTS;
    assert.ok(artifacts, "Explicit retained artifact directory required");
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(path.join(artifacts, "render-")),
      f = splitProject(root, true),
      service = new ReviewService("demo", root),
      original = f.store.read(),
      frames = [14, 15, 25, 33, 43, 44, 45, 74, 75];
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
        "Clean-caption diagnostic (caption data protected); nonzero source7/rate3/2/remove cutaway [15,45); Synthetic3s480x270diagnostic; no human creative or arbitrary unaligned source phase acceptance",
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
        for (const frame of [...new Set([...frames, 25, 35, 43])])
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
        proposal = service.visualRemoveProposal({ expectedRevision: 0, trackId: "cutaways", clipId: "cutaway" });
      assert.deepEqual(f.store.read(), original);
      f.store.apply(proposal.command, 0);
      assert.equal(f.store.read().undo.length, 1);
      assert.deepEqual(
        f.store.read().timeline.tracks.filter((t) => t.kind !== "visual"),
        original.timeline.tracks.filter((t) => t.kind !== "visual"),
      );
      const removed = await render("removed");
      f.store.undo(1);
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
      const gap = pixels(path.join(root, "baseline-14.png"));
      const checks = frames.map((frame) => {
        const base = pixels(path.join(root, `baseline-${frame}.png`)),
          got = pixels(path.join(root, `removed-${frame}.png`)),
          restored = pixels(path.join(root, `undo-${frame}.png`));
        assert.deepEqual(restored, base);
        let sourceFrame: number | undefined, mae: number | undefined;
        const adjacent: number[] = [];
        if (frame >= 15 && frame < 45) {
          assert.deepEqual(
            got,
            gap,
            "Removed Sequence must expose the stable underlying visual, not phantom held content",
          );
          assert.notDeepEqual(got, base);
          const mapped = 7 + (frame - 15) * 1.5;
          if (Number.isInteger(mapped)) {
            sourceFrame = mapped;
            const target = pixels(video, sourceFrame);
            mae = base.reduce((sum, value, i) => sum + Math.abs(value - target[i]!), 0) / base.length;
            assert.ok(mae < 5);
            for (const n of [sourceFrame - 1, sourceFrame + 1]) {
              const other = pixels(video, n),
                difference = base.reduce((sum, value, i) => sum + Math.abs(value - other[i]!), 0) / base.length;
              adjacent.push(difference);
              assert.ok(difference > mae + 5);
            }
          }
        } else assert.deepEqual(got, base);
        return { frame, sourceFrame, mae, adjacent, baseline: sha(base), removed: sha(got), undo: sha(restored) };
      });
      const movies = [baseline, removed, undo],
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
        commands: [proposal.command],
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
