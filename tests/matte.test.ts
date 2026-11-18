import { PYTHON_VERSION } from "../src/lib/python";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  modelName,
  ONNX_MODEL_ID,
  ONNX_SYNC,
  selectEngine,
  VISION_PREPARE,
  type EngineFacts,
} from "../src/lib/matte/engine";
import { workerArgs } from "../src/lib/matte/onnx";
import {
  accumulateFlicker,
  blockMeans,
  boxMean,
  cellFor,
  coverage,
  emptyFlicker,
  flickerReport,
  guidedRefine,
  historyWeight,
  motionGrid,
  smoothStep,
  type Frame,
} from "../src/lib/matte/temporal";
import { loadAssets, resolveTarget } from "../src/lib/shared-assets";
import { MatteReceiptSchema } from "../src/types/matte";

const ready = { available: true };
const facts = (over: Partial<EngineFacts> = {}): EngineFacts => ({
  platform: "darwin",
  macosMajor: 15,
  vision: ready,
  onnx: ready,
  ...over,
});

test("auto picks Vision on a prepared macOS and ONNX everywhere else", () => {
  assert.deepEqual(selectEngine("auto", "subject", facts()), { ok: true, engine: "vision" });
  assert.deepEqual(selectEngine("auto", "person", facts()), { ok: true, engine: "vision" });
  for (const platform of ["linux", "win32"] as const)
    assert.deepEqual(
      selectEngine("auto", "subject", facts({ platform, macosMajor: undefined, vision: { available: false } })),
      { ok: true, engine: "onnx" },
    );
});

test("auto falls back to ONNX on macOS with the reason recorded", () => {
  const old = selectEngine("auto", "subject", facts({ macosMajor: 13 }));
  assert.equal(old.ok && old.engine, "onnx");
  assert.match(old.ok ? (old.fallback ?? "") : "", /macOS 14\+/);
  // Person segmentation exists from macOS 12, so a macOS 13 host still gets Vision for people.
  assert.deepEqual(selectEngine("auto", "person", facts({ macosMajor: 13 })), { ok: true, engine: "vision" });
  const unprepared = selectEngine("auto", "subject", facts({ vision: { available: false, reason: "no config" } }));
  assert.equal(unprepared.ok && unprepared.engine, "onnx");
  assert.ok(unprepared.ok && unprepared.fallback?.includes(VISION_PREPARE));
});

test("an explicit engine that cannot run is an error with its fix, never a silent switch", () => {
  const offMac = selectEngine("vision", "subject", facts({ platform: "linux", macosMajor: undefined }));
  assert.equal(offMac.ok, false);
  assert.equal(!offMac.ok && offMac.code, "INVALID_INPUT");
  const unprepared = selectEngine("vision", "subject", facts({ vision: { available: false } }));
  assert.equal(!unprepared.ok && unprepared.fix, VISION_PREPARE);
  const noWeights = selectEngine("onnx", "subject", facts({ onnx: { available: false } }));
  assert.equal(!noWeights.ok && noWeights.code, "ASSET_MISSING");
  assert.equal(!noWeights.ok && noWeights.fix, ONNX_SYNC);
  const nothing = selectEngine(
    "auto",
    "subject",
    facts({ platform: "linux", macosMajor: undefined, vision: { available: false }, onnx: { available: false } }),
  );
  assert.equal(!nothing.ok && nothing.fix, ONNX_SYNC);
});

test("model names and the uvx argument array are pinned", () => {
  assert.equal(modelName("vision", "subject"), "apple-vision-foreground-instance");
  assert.equal(modelName("vision", "person"), "apple-vision-person-segmentation");
  assert.match(modelName("onnx", "person"), /^birefnet-general-lite/);
  const args = workerArgs("/tmp/request.json");
  assert.equal(args[args.indexOf("--python") + 1], PYTHON_VERSION);
  assert.equal(args[args.indexOf("--group") + 1], "matte");
  assert.ok(args.includes("--locked"));
  assert.ok(
    args.includes("-I") &&
      args.at(-1) === "/tmp/request.json" &&
      args.at(-2)!.endsWith("scripts/workers/frame-matte-onnx.py"),
  );
});

test("the ONNX weights live in the model cache, pinned by sha256, never under public/", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "matte-cache-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });
  const model = loadAssets(process.cwd(), ["models"]).find((asset) => asset.id === ONNX_MODEL_ID);
  assert.ok(model);
  assert.match(model.target, /^\$MODELS\//);
  assert.match(model.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(model.licence, /^MIT/);
  assert.equal(model.source.kind, "url");
  assert.match(
    model.source.kind === "url" ? model.source.url : "",
    /^https:\/\/github\.com\/ZhengPeng7\/BiRefNet\/releases\/download\//,
  );
  const saved = process.env.AGENTBROS_MODEL_CACHE;
  try {
    delete process.env.AGENTBROS_MODEL_CACHE;
    assert.equal(resolveTarget("$MODELS/matte/x.onnx", "/repo"), path.join(home, ".cache/agentbros/matte/x.onnx"));
    process.env.AGENTBROS_MODEL_CACHE = "/models";
    assert.equal(resolveTarget("$MODELS/matte/x.onnx", "/repo"), "/models/matte/x.onnx");
    assert.equal(resolveTarget("public/shared/a.png", "/repo"), "/repo/public/shared/a.png");
  } finally {
    if (saved === undefined) delete process.env.AGENTBROS_MODEL_CACHE;
    else process.env.AGENTBROS_MODEL_CACHE = saved;
  }
});

const receipt = () => ({
  version: 1,
  createdAt: "2026-11-15T00:00:00.000Z",
  kind: "subject",
  requestedEngine: "auto",
  engine: {
    name: "onnx",
    model: "birefnet-general-lite-swin-v1-tiny-epoch232",
    runtime: "onnxruntime 1.22.1 CPUExecutionProvider",
    sha256: "a".repeat(64),
  },
  fallback: "vision unavailable: Apple Vision needs macOS (this host is linux)",
  input: {
    path: "clip.mp4",
    sha256: "b".repeat(64),
    kind: "video",
    width: 1080,
    height: 1920,
    fps: 30,
    startFrame: 12,
    frames: 24,
  },
  outputs: { cutout: "out/cutout/frame-%05d.png", alpha: "out/alpha/frame-%05d.png", prores: "out/cutout.mov" },
  timings: { totalMs: 1000, loadMs: 100, perFrameMs: { mean: 30, max: 40 }, temporalMs: 50, loadAverage: 1.5 },
  coverage: { mean: 0.2, min: 0.1, max: 0.3, emptyFrames: [] },
  temporal: {
    mode: "ema",
    strength: 0.6,
    refine: false,
    flickerBefore: { pairs: 23, stableShare: 0.8, stable: 0.4, stableEdge: 6.1, movingDelta: null },
    flickerAfter: { pairs: 23, stableShare: 0.8, stable: 0.2, stableEdge: 2.9, movingDelta: 0.7 },
  },
  warnings: [],
});

test("the receipt schema is strict and versioned", () => {
  assert.ok(MatteReceiptSchema.safeParse(receipt()).success);
  assert.equal(MatteReceiptSchema.safeParse({ ...receipt(), extra: 1 }).success, false);
  assert.equal(MatteReceiptSchema.safeParse({ ...receipt(), version: 2 }).success, false);
  assert.equal(
    MatteReceiptSchema.safeParse({ ...receipt(), engine: { ...receipt().engine, name: "fal" } }).success,
    false,
  );
  const { fallback: _fallback, ...withoutFallback } = receipt();
  const { prores: _prores, ...outputs } = receipt().outputs;
  assert.ok(MatteReceiptSchema.safeParse({ ...withoutFallback, outputs }).success, "fallback and prores are optional");
});

const frame = (width: number, height: number, fill: (x: number, y: number) => number): Frame => {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y);
  return { width, height, data };
};

test("history weight: full strength when still, zero at tau and beyond, off at strength 0", () => {
  assert.equal(historyWeight(0, 0.6, 0.04), 0.6);
  assert.ok(Math.abs(historyWeight(0.02, 0.6, 0.04) - 0.3) < 1e-9);
  assert.equal(historyWeight(0.04, 0.6, 0.04), 0);
  assert.equal(historyWeight(0.5, 0.6, 0.04), 0);
  assert.equal(historyWeight(0, 0, 0.04), 0);
});

test("block means average grain away; the motion grid max-pools a change into its neighbours", () => {
  const flat = blockMeans(
    frame(8, 8, () => 255),
    4,
  );
  assert.deepEqual([flat.cols, flat.rows], [2, 2]);
  assert.ok([...flat.data].every((value) => value === 1));
  const checker = blockMeans(
    frame(8, 8, (x, y) => ((x + y) % 2 ? 255 : 0)),
    4,
  );
  assert.ok(
    [...checker.data].every((value) => Math.abs(value - 0.5) < 1e-6),
    "a fine checker averages to grey",
  );
  const a = blockMeans(
    frame(16, 16, () => 0),
    4,
  );
  const b = blockMeans(
    frame(16, 16, (x, y) => (x < 4 && y < 4 ? 255 : 0)),
    4,
  );
  const motion = motionGrid(a, b);
  assert.equal(motion.data[0], 1);
  assert.equal(motion.data[1], 1, "the neighbour cell sees the change");
  assert.equal(motion.data[3], 0, "a cell two away does not");
  assert.equal(cellFor(1080, 1920), 8);
  assert.equal(cellFor(2160, 3840), 16);
  assert.equal(cellFor(100, 100), 2);
});

test("the EMA averages alpha only where the picture is still and passes moving pixels through", () => {
  const width = 16;
  const height = 8;
  const raw = frame(width, height, () => 200);
  const previous = new Uint8Array(width * height).fill(100);
  // Left half of the picture still, right half moving.
  const still = blockMeans(
    frame(width, height, () => 50),
    4,
  );
  const moved = blockMeans(
    frame(width, height, (x) => (x < 8 ? 50 : 200)),
    4,
  );
  const motion = motionGrid(still, moved);
  const out = smoothStep(raw, previous, motion, { strength: 0.5, motionTau: 0.04 });
  assert.equal(out[0], 150, "still: half the history");
  assert.equal(out[width - 1], 200, "moving: the raw alpha, no ghost");
  assert.deepEqual(smoothStep(raw, null, null), raw.data, "the first frame passes through");
});

test("box mean and guided refine: flat stays flat, solid and empty stay untouched, a band follows the guide's edge", () => {
  const ones = new Float32Array(25).fill(1);
  assert.ok([...boxMean(ones, 5, 5, 2)].every((value) => Math.abs(value - 1) < 1e-6));
  const ramp = Float32Array.from({ length: 5 }, (_, i) => i);
  assert.deepEqual(
    [...boxMean(ramp, 5, 1, 1)].map((v) => Math.round(v * 100) / 100),
    [0.5, 1, 2, 3, 3.5],
  );
  const solid = frame(20, 20, () => 255);
  assert.deepEqual(
    guidedRefine(
      solid,
      frame(20, 20, (x) => x * 10),
      2,
    ),
    solid.data,
  );
  // A soft, offset alpha edge over a sharp guide edge at x = 10 snaps toward the guide.
  const guide = frame(20, 20, (x) => (x < 10 ? 0 : 255));
  const soft = frame(20, 20, (x) => Math.max(0, Math.min(255, (x - 7) * 40)));
  const refined = guidedRefine(soft, guide, 2, 1e-4);
  const row = 10 * 20;
  assert.ok(refined[row + 8]! < soft.data[row + 8]!, "left of the guide edge loses alpha");
  assert.ok(refined[row + 11]! >= soft.data[row + 11]!, "right of it keeps or gains");
  assert.equal(refined[row + 1], 0);
  assert.equal(refined[row + 19], 255);
});

test("flicker: stable-pixel alpha change before and after, and the lag the smoothing costs where it moves", () => {
  const width = 8;
  const height = 4;
  const motion = { cols: 2, rows: 1, cell: 4, data: Float32Array.from([0, 1]) };
  const totals = emptyFlicker();
  const previous = new Uint8Array(width * height).fill(100);
  const current = new Uint8Array(width * height).fill(110);
  const reference = new Uint8Array(width * height).fill(130);
  accumulateFlicker(totals, previous, current, motion, width, height, reference);
  const report = flickerReport(totals, width * height);
  assert.equal(report.pairs, 1);
  assert.equal(report.stableShare, 0.5);
  assert.equal(report.stable, 10);
  assert.equal(report.stableEdge, 10, "100 -> 110 is an edge value");
  assert.equal(report.movingDelta, 20);
  const solid = emptyFlicker();
  accumulateFlicker(solid, new Uint8Array(32).fill(255), new Uint8Array(32).fill(255), motion, width, height);
  assert.deepEqual(flickerReport(solid, 32), {
    pairs: 1,
    stableShare: 0.5,
    stable: 0,
    stableEdge: 0,
    movingDelta: null,
  });
  assert.equal(coverage(Uint8Array.from([0, 127, 128, 255])), 0.5);
});

test("smoothing lowers measured flicker on a noisy still edge", () => {
  const width = 32;
  const height = 8;
  const picture = frame(width, height, (x) => (x < 16 ? 30 : 220));
  const grid = blockMeans(picture, 4);
  const still = motionGrid(grid, grid);
  // A matte edge that jitters by up to +-40 alpha from frame to frame, deterministic.
  const jitter = (t: number) =>
    frame(width, height, (x) => Math.max(0, Math.min(255, (x - 12) * 32 + ((t * 37) % 81) - 40)));
  const before = emptyFlicker();
  const after = emptyFlicker();
  let previousRaw: Uint8Array | null = null;
  let previousOut: Uint8Array | null = null;
  for (let t = 0; t < 12; t++) {
    const raw = jitter(t);
    const out = smoothStep(raw, previousOut, previousOut ? still : null, { strength: 0.6 });
    if (previousRaw && previousOut) {
      accumulateFlicker(before, previousRaw, raw.data, still, width, height);
      accumulateFlicker(after, previousOut, out, still, width, height, raw.data);
    }
    previousRaw = raw.data;
    previousOut = out;
  }
  const b = flickerReport(before, width * height);
  const a = flickerReport(after, width * height);
  assert.ok(a.stableEdge < b.stableEdge * 0.6, `${a.stableEdge} < 0.6 x ${b.stableEdge}`);
});
