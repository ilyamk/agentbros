import test from "node:test";
import assert from "node:assert/strict";
import { assertDensePixel, denseProbeFrames, DENSE_LAYERS } from "./workflow-dense-fullhd-evidence";

test("dense output probes reject hidden layers, wrong clocks and ambiguous phase boundaries", () => {
  for (const duration of [900, 5400]) {
    const frames = denseProbeFrames(duration, duration / 3);
    assert.ok(frames.some((f) => f > duration - 25));
    for (const frame of frames)
      for (const layer of DENSE_LAYERS) {
        const sourceFrame = layer.trim + (frame * layer.rate.num) / layer.rate.den;
        const dark = Math.floor(sourceFrame / 60) % 2 === 0;
        const rgb = [16, 16, 16];
        rgb[layer.channel] = dark ? 110 : 220;
        const pixel = { frame, layer: layer.id, rgb, sourceFrame, dark };
        assertDensePixel(pixel);
        assert.throws(() => assertDensePixel({ ...pixel, rgb: [0, 0, 0] }), /missing\/occluded/);
        assert.throws(() => assertDensePixel({ ...pixel, rgb: [220, 220, 220] }), /missing\/occluded/);
        assert.throws(() => assertDensePixel({ ...pixel, sourceFrame: sourceFrame + 1 }));
        const inverse = [...rgb];
        inverse[layer.channel] = dark ? 220 : 110;
        assert.throws(() => assertDensePixel({ ...pixel, rgb: inverse }), /Source clock/);
      }
  }
});
