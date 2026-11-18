import { validateTimeline } from "../../src/lib/timeline-ir/compiler";
export const r = (num: number, den = 1) => ({ num, den });
export function transferFixture() {
  const clip = {
    id: "shot",
    assetId: "original-video",
    start: r(30),
    source: { start: r(17), end: r(137), timebase: r(24) },
    rate: r(3, 2),
    transition: { kind: "cut" },
    captions: [{ id: "w", text: "Original meaning", start: r(20), end: r(25) }],
    payload: { transform: { x: 31 }, sourceTiming: "vfr-normalized", recordingFrameMapHash: "retained" },
  };
  return validateTimeline({
    version: 1,
    projectId: "demo",
    timebase: r(30000, 1001),
    tracks: [
      { id: "visual", kind: "visual", clips: [clip] },
      { id: "overlay", kind: "visual", clips: [] },
      ...["presenter", "voiceover", "music", "sfx", "captions"].map((kind) => ({
        id: kind,
        kind,
        clips: [{ ...clip, id: kind, source: { start: r(0), end: r(360), timebase: r(30) }, captions: [] }],
      })),
    ],
  });
}
