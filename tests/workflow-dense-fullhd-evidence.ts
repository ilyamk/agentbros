import assert from "node:assert/strict";

/** Source-frame phase changes every 60 frames; clock probes avoid exact edges. */
export const DENSE_LAYERS = [
  {
    id: "red",
    color: "0xe02020",
    darkColor: "0x701010",
    channel: 0,
    trim: 17,
    rate: { num: 1, den: 2 },
    width: 1920,
    height: 1080,
    scale: 0.2,
    x: -550,
    y: -280,
    sentinel: 940,
  },
  {
    id: "green",
    color: "0x20e020",
    darkColor: "0x107010",
    channel: 1,
    trim: 43,
    rate: { num: 1, den: 1 },
    width: 1280,
    height: 720,
    scale: 0.23,
    x: 0,
    y: -300,
    sentinel: 1020,
  },
  {
    id: "blue",
    color: "0x2020e0",
    darkColor: "0x101070",
    channel: 2,
    trim: 71,
    rate: { num: 3, den: 2 },
    width: 960,
    height: 540,
    scale: 0.26,
    x: 550,
    y: -260,
    sentinel: 1100,
  },
] as const;
export type DensePixel = { frame: number; layer: string; rgb: number[]; sourceFrame: number; dark: boolean };
export function assertDensePixel(pixel: DensePixel) {
  const layer = DENSE_LAYERS.find((l) => l.id === pixel.layer);
  assert.ok(layer, "Known independent decoder layer required");
  const sourceFrame = layer.trim + (pixel.frame * layer.rate.num) / layer.rate.den;
  assert.equal(pixel.sourceFrame, sourceFrame);
  const dark = Math.floor(sourceFrame / 60) % 2 === 0;
  assert.equal(pixel.dark, dark);
  assert.equal(pixel.rgb.length, 3);
  const dominant = pixel.rgb[layer.channel];
  assert.ok(
    dominant > Math.max(...pixel.rgb.filter((_, i) => i !== layer.channel)) + 50,
    `Visible ${layer.id} layer missing/occluded at frame ${pixel.frame}: ${pixel.rgb}`,
  );
  assert.ok(
    dark ? dominant > 75 && dominant < 145 : dominant > 185,
    `Source clock ${layer.id} wrong at output ${pixel.frame}, source ${sourceFrame}: ${pixel.rgb}`,
  );
}
/** Meaningful probes cannot sit on a codec/half-frame phase edge. */
export function denseProbeFrames(durationFrames: number, chapterFrames: number) {
  const candidates = [
    15,
    47,
    chapterFrames - 15,
    chapterFrames + 15,
    2 * chapterFrames - 15,
    2 * chapterFrames + 15,
    durationFrames - 15,
    durationFrames - 1,
  ];
  return [...new Set(candidates)].map((candidate) => {
    for (let delta = 0; delta < 10; delta++) {
      const frame = Math.max(0, candidate - delta);
      if (
        DENSE_LAYERS.every((layer) => {
          const phase = (layer.trim + (frame * layer.rate.num) / layer.rate.den) % 60;
          return phase > 4 && phase < 56;
        })
      )
        return frame;
    }
    throw new Error("No stable independently timed source clock probe nearby");
  });
}
