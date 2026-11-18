import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createElement as h, type FC } from "react";
import { renderToString } from "react-dom/server";
import { Freeze, Sequence } from "remotion";
import { AudioCurvesProvider, useAudioCurve, type AudioCurves } from "../src/motion/sync/curves";

// @remotion/player ships with the declared @remotion/cli; resolving it from there keeps one copy of React and Remotion.
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

// A "level" curve equal to frame / 1000, so the value read names the frame read.
const curves = {
  kind: "audio-curves",
  schemaVersion: 1,
  fps: 30,
  durationInFrames: 300,
  source: { map: "test.json" },
  params: {},
  grid: { beats: [], downbeats: [] },
  curves: { level: Array.from({ length: 300 }, (_, frame) => frame / 1000) },
} as unknown as AudioCurves;

const Probe: FC = () => h("b", null, Math.round(useAudioCurve(null, "level") * 1000));

function readAt(frame: number, tree: FC): number {
  const html = renderToString(
    h(Thumbnail, {
      component: tree,
      compositionWidth: 10,
      compositionHeight: 10,
      frameToDisplay: frame,
      durationInFrames: 300,
      fps: 30,
    }),
  );
  const match = /<b>(-?\d+)<\/b>/.exec(html);
  assert.ok(match, html);
  return Number(match[1]);
}

test("a provider at the film root gives a block inside <Sequence from> the film's frame", () => {
  const tree: FC = () =>
    h(AudioCurvesProvider, {
      curves,
      children: h(Sequence, { from: 30, children: h(Sequence, { from: 20, children: h(Probe) }) }),
    });
  assert.equal(readAt(100, tree), 100);
});

test("a provider inside a Sequence measures from its own start", () => {
  const tree: FC = () =>
    h(Sequence, {
      from: 40,
      children: h(AudioCurvesProvider, { curves, children: h(Sequence, { from: 10, children: h(Probe) }) }),
    });
  assert.equal(readAt(100, tree), 60);
});

test("an explicit offsetFrames overrides the automatic offset", () => {
  const tree: FC = () =>
    h(AudioCurvesProvider, { curves, offsetFrames: 5, children: h(Sequence, { from: 30, children: h(Probe) }) });
  assert.equal(readAt(100, tree), 75);
});

test("a Freeze inside a Sequence still reads the film frame at the frozen moment", () => {
  const tree: FC = () =>
    h(AudioCurvesProvider, {
      curves,
      children: h(Sequence, { from: 30, children: h(Freeze, { frame: 12, children: h(Probe) }) }),
    });
  assert.equal(readAt(100, tree), 42);
});
