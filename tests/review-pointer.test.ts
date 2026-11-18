import test from "node:test";
import assert from "node:assert/strict";
import { pointerProposal } from "../src/lib/review-ui/pointer";
import { compileTimelineIR, validateTimeline } from "../src/lib/timeline-ir/compiler";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import type { TimelineIR } from "../src/types/timeline";

function fixture(sourceFps = { num: 30, den: 1 }, masterFps = { num: 30, den: 1 }, rate = { num: 1, den: 1 }) {
  const timeline = validateTimeline({
    version: 1,
    projectId: "demo",
    timebase: masterFps,
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [
          {
            id: "shot",
            assetId: "asset",
            start: { num: 30, den: 1 },
            source: { start: { num: 0, den: 1 }, end: { num: 120, den: 1 }, timebase: sourceFps },
            rate,
          },
        ],
      },
    ],
  });
  const compiled = compileTimelineIR(timeline);
  return {
    timeline,
    input: {
      mode: "move" as "move" | "start" | "end",
      deltaPx: 100,
      laneWidth: 600,
      durationInFrames: 300,
      timebase: masterFps,
      trackId: "visual",
      clip: compiled.tracks[0].clips[0],
    },
  };
}
function clip(timeline: TimelineIR) {
  return compileTimelineIR(timeline).tracks[0].clips[0];
}
test("pointer move clamps to track neighbors and existing viewport without changing originals", () => {
  const f = fixture();
  const before = structuredClone(f.timeline);
  const command = pointerProposal({ ...f.input, nextStart: { num: 170, den: 1 } });
  assert.deepEqual(command, { type: "move", trackId: "visual", clipId: "shot", start: { num: 50, den: 1 } });
  const after = applyEdit(f.timeline, command);
  assert.deepEqual(after.tracks[0].clips[0].source, before.tracks[0].clips[0].source);
  assert.deepEqual(f.timeline, before);
  assert.deepEqual(pointerProposal({ ...f.input, deltaPx: -999 }), {
    type: "move",
    trackId: "visual",
    clipId: "shot",
    start: { num: 0, den: 1 },
  });
});
test("left edge uses reversible batch source trim and move keeping right edge fixed", () => {
  const f = fixture();
  const after = applyEdit(f.timeline, pointerProposal({ ...f.input, mode: "start", deltaPx: 20 }));
  assert.equal(after.tracks[0].clips[0].source.start.num, 10);
  assert.equal(clip(after).start.num, 40);
  assert.deepEqual(clip(after).end, f.input.clip.end);
});
test("right edge only trims inward and clamps at one source frame", () => {
  const f = fixture();
  const after = applyEdit(f.timeline, pointerProposal({ ...f.input, mode: "end", deltaPx: -999 }));
  assert.equal(after.tracks[0].clips[0].source.end.num, 1);
  assert.equal(clip(after).start.num, 30);
  assert.throws(() => pointerProposal({ ...f.input, mode: "end", deltaPx: 40 }), /no change/);
});
test("exact 30000\/1001 source, 30 master and playback rate map without approximate clocks", () => {
  const f = fixture({ num: 30000, den: 1001 }, { num: 30, den: 1 }, { num: 2, den: 1 });
  const command = pointerProposal({ ...f.input, mode: "start", deltaPx: 60 });
  const after = applyEdit(f.timeline, command);
  assert.deepEqual(after.tracks[0].clips[0].source.start, { num: 60, den: 1 });
  assert.deepEqual(clip(after).start, { num: 6003, den: 100 });
  assert.deepEqual(clip(after).end, f.input.clip.end);
});
test("rational master and VFR normalized frame-map inputs retain supplied coordinate semantics", () => {
  const f = fixture({ num: 30, den: 1 }, { num: 30000, den: 1001 });
  f.timeline.tracks[0].clips[0].payload = {
    recordingFrameMapHash: "supplied-evidence",
    sourceTiming: "vfr-normalized",
  };
  const after = applyEdit(f.timeline, pointerProposal({ ...f.input, mode: "start", deltaPx: 60 }));
  assert.deepEqual(after.tracks[0].clips[0].source.start, { num: 30, den: 1 });
  assert.deepEqual(clip(after).start, { num: 60030, den: 1001 });
  assert.deepEqual(clip(after).end, f.input.clip.end);
  assert.deepEqual(after.tracks[0].clips[0].payload, f.timeline.tracks[0].clips[0].payload);
});
test("pointer rejects invalid geometry, unsafe clocks and no-op instead of proposing writes", () => {
  const f = fixture();
  for (const geometry of [{ laneWidth: 0 }, { laneWidth: NaN }, { deltaPx: Infinity }, { durationInFrames: -1 }])
    assert.throws(() => pointerProposal({ ...f.input, ...geometry }), /geometry/);
  assert.throws(() => pointerProposal({ ...f.input, deltaPx: 0 }), /no change/);
  assert.throws(() => pointerProposal({ ...f.input, timebase: { num: 30, den: 0 } }), /clock/);
  assert.throws(() => pointerProposal({ ...f.input, previousEnd: { num: 290, den: 1 } }), /legal pointer interval/);
});
