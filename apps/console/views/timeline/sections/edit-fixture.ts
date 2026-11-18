/**
 * Review state used by the edit section's tests: two visual tracks, a presenter, a voiceover and a music track over a
 * 120-frame, 30 fps timeline (the shapes `ReviewService.state()` returns).
 */
import type { ReviewClip, ReviewState } from "../api";

const r = (num: number, den = 1) => ({ num, den });

export function clip(id: string, start: number, end: number, extra: Partial<ReviewClip> = {}): ReviewClip {
  return {
    id,
    assetId: `asset-${id}`,
    start: r(start),
    end: r(end),
    source: { start: r(0), end: r(end - start), timebase: r(30) },
    rate: r(1),
    transition: { kind: "cut" },
    captions: [],
    ...extra,
  };
}

export function editState(revision: number | null = 3, patch: Partial<ReviewState> = {}): ReviewState {
  return {
    projectId: "demo-film",
    revision,
    timelineHash: revision === null ? null : "a".repeat(64),
    durationInFrames: 120,
    timebase: r(30),
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [
          clip("hook", 0, 30, {
            payload: {
              scene: { template: { id: "scene.hook", props: { headline: "Ship faster", subtext: "Today" } } },
            },
          }),
          clip("proof", 60, 90, {
            captions: [{ start: r(60), end: r(75), text: "First line" }],
          }),
        ],
      },
      { id: "broll", kind: "visual", clips: [clip("cut", 30, 60)] },
      { id: "host", kind: "presenter", clips: [clip("talk", 0, 120)] },
      { id: "voice", kind: "voiceover", clips: [clip("speech", 0, 120)] },
      {
        id: "music",
        kind: "music",
        clips: [
          clip("bed", 0, 120, { source: { start: r(0), end: r(4800), timebase: r(48000) }, payload: { audioGain: 0 } }),
        ],
      },
    ],
    journal: [],
    redoCount: 0,
    assets: [
      { id: "asset-hook", kind: "image", original: "projects/demo-film/media/hook.png" },
      { id: "asset-proof", kind: "video", original: "projects/demo-film/media/proof.mp4" },
    ],
    entities: [],
    budget: { status: "uninitialized", jobs: [] },
    snapshots: [],
    selected: null,
    reports: [],
    outputs: [],
    ...patch,
  };
}
