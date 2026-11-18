import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement as h, type FC } from "react";
import { renderToString } from "react-dom/server";
import { useCurrentFrame } from "remotion";
import { averageLayerOpacity, Shutter, shutterSampleFrame } from "../src/motion/fx";

type ThumbnailProps = {
  component: FC;
  compositionWidth: number;
  compositionHeight: number;
  frameToDisplay: number;
  durationInFrames: number;
  fps: number;
};
const require = createRequire(import.meta.url);
const { Thumbnail } = createRequire(require.resolve("@remotion/cli/package.json"))("@remotion/player") as {
  Thumbnail: FC<ThumbnailProps>;
};

const at = (component: FC, frame: number) =>
  renderToString(
    h(Thumbnail, {
      component,
      compositionWidth: 100,
      compositionHeight: 100,
      frameToDisplay: frame,
      durationInFrames: 60,
      fps: 30,
    }),
  );

/** Source-over of one premultiplied channel and its alpha. */
const over = (below: { c: number; a: number }, value: number, alpha: number, opacity: number) => ({
  c: value * alpha * opacity + below.c * (1 - alpha * opacity),
  a: alpha * opacity + below.a * (1 - alpha * opacity),
});

test("stacking opaque samples at 1/k opacity gives their exact mean and stays opaque", () => {
  const samples = [0xe9, 0xe9, 0x11, 0x11, 0x11, 0xe9, 0x40, 0xe9];
  const result = samples.reduce((below, value, index) => over(below, value, 1, averageLayerOpacity(index)), {
    c: 0,
    a: 0,
  });
  assert.equal(result.a, 1);
  assert.ok(Math.abs(result.c - samples.reduce((sum, v) => sum + v, 0) / samples.length) < 1e-9);
  const flat = Array.from({ length: 20 }, (_, index) => index).reduce(
    (below, index) => over(below, 0xe9, 1, averageLayerOpacity(index)),
    { c: 0, a: 0 },
  );
  assert.ok(Math.abs(flat.c - 0xe9) < 1e-9);
});

test("sample frames span the shutter like @remotion/motion-blur", () => {
  assert.equal(shutterSampleFrame(10, 7, 8, 180), 10.5);
  assert.equal(shutterSampleFrame(10, 0, 8, 360), 10.875);
});

const frameText: FC = () => h("i", null, `f${useCurrentFrame()}`);

test("a Shutter with a ground averages under that ground; without one it adds", () => {
  const withGround = at(
    () => h(Shutter, { ...{ windows: [[0, 30]], samples: 4, ground: "#E94D1C" }, children: h(frameText) }),
    10,
  );
  assert.doesNotMatch(withGround, /plus-lighter/);
  assert.equal((withGround.match(/background-color:#E94D1C/gi) ?? []).length, 4);
  for (const opacity of ["opacity:1;", "opacity:0.5", "opacity:0.333", "opacity:0.25"])
    assert.match(withGround, new RegExp(opacity));
  assert.match(withGround, /f10\.875/);
  assert.match(withGround, /f10\.5/);

  const opaque = at(
    () => h(Shutter, { ...{ windows: [[0, 30]], samples: 4, opaque: true }, children: h(frameText) }),
    10,
  );
  assert.doesNotMatch(opaque, /plus-lighter/);

  const additive = at(() => h(Shutter, { ...{ windows: [[0, 30]], samples: 4 }, children: h(frameText) }), 10);
  assert.match(additive, /plus-lighter/);

  const outside = at(() => h(Shutter, { ...{ windows: [[0, 5]], ground: "#E94D1C" }, children: h(frameText) }), 10);
  assert.equal((outside.match(/background-color:#E94D1C/gi) ?? []).length, 1);
  assert.match(outside, /f10</);
});
