import test from "node:test";
import assert from "node:assert/strict";
import {
  admitCopyCanvas,
  relativeCopyBox,
  copyBoxObservation,
  exactCopyFacesReady,
  stableCopyObservation,
} from "./helpers/copy-canvas-geometry";
const canvas = { x: 14, y: 23, width: 1080, height: 1920 };
const input = {
  expectedWidth: 1080,
  expectedHeight: 1920,
  canvasCount: 1,
  markerConnected: true,
  markerInCanvas: true,
  canvas,
};
test("owning mounted canvas supports measured translated world origin, without magic offset or scaling", () => {
  const accepted = admitCopyCanvas(input);
  assert.deepEqual(relativeCopyBox(accepted, { x: 24, y: 43, width: 100, height: 50 }), {
    x: 10,
    y: 20,
    width: 100,
    height: 50,
  });
  assert.deepEqual(input.canvas, canvas);
  const moved = { ...canvas, x: -120, y: -300 };
  assert.deepEqual(
    relativeCopyBox(admitCopyCanvas({ ...input, canvas: moved }), { x: -110, y: -280, width: 100, height: 50 }),
    { x: 10, y: 20, width: 100, height: 50 },
  );
});
test("missing ambiguous disconnected preportal ownership and wrong canvas dimensions refuse", () => {
  for (const mutation of [
    { canvasCount: 0 },
    { canvasCount: 2 },
    { markerConnected: false },
    { markerInCanvas: false },
    { expectedWidth: NaN },
    { expectedHeight: 0 },
    { canvas: { ...canvas, width: 540, height: 960 } },
    { canvas: { ...canvas, width: 1920, height: 1080 } },
  ])
    assert.throws(() => admitCopyCanvas({ ...input, ...mutation }));
});
test("nonfinite zero boxes and each overflowing edge fail rather than relax full-frame fit", () => {
  for (const raw of [
    { x: NaN, y: 24, width: 2, height: 2 },
    { x: 24, y: Infinity, width: 2, height: 2 },
    { x: 24, y: 24, width: 0, height: 2 },
    { x: 24, y: 24, width: 2, height: -1 },
    { x: 13, y: 24, width: 2, height: 2 },
    { x: 24, y: 22, width: 2, height: 2 },
    { x: 1093, y: 24, width: 2, height: 2 },
    { x: 24, y: 1942, width: 2, height: 2 },
  ])
    assert.throws(() => relativeCopyBox(canvas, raw));
  assert.deepEqual(relativeCopyBox(canvas, canvas), { x: 0, y: 0, width: 1080, height: 1920 });
  assert.throws(() => admitCopyCanvas({ ...input, canvas: { ...canvas, y: Infinity } }));
});

import { rendererSourcePins, entrySource } from "./helpers/review-authored-copy-proof";
import { createRequire } from "node:module";
import fs from "node:fs";
import { createHash } from "node:crypto";
test("installed renderer source pins resolve real source files and generated probe parses as JSX without execution", () => {
  const pins = rendererSourcePins();
  assert.equal(Object.keys(pins).length, 5);
  for (const [file, pin] of Object.entries(pins)) {
    assert.match(file, /portal-node\.js$|renderEntry\.js$|render-still\.js$|Browser\.js$|BrowserPage\.js$/);
    assert.equal(createHash("sha256").update(fs.readFileSync(file)).digest("hex"), pin);
  }
  const require = createRequire(import.meta.url),
    esbuild = createRequire(require.resolve("@remotion/bundler"))("esbuild");
  assert.doesNotThrow(() =>
    esbuild.transformSync(
      entrySource(process.cwd(), {
        version: 1,
        faces: [
          {
            family: "Arial",
            weight: 400,
            style: "normal",
            original: "test/font.ttf",
            hash: "a".repeat(64),
            testedText: "Exact text",
          },
        ],
        roles: { primaryFont: "Arial" },
      }),
      { loader: "tsx" },
    ),
  );
});

test("explicit exact font registrations reject empty wrong pending and missing duplicate faces", () => {
  const expected = [{ family: "Arial", weight: 400, style: "normal" }],
    face = { family: "Arial", weight: "400", style: "normal", status: "loaded" };
  assert.equal(exactCopyFacesReady(expected, []), false);
  for (const change of [
    { family: "Other" },
    { weight: "700" },
    { style: "italic" },
    { status: "loading" },
    { status: "error" },
    { status: "unloaded" },
  ])
    assert.equal(exactCopyFacesReady(expected, [{ ...face, ...change }]), false);
  assert.equal(exactCopyFacesReady(expected, [face]), true);
  assert.equal(exactCopyFacesReady([...expected, ...expected], [face]), false);
  assert.equal(exactCopyFacesReady([...expected, ...expected], [face, { ...face }]), true);
  assert.throws(() => exactCopyFacesReady([], []));
});
test("failed fit retains actual raw canvas relative measures and stable admission is exact, not fit approval", () => {
  const raw = { x: 13, y: 24, width: 10, height: 20 },
    observation = copyBoxObservation(canvas, raw);
  assert.deepEqual(observation, { canvas, raw, relative: { x: -1, y: 1, width: 10, height: 20 } });
  assert.throws(
    () => relativeCopyBox(canvas, raw),
    (error) => error instanceof Error && error.message.includes(JSON.stringify(observation)),
  );
  assert.equal(stableCopyObservation(undefined, observation), false);
  assert.equal(stableCopyObservation(observation, structuredClone(observation)), true);
  assert.equal(stableCopyObservation(observation, { ...observation, raw: { ...raw, x: 13.000001 } }), false);
  assert.throws(() => relativeCopyBox(canvas, raw), "stable outside geometry still refuses");
});
