import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// GSAP blocks seek a paused timeline from the Remotion frame. Proof that they are pure functions of the frame: the same
// frames rendered with one worker, with four, and as stills in shuffled order must match.
//
// "Match" is a pixel tolerance, not a hash. Chrome's anti-aliasing of SVG and glyph edges varies by a few pixels between
// tabs: a few isolated edge pixels, at most 28 of 255, on frames that change from run to run. Plain interpolate()
// blocks do the same, so a non-GSAP baseline runs under the identical tolerance. A real seek bug moves whole glyphs or
// shapes: hundreds of pixels at full contrast.
const enabled = process.env.RUN_GSAP_RENDER_TESTS === "1";
const SCALE = 0.5;
/** A pixel counts as different when any channel moves by more than this. */
const CHANNEL_TOLERANCE = 32;
/** Share of a frame's pixels allowed to differ by more than CHANNEL_TOLERANCE. */
const PIXEL_SHARE = 0.0001;

const kinetic = (process.env.GSAP_COMPOSITIONS ?? "split-reveal,decode,morph-mark,line-draw,headline-build,path-travel")
  .split(",")
  .filter(Boolean)
  .map((id) => `Lib-kinetic-${id}-L`);
const SUITES = [
  { entry: "src/motion/library/kinetic/preview.tsx", ids: kinetic },
  { entry: "src/motion/library/typography/preview.tsx", ids: ["Lib-type-masked-editorial-L"] },
];

const rgb = (file: string): Buffer => {
  const child = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${child.stderr.toString()}`);
  return child.stdout;
};

type Diff = { pixels: number; max: number };
const compare = (a: Buffer, b: Buffer): Diff => {
  assert.equal(a.length, b.length, "frame sizes differ");
  let pixels = 0;
  let max = 0;
  for (let index = 0; index < a.length; index += 3) {
    const delta = Math.max(
      Math.abs(a[index] - b[index]),
      Math.abs(a[index + 1] - b[index + 1]),
      Math.abs(a[index + 2] - b[index + 2]),
    );
    if (delta > max) max = delta;
    if (delta > CHANNEL_TOLERANCE) pixels += 1;
  }
  return { pixels, max };
};

test(
  "GSAP kinetic blocks render matching frames across concurrency and seek order",
  { skip: !enabled, timeout: 1800000 },
  async () => {
    const { bundle } = await import("@remotion/bundler");
    const { openBrowser, renderFrames, renderStill, selectComposition } = await import("@remotion/renderer");
    const { enableTailwind } = await import("@remotion/tailwind-v4");
    const work = mkdtempSync(path.join(tmpdir(), "gsap-determinism-"));
    const browser = await openBrowser("chrome", { logLevel: "error" });
    try {
      for (const [suite, { entry, ids }] of SUITES.entries()) {
        const serveUrl = await bundle({
          entryPoint: path.resolve(entry),
          publicDir: path.resolve("public"),
          outDir: path.join(work, `bundle-${suite}`),
          symlinkPublicDir: true,
          webpackOverride: enableTailwind,
        });
        for (const id of ids) {
          const composition = await selectComposition({ serveUrl, id, puppeteerInstance: browser, logLevel: "error" });
          const limit = Math.floor(composition.width * SCALE * composition.height * SCALE * PIXEL_SHARE);
          const sequence = async (concurrency: number) => {
            const outputDir = path.join(work, id, `c${concurrency}`);
            await renderFrames({
              serveUrl,
              composition,
              inputProps: {},
              outputDir,
              imageFormat: "png",
              concurrency,
              scale: SCALE,
              puppeteerInstance: browser,
              logLevel: "error",
              onStart: () => undefined,
              onFrameUpdate: () => undefined,
            });
            return readdirSync(outputDir)
              .sort()
              .map((name) => path.join(outputDir, name));
          };
          const one = await sequence(1);
          const four = await sequence(4);
          assert.equal(one.length, composition.durationInFrames, `${id}: frame count`);
          const failures: string[] = [];
          let touched = 0;
          let worst = 0;
          const reference = one.map((file) => rgb(file));
          const check = (label: string, frame: number, file: string) => {
            const diff = compare(reference[frame], rgb(file));
            if (diff.max > 0) touched += 1;
            worst = Math.max(worst, diff.max);
            if (diff.pixels > limit)
              failures.push(
                `${label} frame ${frame}: ${diff.pixels} px over ${CHANNEL_TOLERANCE} (limit ${limit}), max ${diff.max}`,
              );
          };
          four.forEach((file, frame) => check("concurrency 4", frame, file));
          // A fixed shuffle, so a failure reproduces.
          const frames = one
            .map((_, frame) => ({ frame, key: (frame * 7919) % 101 }))
            .sort((a, b) => a.key - b.key)
            .map(({ frame }) => frame)
            .slice(0, 24);
          for (const frame of frames) {
            const output = path.join(work, id, `still-${frame}.png`);
            await renderStill({
              serveUrl,
              composition,
              frame,
              output,
              imageFormat: "png",
              scale: SCALE,
              puppeteerInstance: browser,
              logLevel: "error",
            });
            check("shuffled still", frame, output);
          }
          assert.deepEqual(failures, [], `${id}: frames beyond the anti-aliasing tolerance`);
          process.stderr.write(
            `${id}: ${one.length} frames at concurrency 1 vs 4 and ${frames.length} shuffled stills within tolerance; ${touched} comparisons not byte-identical, worst channel delta ${worst}\n`,
          );
        }
      }
    } finally {
      await browser.close({ silent: true });
      rmSync(work, { recursive: true, force: true });
    }
  },
);
