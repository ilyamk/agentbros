import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";
import { openBrowser, selectComposition, renderStill } from "@remotion/renderer";
import { reframeFixture } from "./helpers/review-format-reframe";
import { ReviewService } from "../src/lib/review-ui/service";
import { planProjectRender } from "../src/lib/render-plan";
/** Prepared only. Root allocates one installed-browser cycle after independent source review. */
test(
  "actual asymmetric image cover default mapped and Undo pixels in all three formats",
  { skip: process.env.RUN_FORMAT_REFRAME_RENDER_TESTS !== "1", timeout: 90000 },
  async () => {
    const artifacts = process.env.FORMAT_REFRAME_ARTIFACTS;
    assert.ok(artifacts, "Explicit retained artifact directory required");
    fs.mkdirSync(artifacts, { recursive: true });
    const f = reframeFixture(),
      service = new ReviewService("demo", f.root),
      before = f.store.read(),
      original = fs.readFileSync(f.file),
      sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
    const report: Record<string, unknown> = {
      source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      apiCalls: 0,
      limits: "Tiny static-image geometry diagnostic; no encoded video, PCM, motion, font/creative/provider acceptance",
    };
    try {
      browser = await openBrowser("chrome", {
        browserExecutable:
          process.env.REMOTION_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        logLevel: "error",
      });
      const checkout = process.cwd(),
        serveUrl = await bundle({
          entryPoint: path.resolve("src/index.ts"),
          publicDir: path.join(f.root, "public"),
          outDir: path.join(f.root, "bundle"),
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
      const formats = ["vertical", "square", "landscape"] as const,
        sizes = { vertical: [90, 160], square: [90, 90], landscape: [160, 90] } as const;
      const render = async (stage: string) => {
        const rows: Record<string, Buffer> = {};
        for (const format of formats) {
          const job = planProjectRender("demo", format, f.root, { timeline: true, captions: "off" }).jobs[0],
            selected = await selectComposition({
              serveUrl,
              id: job.compositionId,
              inputProps: job.props,
              puppeteerInstance: browser,
              logLevel: "error",
            }),
            [width, height] = sizes[format],
            output = path.join(artifacts, `${stage}-${format}.png`);
          await renderStill({
            serveUrl,
            composition: { ...selected, width, height },
            inputProps: job.props,
            puppeteerInstance: browser,
            output,
            frame: 15,
            imageFormat: "png",
            logLevel: "error",
          });
          rows[format] = execFileSync(
            "ffmpeg",
            [
              "-v",
              "error",
              "-threads",
              "1",
              "-i",
              output,
              "-frames:v",
              "1",
              "-pix_fmt",
              "rgb24",
              "-f",
              "rawvideo",
              "pipe:1",
            ],
            { timeout: 10000, maxBuffer: 1024 * 1024 },
          );
          assert.equal(rows[format].length, width * height * 3);
        }
        return rows;
      };
      const baseline = await render("baseline"),
        positions = { vertical: { x: 0, y: 0 }, square: { x: 1, y: 1 }, landscape: { x: 0.5, y: 0 } },
        binding = { trackId: f.ir.tracks[0].id, clipId: f.ir.tracks[0].clips[0].id };
      const commands = formats.map(
        (format) =>
          service.visualReframeProposal({ expectedRevision: 0, ...binding, format, position: positions[format] })
            .command,
      );
      assert.deepEqual(f.store.read(), before);
      f.store.apply({ type: "batch", commands }, 0);
      assert.equal(f.store.read().undo.length, 1);
      const mapped = await render("mapped");
      f.store.undo(1);
      assert.deepEqual(f.store.read().timeline, before.timeline);
      const undo = await render("undo");
      for (const format of formats) {
        assert.notDeepEqual(mapped[format], baseline[format], format + " must visibly honor its own map");
        assert.deepEqual(undo[format], baseline[format], format + " Undo must restore exact default pixels");
      } // Cover geometry in original pixels: square x=54 samples centered x≈6.84 (green)
      // versus right-aligned x≈8.84 (blue). Landscape y=42 samples top y≈3.19
      // versus centered y≈3.81; mapped is inside upper blue100, centered blends into blue255.
      const coordinates = { vertical: { x: 45, y: 80 }, square: { x: 54, y: 27 }, landscape: { x: 80, y: 42 } };
      const samples = formats.map((format) => {
        const { x, y } = coordinates[format],
          [width, height] = sizes[format];
        assert.ok(x >= 0 && x < width && y >= 0 && y < height);
        const rgb = (bytes: Buffer) => Array.from(bytes.subarray((y * width + x) * 3, (y * width + x) * 3 + 3));
        return {
          format,
          x,
          y,
          width,
          height,
          baselineRgb: rgb(baseline[format]),
          mappedRgb: rgb(mapped[format]),
          undoRgb: rgb(undo[format]),
        };
      });
      report.samples = samples;
      for (const sample of samples) assert.deepEqual(sample.undoRgb, sample.baselineRgb);
      const [v, s, l] = samples;
      assert.deepEqual(v.baselineRgb.slice(0, 2), [0, 255], "Centered vertical sample must be in green middle column");
      assert.deepEqual(v.mappedRgb.slice(0, 2), [255, 0], "x0 vertical must expose left red column");
      assert.deepEqual(s.baselineRgb, [0, 255, 100], "Centered square interior must remain in upper green column");
      assert.deepEqual(s.mappedRgb, [0, 0, 100], "x1 square must expose upper right blue column");
      assert.deepEqual(l.baselineRgb.slice(0, 2), [0, 255]);
      assert.deepEqual(l.mappedRgb, [0, 255, 100], "y0 landscape sample must be in upper green/blue100 band");
      assert.ok(
        l.baselineRgb[2] > 100 && l.baselineRgb[2] < 255,
        "Centered landscape sample must blend the source upper100/lower255 blue bands",
      );
      assert.ok(l.mappedRgb[2] < l.baselineRgb[2], "Top alignment must move the sampled color toward the upper band");
      assert.deepEqual(fs.readFileSync(f.file), original);
      fs.writeFileSync(path.join(artifacts, "asymmetric-original.png"), original);
      Object.assign(report, {
        passed: true,
        originalSha256: sha(original),
        positions,
        commands,
        checks: formats.map((format) => ({
          format,
          baseline: sha(baseline[format]),
          mapped: sha(mapped[format]),
          undo: sha(undo[format]),
        })),
      });
    } catch (error) {
      report.passed = false;
      report.error = String(error);
      throw error;
    } finally {
      try {
        await browser?.close({ silent: true });
      } finally {
        fs.writeFileSync(path.join(artifacts, "acceptance.json"), JSON.stringify(report, null, 2) + "\n");
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    }
  },
);
