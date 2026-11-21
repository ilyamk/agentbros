import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const decodeRgb = (file: string) =>
  execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 8 * 1024 * 1024,
  });

function changedPixels(a: Buffer, b: Buffer) {
  assert.equal(a.length, b.length, "The captures have different dimensions");
  let different = 0;
  for (let index = 0; index < a.length; index += 3) {
    if (
      Math.max(
        Math.abs(a[index]! - b[index]!),
        Math.abs(a[index + 1]! - b[index + 1]!),
        Math.abs(a[index + 2]! - b[index + 2]!),
      ) > 32
    )
      different++;
  }
  return different;
}

const subjects = [
  { id: "DreiProjector", range: [65, 69], final: 149 },
  { id: "DreiConnector", range: [101, 105], final: 149 },
  { id: "DreiLatch", range: [81, 85], final: 119 },
  { id: "DreiAirPath", range: [113, 117], final: 149 },
  { id: "DreiOptics", range: [59, 63], final: 149 },
  { id: "DreiCells", range: [107, 111], final: 179 },
] as const;

test(
  "Drei demos survive parallel renders and shuffled seeks",
  {
    skip: process.env.RUN_DREI_RENDER_TESTS !== "1",
    timeout: 1_800_000,
  },
  async (t) => {
    const { bundle } = await import("@remotion/bundler");
    const { openBrowser, selectComposition, renderFrames, renderStill } = await import("@remotion/renderer");
    const { enableTailwind } = await import("@remotion/tailwind-v4");
    const work = mkdtempSync(path.join(tmpdir(), "drei-frame-evidence-"));
    t.after(() => rmSync(work, { recursive: true, force: true }));
    const serveUrl = await bundle({
      entryPoint: path.resolve("src/motion/lab/drei.tsx"),
      publicDir: path.resolve("public"),
      outDir: path.join(work, "bundle"),
      symlinkPublicDir: true,
      webpackOverride: enableTailwind,
    });
    const chromiumOptions = { gl: "angle" } as const;
    const browser = await openBrowser("chrome", { chromiumOptions, logLevel: "error" });
    try {
      for (const { id, range, final } of subjects) {
        for (const suffix of ["L", "V"]) {
          const subject = id + suffix;
          const cwd = path.join(work, subject);
          mkdirSync(cwd);
          const common = { serveUrl, chromiumOptions, puppeteerInstance: browser, logLevel: "error" as const };
          const composition = await selectComposition({ ...common, id: subject });
          const settings = { ...common, composition, inputProps: {}, imageFormat: "png" as const, scale: 0.5 };
          const render = async (concurrency: number): Promise<Buffer[]> => {
            const outputDir = path.join(cwd, String(concurrency));
            await renderFrames({
              ...settings,
              outputDir,
              concurrency,
              frameRange: [...range],
              onStart: () => undefined,
              onFrameUpdate: () => undefined,
            });
            return readdirSync(outputDir)
              .sort()
              .map((file) => decodeRgb(path.join(outputDir, file)));
          };
          const still = async (frame: number) => {
            const output = path.join(cwd, `still-${frame}.png`);
            await renderStill({ ...settings, frame, output, overwrite: true });
            return decodeRgb(output);
          };
          const serial = await render(1);
          const parallel = await render(4);
          assert.equal(serial.length, range[1] - range[0] + 1, subject);
          assert.equal(parallel.length, serial.length, subject);
          const compare = (a: Buffer, b: Buffer, note: string) => {
            const diff = changedPixels(a, b);
            const tolerance = Math.floor((a.length / 3) * 0.0001);
            assert.ok(diff <= tolerance, `${subject} ${note}: ${diff} changed pixels exceeds ${tolerance}`);
          };
          parallel.forEach((frame, index) => compare(serial[index]!, frame, `parallel ${range[0] + index}`));
          const tail = await still(final);
          for (const frame of [range[1], range[0], range[0] + 2, range[0] + 1]) {
            compare(serial[frame - range[0]]!, await still(frame), `seek ${frame}`);
          }
          compare(tail, await still(final), "seek back to the final pose");
          assert.ok(changedPixels(tail, await still(0)) > 100, `${subject} scarcely changes during the shot`);
          t.diagnostic(`${subject}: five frames match across workers, shuffled seeks and the repeated final pose`);
        }
      }
    } finally {
      await browser.close({ silent: true });
    }
  },
);
