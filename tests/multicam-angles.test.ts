import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityFromAsd,
  activityFromEnergy,
  activityFromTranscript,
  angleTrackCommand,
  DEFAULT_RULES,
  proposeAngles,
  toReference,
  toSource,
} from "../src/lib/multicam/angles";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { numeric } from "../src/lib/timeline-ir/rational";
import {
  AnglePlanSchema,
  MulticamSyncSchema,
  type AngleMap,
  type MulticamSource,
  type MulticamSync,
} from "../src/types/multicam";
import type { Transcript } from "../src/types/transcript";

const hash = (n: number) => String(n).repeat(64).slice(0, 64);
const source = (
  id: string,
  offsetSec: number,
  durationSec: number,
  video: boolean,
  ppm: number | null = null,
): MulticamSource => ({
  id,
  file: `${id}.mov`,
  sha256: hash(id.length),
  durationSec,
  video: video ? { fps: { num: 30, den: 1 }, width: 1920, height: 1080 } : null,
  offsetSec,
  videoOffsetSec: video ? offsetSec : null,
  overlap: { startSec: Math.max(0, offsetSec), endSec: 60 },
  coarse: null,
  refine: null,
  drift: { measured: ppm !== null, ppm, accumulatedMs: null, needsResample: false },
  confidence: id === "wide" ? "reference" : "high",
});
const sync: MulticamSync = MulticamSyncSchema.parse({
  version: 1,
  referenceId: "wide",
  sampleRate: 48000,
  thresholds: { minStandardScore: 10, minPeakRatio: 3, searchMs: 20, driftToleranceMs: 16 },
  sources: [
    source("wide", 0, 60, true),
    source("camA", -2, 70, true),
    source("camB", 5, 60, true, 50),
    source("micA", 0, 60, false),
    source("micB", 1, 60, false),
  ],
  tools: {},
});
const byId = (id: string) => sync.sources.find((item) => item.id === id)!;
const map: AngleMap = {
  version: 1,
  speakers: [
    { speaker: "A", angle: "camA", mic: "micA", position: 0.3 },
    { speaker: "B", angle: "camB", mic: "micB", position: 0.7 },
  ],
  wide: "wide",
};
const syncFile = { file: "sync.json", sha256: hash(9) };
const fps = { num: 30, den: 1 };

/** Levels in each mic's own time: speaker's mic -20 dB while talking, bleed -32 dB, floor -70 dB. */
function levels(talk: [number, number, string][], mic: string, offset: number): number[] {
  return Array.from({ length: 600 }, (_, hop) => {
    const t = hop * 0.1 + 0.05 + offset;
    const active = talk.filter(([s, e]) => t >= s && t < e).map(([, , who]) => who);
    return active.includes(mic) ? -20 : active.length ? -32 : -70;
  });
}

const talk: [number, number, string][] = [
  [0, 10, "A"],
  [10, 10.8, "B"],
  [10.8, 20, "A"],
  [20, 30, "B"],
  [30, 33, "A"],
  [30, 33, "B"],
  [33, 40, "A"],
  [40, 40.5, "B"],
  [40, 50, "A"],
];

const energyActivity = () =>
  activityFromEnergy(
    [
      { speaker: "A", source: byId("micA"), levels: levels(talk, "A", 0), hopSec: 0.1 },
      { speaker: "B", source: byId("micB"), levels: levels(talk, "B", 1), hopSec: 0.1 },
    ],
    60,
    DEFAULT_RULES,
  );

test("reference/source conversions invert each other with drift", () => {
  const camB = byId("camB");
  for (const t of [5, 20, 59]) assert.ok(Math.abs(toReference(camB, toSource(camB, t)) - t) < 1e-6);
});

test("mic energy: dominant mic wins, bleed does not, both loud is overlap", () => {
  const activity = energyActivity();
  assert.deepEqual(activity.hops[50], ["A"]);
  assert.deepEqual(activity.hops[250], ["B"]);
  assert.deepEqual(activity.hops[315], ["A", "B"]);
  assert.deepEqual(activity.hops[555], []);
});

test("angle rules: minimum shot, long overlap wide, short overlap hold, silence hold, picture fallback", () => {
  const plan = AnglePlanSchema.parse(
    proposeAngles({ sync, syncFile, map, activity: energyActivity(), method: "mic-energy", fps }),
  );
  const seconds = plan.segments.map((segment) => ({
    ...segment,
    start: segment.startFrame / 30,
    end: segment.endFrame / 30,
  }));
  for (const segment of seconds) assert.ok(segment.end - segment.start >= 1.5 - 1e-9, JSON.stringify(segment));
  for (let i = 1; i < seconds.length; i++) assert.equal(seconds[i]!.start, seconds[i - 1]!.end);
  assert.equal(seconds[0]!.start, 0);
  assert.equal(seconds.at(-1)!.end, 60);
  const at = (t: number) => seconds.find((segment) => t >= segment.start && t < segment.end)!;
  assert.equal(at(5).angle, "camA");
  assert.equal(at(10.4).angle, "camA", "0.8 s of B is absorbed by the A shot");
  assert.equal(at(25).angle, "camB");
  assert.equal(at(31).angle, "wide");
  assert.equal(at(31).reason, "overlap-wide");
  assert.equal(at(40.2).angle, "camA", "short overlap/interjection holds");
  assert.equal(at(55).angle, "camA");
  assert.equal(at(55), at(45), "silence after A holds the A shot");
});

test("camera without picture falls back to the wide shot", () => {
  const late = MulticamSyncSchema.parse({
    ...sync,
    sources: sync.sources.map((item) => (item.id === "camB" ? { ...item, offsetSec: 25, videoOffsetSec: 25 } : item)),
  });
  const plan = proposeAngles({ sync: late, syncFile, map, activity: energyActivity(), method: "mic-energy", fps });
  const b = plan.segments.find((segment) => segment.startFrame <= 22 * 30 && segment.endFrame > 22 * 30)!;
  assert.equal(b.angle, "wide");
  assert.equal(b.reason, "fallback-wide");
  assert.ok(plan.notes.some((note) => note.includes("camB has no picture")));
});

test("without evidence the proposal is one wide shot", () => {
  const plan = proposeAngles({ sync, syncFile, map: null, activity: null, method: "wide-only", fps });
  assert.deepEqual(
    plan.segments.map((segment) => [segment.startFrame, segment.endFrame, segment.angle]),
    [[0, 1800, "wide"]],
  );
});

test("cuts snap to nearby sentence starts", () => {
  const plan = proposeAngles({
    sync,
    syncFile,
    map,
    activity: energyActivity(),
    method: "mic-energy",
    fps,
    sentenceStartsSec: [19.6, 45],
  });
  assert.ok(plan.segments.some((segment) => segment.startFrame === Math.round(19.6 * 30) && segment.angle === "camB"));
});

test("diarised transcript drives activity in reference time", () => {
  const word = (i: number, speaker: string, startSec: number) => ({
    id: `w${i}`,
    text: "x",
    kind: "word" as const,
    startSec,
    endSec: startSec + 0.3,
    speaker,
    channel: null,
    confidence: null,
  });
  const transcript = {
    words: [word(1, "A", 1), word(2, "A", 1.4), word(3, "B", 6), word(4, "B", 6.4)],
  } as unknown as Transcript;
  const activity = activityFromTranscript(transcript, byId("micB"), 60, DEFAULT_RULES);
  assert.deepEqual(activity.hops[22], ["A"]);
  assert.deepEqual(activity.hops[72], ["B"]);
  assert.deepEqual(activity.hops[40], []);
});

test("visual ASD maps faces to speakers by position and keeps a focus point", () => {
  const scores = (from: number, to: number) =>
    Array.from({ length: 600 }, (_, hop) => (hop >= from && hop < to ? 2 : -2));
  const asd = {
    version: 1 as const,
    model: "light-asd",
    source: "wide",
    hopSec: 0.1,
    faces: [
      { id: "f1", x: 0.28, y: 0.4, scores: scores(0, 100) },
      { id: "f2", x: 0.72, y: 0.45, scores: scores(100, 200) },
    ],
  };
  const activity = activityFromAsd(asd, byId("wide"), map, 60, DEFAULT_RULES);
  assert.deepEqual(activity.hops[50], ["A"]);
  assert.deepEqual(activity.focus![150], { x: 0.72, y: 0.45 });
  const plan = proposeAngles({ sync, syncFile, map, activity, method: "visual-asd", fps });
  assert.equal(plan.segments[1]!.angle, "camB");
  assert.deepEqual(plan.segments[1]!.focus, { x: 0.72, y: 0.45 });
});

test("angle proposal becomes one visual track the timeline accepts, sources offset per camera", () => {
  const plan = proposeAngles({ sync, syncFile, map, activity: energyActivity(), method: "mic-energy", fps });
  assert.throws(
    () => angleTrackCommand(plan, sync, { trackId: "multicam", timebase: fps, soundTrackId: "programme" }),
    /audio assets only/,
  );
  const command = angleTrackCommand(plan, sync, {
    trackId: "multicam",
    timebase: fps,
    soundTrackId: "programme",
    assetIds: { wide: "sha256:" + hash(7) },
  });
  const ir = applyEdit({ version: 1, projectId: "multicam-test", timebase: fps, tracks: [] }, command);
  const compiled = compileTimelineIR(ir);
  const track = compiled.tracks.find((item) => item.id === "multicam")!;
  assert.equal(track.kind, "visual");
  assert.equal(track.clips.length, plan.segments.length);
  assert.equal(numeric(compiled.duration), 1800);
  for (const [index, clip] of track.clips.entries()) {
    const segment = plan.segments[index]!;
    const camera = byId(segment.angle);
    assert.equal(numeric(clip.start), segment.startFrame);
    assert.equal(numeric(clip.duration), segment.endFrame - segment.startFrame);
    const expected =
      (segment.startFrame / 30 -
        (camera.offsetSec + (camera.drift.ppm ?? 0) * 1e-6 * (segment.startFrame / 30 - camera.overlap.startSec))) *
      30;
    assert.ok(
      Math.abs(numeric(clip.source.start) - expected) < 1e-3,
      `${clip.id}: ${numeric(clip.source.start)} vs ${expected}`,
    );
  }
  assert.equal(
    track.clips.find((clip) => clip.assetId === "sha256:" + hash(7)) !== undefined,
    plan.segments.some((segment) => segment.angle === "wide"),
  );
  const sound = compiled.tracks.find((item) => item.id === "programme")!;
  assert.equal(sound.kind, "voiceover");
  assert.equal(numeric(sound.clips[0]!.duration), 1800);
  assert.throws(() => angleTrackCommand(plan, sync, { trackId: "m", timebase: { num: 25, den: 1 } }), /fps/);
});
