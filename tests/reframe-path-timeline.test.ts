import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { clipSourceFrame, positionAt, visualObjectPosition } from "../src/lib/timeline-ir/reframe";
import { planProjectRender } from "../src/lib/render-plan";
import { VisualReframesSchema } from "../src/types/timeline";
import { reframeFixture } from "./helpers/review-format-reframe";

const r = (num: number, den = 1) => ({ num, den });
const ir = () => ({
  version: 1 as const,
  projectId: "demo",
  timebase: r(30),
  tracks: [
    {
      id: "visual",
      kind: "visual" as const,
      clips: [
        {
          id: "a",
          assetId: "sha256:" + "a".repeat(64),
          start: r(0),
          source: { start: r(30), end: r(120), timebase: r(30) },
          rate: r(1),
          transition: { kind: "cut" as const },
          captions: [],
        },
      ],
    },
  ],
});
const path_ = {
  keyframes: [
    { frame: 30, x: 0, y: 0.5 },
    { frame: 89, x: 0, y: 0.5 },
    { frame: 90, x: 1, y: 0.5 },
    { frame: 119, x: 0.5, y: 0.5 },
  ],
};

test("a static position still renders as before; a crop path is read at the source frame", () => {
  assert.equal(visualObjectPosition({ reframe: { vertical: { x: 0.25, y: 0.5 } } }, "vertical", 999), "25% 50%");
  assert.equal(visualObjectPosition({}, "vertical", 10), undefined);
  assert.equal(visualObjectPosition({ reframe: { vertical: path_ } }, "vertical", 60), "0% 50%");
  assert.equal(
    visualObjectPosition({ reframe: { vertical: path_ } }, "vertical", 90),
    "100% 50%",
    "shot reset is a step",
  );
  assert.equal(visualObjectPosition({ reframe: { vertical: path_ } }, "vertical", 500), "50% 50%");
  assert.deepEqual(positionAt(path_.keyframes, 104.5), { x: 0.75, y: 0.5 });
  assert.equal(visualObjectPosition({ reframe: { vertical: path_ } }, "square"), undefined);
});

for (const timebase of [r(25), r(30000, 1001)]) {
  test(`a shot step never blends: ${timebase.num}/${timebase.den} fps source on a 30 fps timeline`, () => {
    const step = {
      reframe: {
        vertical: {
          keyframes: [
            { frame: 0, x: 0, y: 0.5 },
            { frame: 99, x: 0, y: 0.5 },
            { frame: 100, x: 1, y: 0.5 },
            { frame: 200, x: 1, y: 0.5 },
          ],
        },
      },
    };
    const source = { start: r(0), timebase };
    const seconds = (frame: number) => (frame * timebase.den) / timebase.num;
    let switched = false;
    for (let local = 0; local < 200; local++) {
      const frame = clipSourceFrame(source, r(1), local, 30, 300);
      assert.ok(Number.isInteger(frame));
      const value = visualObjectPosition(step, "vertical", frame);
      assert.ok(value === "0% 50%" || value === "100% 50%", `local ${local}: ${value}`);
      const after = local / 30 + 1e-9 >= seconds(100);
      assert.equal(value === "100% 50%", after, `local ${local}`);
      switched ||= after;
    }
    assert.ok(switched);
    assert.equal(clipSourceFrame(source, r(1), 119, 30, 300), timebase.num === 25 ? 99 : 118);
  });
}

test("a 60 fps source with an odd start reads the crop at the frame the renderer shows", () => {
  const source = { start: r(101), end: r(400), timebase: r(60) };
  const step = {
    reframe: {
      vertical: {
        keyframes: [
          { frame: 0, x: 0, y: 0.5 },
          { frame: 201, x: 0, y: 0.5 },
          { frame: 202, x: 1, y: 0.5 },
          { frame: 400, x: 1, y: 0.5 },
        ],
      },
    },
  };
  for (let local = 0; local < 140; local++) {
    const shown = Math.floor(((Math.round((101 * 30) / 60) + local) * 60) / 30);
    assert.equal(clipSourceFrame(source, r(1), local, 30, 299), shown, `local ${local}`);
    assert.equal(
      visualObjectPosition(step, "vertical", clipSourceFrame(source, r(1), local, 30, 299)),
      shown >= 202 ? "100% 50%" : "0% 50%",
    );
  }
  assert.equal(clipSourceFrame(source, r(1), 0, 30, 299), 102);
});

test("frames past the owned span hold the last owned source frame", () => {
  assert.equal(clipSourceFrame({ start: r(10), timebase: r(30) }, r(1), 50, 30, 20), 29);
  assert.equal(clipSourceFrame({ start: r(10), timebase: r(30) }, r(2), 5, 30, 20), 20);
});

test("reframe-visual accepts a crop path, keeps it across split and clears it with null", () => {
  const withPath = applyEdit(ir(), {
    type: "reframe-visual",
    trackId: "visual",
    clipId: "a",
    format: "vertical",
    position: path_,
  });
  assert.deepEqual(VisualReframesSchema.parse(withPath.tracks[0]!.clips[0]!.payload!.reframe).vertical, path_);
  const split = applyEdit(withPath, { type: "split", trackId: "visual", clipId: "a", at: r(45), newClipId: "b" });
  const right = split.tracks[0]!.clips.find((clip) => clip.id === "b")!;
  assert.deepEqual(
    (right.payload!.reframe as { vertical: unknown }).vertical,
    path_,
    "source-keyed path survives a split unchanged",
  );
  assert.equal(right.source.start.num, 75);
  const cleared = applyEdit(withPath, {
    type: "reframe-visual",
    trackId: "visual",
    clipId: "a",
    format: "vertical",
    position: null,
  });
  assert.equal(cleared.tracks[0]!.clips[0]!.payload?.reframe, undefined);
  assert.throws(() =>
    applyEdit(ir(), {
      type: "reframe-visual",
      trackId: "visual",
      clipId: "a",
      format: "vertical",
      position: {
        keyframes: [
          { frame: 5, x: 0, y: 0 },
          { frame: 5, x: 1, y: 0 },
        ],
      },
    }),
  );
  assert.throws(() =>
    applyEdit(ir(), {
      type: "reframe-visual",
      trackId: "visual",
      clipId: "a",
      format: "vertical",
      position: { keyframes: [] },
    }),
  );
});

test(
  "render: a crop path moves the vertical cover crop frame by frame",
  {
    skip:
      process.env.RUN_REFRAME_RENDER_TESTS === "1"
        ? false
        : "set RUN_REFRAME_RENDER_TESTS=1 (bundles Remotion and renders stills in Chrome)",
    timeout: 300000,
  },
  async () => {
    const { bundle } = await import("@remotion/bundler");
    const { enableTailwind } = await import("@remotion/tailwind-v4");
    const { openBrowser, renderStill, selectComposition } = await import("@remotion/renderer");
    const f = reframeFixture();
    const document = f.store.read();
    const clip = document.timeline.tracks[0]!.clips[0]!;
    const start = clip.source.start.num / clip.source.start.den;
    const last = clip.source.end.num / clip.source.end.den - 1;
    f.store.apply(
      {
        type: "reframe-visual",
        trackId: document.timeline.tracks[0]!.id,
        clipId: clip.id,
        format: "vertical",
        position: {
          keyframes: [
            { frame: Math.floor(start), x: 0, y: 0.5 },
            { frame: Math.ceil(last), x: 1, y: 0.5 },
          ],
        },
      },
      document.revision,
    );
    const checkout = process.cwd();
    const serveUrl = await bundle({
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
    const browser = await openBrowser("chrome", {
      browserExecutable:
        process.env.REMOTION_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      logLevel: "error",
    });
    try {
      const job = planProjectRender("demo", "vertical", f.root, { timeline: true, captions: "off" }).jobs[0]!;
      const selected = await selectComposition({
        serveUrl,
        id: job.compositionId,
        inputProps: job.props,
        puppeteerInstance: browser,
        logLevel: "error",
      });
      const pixel = async (frame: number) => {
        const output = path.join(f.root, `frame-${frame}.png`);
        await renderStill({
          serveUrl,
          composition: { ...selected, width: 90, height: 160 },
          inputProps: job.props,
          puppeteerInstance: browser,
          output,
          frame,
          imageFormat: "png",
          logLevel: "error",
        });
        const rgb = execFileSync(
          "ffmpeg",
          ["-v", "error", "-i", output, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
          { maxBuffer: 1 << 20 },
        );
        return Array.from(rgb.subarray((100 * 90 + 45) * 3, (100 * 90 + 45) * 3 + 3));
      };
      const first = await pixel(0);
      const end = await pixel(Math.ceil(last - start) - 1);
      assert.deepEqual(first.slice(0, 2), [255, 0], "start of the path exposes the left red column");
      assert.deepEqual(end.slice(0, 2), [0, 0], "end of the path exposes the right blue column");
    } finally {
      await browser.close({ silent: true });
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  },
);

const recutPayload = (extra: Record<string, unknown> = {}) => ({
  volume: 1,
  sourceHash: "b".repeat(64),
  editHash: "c".repeat(64),
  ...extra,
});
const recut = (payload: Record<string, unknown>) => {
  const timeline = ir();
  (timeline.tracks[0]!.clips[0] as Record<string, unknown>).payload = payload;
  return timeline;
};

test("recording-edit picture clips take a crop path and keep their payload; punch-in transforms are allowed", () => {
  for (const payload of [recutPayload(), recutPayload({ transform: { scale: 1.2 } })]) {
    const edited = applyEdit(recut(payload), {
      type: "reframe-visual",
      trackId: "visual",
      clipId: "a",
      format: "vertical",
      position: path_,
    });
    const result = edited.tracks[0]!.clips[0]!.payload!;
    assert.deepEqual({ ...result, reframe: undefined }, { ...payload, reframe: undefined });
    assert.deepEqual((result.reframe as { vertical: unknown }).vertical, path_);
    const split = applyEdit(edited, { type: "split", trackId: "visual", clipId: "a", at: r(45), newClipId: "b" });
    assert.deepEqual(split.tracks[0]!.clips.find((clip) => clip.id === "b")!.payload, result);
  }
  for (const payload of [
    { volume: 1, editHash: "c" },
    recutPayload({ scene: {} }),
    recutPayload({ transform: { scale: 1.2, skew: 3 } }),
    { transform: { scale: 1.2 } },
  ]) {
    assert.throws(
      () =>
        applyEdit(recut(payload), {
          type: "reframe-visual",
          trackId: "visual",
          clipId: "a",
          format: "vertical",
          position: path_,
        }),
      /plain visual/,
    );
  }
});

test(
  "render: a punch-in scales the cropped frame about its centre",
  {
    skip:
      process.env.RUN_REFRAME_RENDER_TESTS === "1"
        ? false
        : "set RUN_REFRAME_RENDER_TESTS=1 (bundles Remotion and renders stills in Chrome)",
    timeout: 300000,
  },
  async () => {
    const { bundle } = await import("@remotion/bundler");
    const { enableTailwind } = await import("@remotion/tailwind-v4");
    const { openBrowser, renderStill, selectComposition } = await import("@remotion/renderer");
    const f = reframeFixture();
    const document = f.store.read();
    const clip = document.timeline.tracks[0]!.clips[0]!;
    clip.payload = { ...clip.payload, ...recutPayload({ transform: { scale: 2 } }) };
    fs.writeFileSync(f.store.file, JSON.stringify(document));
    const start = clip.source.start.num / clip.source.start.den;
    const last = clip.source.end.num / clip.source.end.den - 1;
    f.store.apply(
      {
        type: "reframe-visual",
        trackId: document.timeline.tracks[0]!.id,
        clipId: clip.id,
        format: "vertical",
        position: {
          keyframes: [
            { frame: Math.floor(start), x: 0, y: 0.5 },
            { frame: Math.ceil(last), x: 1, y: 0.5 },
          ],
        },
      },
      document.revision,
    );
    const checkout = process.cwd();
    const serveUrl = await bundle({
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
    const browser = await openBrowser("chrome", {
      browserExecutable:
        process.env.REMOTION_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      logLevel: "error",
    });
    try {
      const job = planProjectRender("demo", "vertical", f.root, { timeline: true, captions: "off" }).jobs[0]!;
      const selected = await selectComposition({
        serveUrl,
        id: job.compositionId,
        inputProps: job.props,
        puppeteerInstance: browser,
        logLevel: "error",
      });
      const pixel = async (frame: number, x: number) => {
        const output = path.join(f.root, `punch-${frame}.png`);
        await renderStill({
          serveUrl,
          composition: { ...selected, width: 90, height: 160 },
          inputProps: job.props,
          puppeteerInstance: browser,
          output,
          frame,
          imageFormat: "png",
          logLevel: "error",
        });
        const rgb = execFileSync(
          "ffmpeg",
          ["-v", "error", "-i", output, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
          { maxBuffer: 1 << 20 },
        );
        return Array.from(rgb.subarray((100 * 90 + x) * 3, (100 * 90 + x) * 3 + 3));
      };
      // The 12-px source covers 240×160 and the crop shows 90 px of it (20 px per column; red 0–4, green 4–8, blue 8–12).
      // Alignment 0: x=85 is column 4.25 (green) unscaled; scaled 2 about the centre it is crop pixel 65, column 3.25 (red).
      // Alignment 1: x=5 is column 7.75 (green) unscaled; scaled it is crop pixel 25, column 8.75 (blue).
      assert.deepEqual((await pixel(0, 85)).slice(0, 2), [255, 0]);
      assert.deepEqual((await pixel(Math.ceil(last - start) - 1, 5)).slice(0, 2), [0, 0]);
    } finally {
      await browser.close({ silent: true });
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  },
);
