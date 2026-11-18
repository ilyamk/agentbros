import assert from "node:assert/strict";
import test from "node:test";
import { planEdit } from "../src/lib/audio-map/edit-plan";
import { CueDraftSchema, snapCues } from "../src/lib/audio-map/snap";
import { checkStructure } from "../src/lib/film/plan-check";
import { AudioMapSchema, type AudioMap } from "../src/types/film";
import type { MotionPlan } from "../src/types/creative";

// 120 BPM, 2 s bars, 32 s: intro 0-8, build 8-16 with a fill into 16, drop 16-24, break 24-26, drop 26-30, hard stop at 30.
function structuredMap(): AudioMap {
  const beats = Array.from({ length: 62 }, (_, index) => index * 0.5);
  const downbeats = beats.filter((_, index) => index % 4 === 0);
  const span = (startSec: number, endSec: number) => ({ startSec, endSec });
  const section = (
    startSec: number,
    endSec: number,
    label: "intro" | "build" | "drop" | "break" | "outro",
    energy: number,
  ) => ({
    ...span(startSec, endSec),
    label,
    energy,
    density: 4,
    drums: 0.6,
    bass: 0.6,
    confidence: 0.8,
    reason: "fixture",
  });
  return AudioMapSchema.parse({
    schemaVersion: 1,
    source: { path: "track.wav", sha256: "b".repeat(64), durationSec: 32 },
    tempo: { bpm: 120, confidence: 0.9, gridTrust: "reliable" },
    beatsSec: beats,
    downbeatsSec: downbeats,
    phrases: [],
    sections: [],
    events: [],
    keyMoments: [
      { timeSec: 16, kind: "surge", strength: 0.9 },
      { timeSec: 30, kind: "hard-stop", strength: 0.9 },
    ],
    silences: [],
    risers: [],
    energyCurve: [{ timeSec: 0, rms: 0, low: 0, high: 0 }],
    structure: {
      source: "mix",
      barSec: 2,
      bars: downbeats.map((startSec) => ({
        ...span(startSec, startSec + 2),
        energy: 0.5,
        density: 4,
        drums: 0.6,
        bass: 0.6,
        novelty: 0.2,
      })),
      phrases: [
        { ...span(0, 8), bars: 4, level: 16, confidence: 1 },
        { ...span(8, 16), startBar: 4, bars: 4, level: 4, confidence: 0.6 },
        { ...span(16, 24), startBar: 8, bars: 4, level: 8, confidence: 0.9 },
        { ...span(24, 26), startBar: 12, bars: 1, level: 0, confidence: 0.7 },
        { ...span(26, 30), startBar: 13, bars: 2, level: 0, confidence: 0.7 },
      ],
      sections: [
        section(0, 8, "intro", 0.2),
        section(8, 16, "build", 0.5),
        section(16, 24, "drop", 0.9),
        section(24, 26, "break", 0.3),
        section(26, 30, "drop", 0.9),
      ],
      fills: [{ ...span(15, 16), boundarySec: 16, strength: 0.8 }],
      risers: [{ ...span(12, 16), boundarySec: 16, strength: 0.7, rises: ["centroid"] }],
      breaks: [{ ...span(24, 26), kind: "drum-dropout", strength: 0.8 }],
      ending: { kind: "hard-stop", lastSoundSec: 30.2, fadeSec: 0, finalDownbeatSec: 30 },
    },
  });
}

test("edit:plan puts shots on phrase starts with the cut lead, a hero hit on the drop, a hold on the break and a stop on the final downbeat", () => {
  const plan = planEdit({ map: structuredMap(), fps: 30, style: "punchy", audioMapPath: "map.json" });
  assert.equal(plan.durationFrames, 900, "the film ends on the final downbeat");
  const starts = plan.slots.map((slot) => slot.startFrame);
  assert.ok(starts.includes(239), "the 8-bar line at 8 s starts a shot one frame early");
  assert.ok(starts.includes(479), "the drop at 16 s starts a shot one frame early");
  const drop = plan.slots.find((slot) => slot.startFrame === 479)!;
  assert.deepEqual(drop.sfx, ["impact"]);
  assert.ok(drop.blockCategories.includes("three") || drop.blockCategories.includes("scenes"));
  assert.ok(plan.events.some((event) => event.kind === "ground-swap" && event.frame === 480));
  const hold = plan.slots.find((slot) => slot.role === "hold")!;
  assert.equal(hold.startFrame, 719);
  assert.ok(!starts.some((frame) => frame > 721 && frame < 779), "no cut inside the break");
  assert.ok(
    plan.slots.filter((slot) => slot.role === "flurry").length >= 1,
    "the fill before the drop becomes a flurry",
  );
  assert.ok(
    plan.events.some((event) => event.kind === "sfx" && event.sfx === "riser" && event.endFrame === 480),
    "the riser ends on the drop",
  );
  const stop = plan.cues.find((cue) => cue.kind === "stop")!;
  assert.equal(stop.intentSec, 30);
  for (const cue of plan.cues) CueDraftSchema.parse(cue);
  const { unanchored } = snapCues({
    drafts: plan.cues,
    map: structuredMap(),
    fps: 30,
    musicOffsetSec: 0,
    audioMapPath: "map.json",
  });
  assert.deepEqual(unanchored, [], "every cue but the riser start (snap none) lands on an anchor");
});

test("edit:plan never makes a hero hit of a drop in the last second before the stop", () => {
  const known = structuredMap();
  const map = AudioMapSchema.parse({
    ...known,
    keyMoments: [...known.keyMoments, { timeSec: 29.72, kind: "drop", strength: 1 }],
  });
  const plan = planEdit({ map, fps: 30, style: "punchy", audioMapPath: "map.json" });
  assert.ok(
    !plan.events.some((event) => event.kind === "ground-swap" && event.trackSec > 29),
    JSON.stringify(plan.events.filter((event) => event.trackSec > 29)),
  );
});

test("edit:plan styles: calm cuts on phrase lines only; punchy and flurry cut on beats inside them", () => {
  const calm = planEdit({ map: structuredMap(), fps: 30, style: "calm", audioMapPath: "map.json" });
  const flurry = planEdit({ map: structuredMap(), fps: 30, style: "flurry", audioMapPath: "map.json" });
  assert.ok(calm.slots.length < flurry.slots.length);
  assert.equal(calm.slots.filter((slot) => slot.role === "flurry").length, 0);
  assert.ok(!calm.cues.some((cue) => cue.snap === "beat"), "calm never cuts on a bare beat");
  const punchy = planEdit({ map: structuredMap(), fps: 30, style: "punchy", audioMapPath: "map.json" });
  assert.ok(
    punchy.cues.some((cue) => cue.snap === "beat"),
    "punchy cuts on beats inside phrases",
  );
  assert.ok(
    !punchy.slots.some((slot) => slot.entry.startsWith("phrase")),
    "punchy uses phrase lines only through sections, drops and the stop",
  );
  const lengths = punchy.slots.filter((slot) => slot.role === "shot").map((slot) => slot.durationFrames);
  assert.ok(new Set(lengths).size >= 3, "uneven shot lengths");
});

test("a guessed bar line (barKnown false): edit:plan marks no cut as a downbeat, plan:check asks only for beats", () => {
  const known = structuredMap();
  const map = AudioMapSchema.parse({ ...known, structure: { ...known.structure!, barKnown: false } });
  const plan = planEdit({ map, fps: 30, style: "punchy", audioMapPath: "map.json" });
  assert.equal(plan.barKnown, false);
  assert.ok(!plan.cues.some((cue) => cue.snap === "downbeat"));
  assert.ok(!plan.slots.some((slot) => slot.entry === "downbeat"));
  assert.equal(planEdit({ map: known, fps: 30, style: "punchy", audioMapPath: "map.json" }).barKnown, true);
  const shot = (id: string, startFrame: number, durationFrames: number) => ({
    id,
    startFrame,
    durationFrames,
    intent: "x",
    subject: "x",
    framing: "x",
    camera: "x",
    composition: "x",
    entrance: "x",
    exit: "x",
    curve: "x",
    route: "remotion" as const,
    techniqueIds: [],
  });
  // 9.5 s is a beat but not a downbeat: fine when the bar is unknown, flagged when it is known.
  const plan2 = {
    schemaVersion: 1 as const,
    projectId: "p",
    fps: 30,
    shots: [shot("a", 0, 285), shot("b", 285, 615)],
    onScreenCopy: [],
    finalFrameIntent: "hold" as const,
  } as MotionPlan;
  assert.equal(checkStructure(plan2, map)[0]!.status, "pass");
  assert.equal(checkStructure(plan2, known)[0]!.status, "warn");
  assert.match(checkStructure(plan2, known)[0]!.message, /or downbeat/);
});

test("plan:check's structure leg flags a cut off the form and an ending off the stop, without scoring", () => {
  const shot = (id: string, startFrame: number, durationFrames: number) => ({
    id,
    startFrame,
    durationFrames,
    intent: "x",
    subject: "x",
    framing: "x",
    camera: "x",
    composition: "x",
    entrance: "x",
    exit: "x",
    curve: "x",
    route: "remotion" as const,
    techniqueIds: [],
  });
  const plan = {
    schemaVersion: 1 as const,
    projectId: "p",
    fps: 30,
    shots: [shot("a", 0, 239), shot("b", 239, 100), shot("c", 339, 500)],
    onScreenCopy: [],
    finalFrameIntent: "hold" as const,
  } as MotionPlan;
  const [cuts, ending] = checkStructure(plan, structuredMap());
  assert.equal(cuts!.status, "warn");
  assert.deepEqual(cuts!.shotIds, ["c"], "b sits on the phrase at 8 s with its lead; c at 11.3 s sits on nothing");
  assert.equal(ending!.status, "warn");
  assert.equal(cuts!.score + ending!.score, 0);
  const good = { ...plan, shots: [shot("a", 0, 479), shot("b", 479, 421)] } as MotionPlan;
  assert.deepEqual(
    checkStructure(good, structuredMap()).map((finding) => finding.status),
    ["pass", "pass"],
  );
});
