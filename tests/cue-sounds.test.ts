import assert from "node:assert/strict";
import test from "node:test";
import { cueSoundTracks, planCueSounds, type PackSound } from "../src/lib/audio/cue-sounds";
import { readSynthPack, SHARED_SYNTH_PACK } from "../src/lib/audio/sfx-pack";
import { loadLibrary } from "../src/lib/library/load";
import { LocalAudioMixSchema } from "../src/types/audio-master";
import {
  cueDecision,
  decideFilmEvents,
  describeUndecided,
  seamCues,
  undecidedCues,
} from "../src/lib/audio/cut-decisions";
import { CueSheetSchema } from "../src/types/film";

const pack: PackSound[] = [
  { kind: "hit", file: "hit.wav", alignSec: 0, durationSec: 1.8 },
  { kind: "sub-drop", file: "sub-drop.wav", alignSec: 0, durationSec: 1.6 },
  { kind: "riser", file: "riser.wav", alignSec: 2, durationSec: 2, lengthFrames: 60 },
  { kind: "riser", file: "riser-30f30.wav", alignSec: 1, durationSec: 1, lengthFrames: 30 },
  { kind: "whoosh", file: "whoosh.wav", alignSec: 0.4, durationSec: 0.7 },
  { kind: "tick", file: "tick.wav", alignSec: 0, durationSec: 0.05 },
];
const options = { fps: 30, durationInFrames: 900, pack };

test("sound lands on the picture frame: transient on the cue, whoosh peak on the cue, riser end on the cue", () => {
  const { events } = planCueSounds(
    [
      {
        blockId: "a",
        startFrame: 100,
        cues: [
          { frame: 0, kind: "land", sfx: "impact", weight: "hero" },
          { frame: 20, kind: "peak", sfx: "whoosh" },
          { frame: 200, kind: "hit", sfx: "riser", weight: "hero" },
        ],
      },
    ],
    options,
  );
  const by = Object.fromEntries(events.map((event) => [event.sfx, event]));
  assert.equal(by.hit!.startFrame, 100);
  assert.equal(by.hit!.gain, 0.3);
  assert.equal(by.whoosh!.startFrame, 120 - 12);
  assert.equal(by.whoosh!.gain, 0.14);
  assert.equal(by.riser!.startFrame, 240, "the longest riser that fits ends on frame 300");
  assert.equal(by.riser!.file, "shared/sfx/synth/riser.wav");
});

test("a riser too early for the long take uses the short one, or is dropped with the fix", () => {
  const short = planCueSounds(
    [{ blockId: "a", startFrame: 0, cues: [{ frame: 40, kind: "hit", sfx: "riser", weight: "hero" }] }],
    options,
  );
  assert.equal(short.events[0]!.file, "shared/sfx/synth/riser-30f30.wav");
  const none = planCueSounds(
    [{ blockId: "a", startFrame: 0, cues: [{ frame: 10, kind: "hit", sfx: "riser", weight: "hero" }] }],
    options,
  );
  assert.equal(none.events.length, 0);
  assert.match(none.dropped[0]!.reason, /--length-frames 10/);
  assert.match(none.dropped[0]!.reason, /--project <id>/, "no project given: a placeholder");
  const named = planCueSounds(
    [{ blockId: "a", startFrame: 0, cues: [{ frame: 10, kind: "hit", sfx: "riser", weight: "hero" }] }],
    { ...options, project: "demo-film" },
  );
  assert.match(named.dropped[0]!.reason, /sfx:synth --project demo-film --kind riser --length-frames 10/);
});

test("a whoosh on frame 0 (giant-word-pull-out's reveal) is dropped for its pre-roll, with a hint to shift it, never a riser of 0 frames", () => {
  const { events, dropped } = planCueSounds(
    [
      {
        blockId: "giant-word-pull-out",
        startFrame: 0,
        cues: [{ frame: 0, kind: "reveal", sfx: "whoosh", weight: "hero" }],
      },
    ],
    { ...options, project: "demo-film" },
  );
  assert.equal(events.length, 0);
  const reason = dropped[0]!.reason;
  assert.match(reason, /a whoosh needs 12 frame\(s\) before its peak and the cue is on frame 0/);
  assert.match(reason, /shift the cue \(or the block's start\) to frame 12 or later/);
  assert.doesNotMatch(reason, /riser|length-frames/);
  const early = planCueSounds(
    [{ blockId: "a", startFrame: 0, cues: [{ frame: 1, kind: "hit", sfx: "riser", weight: "hero" }] }],
    options,
  );
  assert.doesNotMatch(early.dropped[0]!.reason, /length-frames/, "sfx:synth makes no riser shorter than 2 frames");
  assert.equal(
    planCueSounds(
      [
        {
          blockId: "giant-word-pull-out",
          startFrame: 12,
          cues: [{ frame: 0, kind: "reveal", sfx: "whoosh", weight: "hero" }],
        },
      ],
      options,
    ).events[0]!.startFrame,
    0,
    "shifted by its pre-roll it fits",
  );
});

test("budget: one riser and one impact per 15 s, hero cues kept first", () => {
  const { events, dropped } = planCueSounds(
    [
      {
        blockId: "a",
        startFrame: 0,
        cues: [
          { frame: 60, kind: "land", sfx: "sub-drop", weight: "support" },
          { frame: 300, kind: "land", sfx: "impact", weight: "hero" },
          { frame: 800, kind: "land", sfx: "impact", weight: "hero" },
        ],
      },
      {
        blockId: "b",
        startFrame: 0,
        cues: [
          { frame: 100, kind: "hit", sfx: "riser" },
          { frame: 200, kind: "hit", sfx: "riser" },
        ],
      },
    ],
    options,
  );
  assert.deepEqual(
    events.filter((event) => event.sfx === "hit" || event.sfx === "sub-drop").map((event) => event.cueFrame),
    [300, 800],
  );
  assert.equal(events.filter((event) => event.sfx === "riser").length, 1);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((item) => /budget/.test(item.reason)));
});

test("sound events become a valid audio:mix plan", () => {
  const { events } = planCueSounds(
    [
      {
        blockId: "a",
        startFrame: 0,
        cues: [
          { frame: 890, kind: "click", sfx: "tick" },
          { frame: 30, kind: "land", sfx: "impact", weight: "hero" },
        ],
      },
    ],
    options,
  );
  const plan = LocalAudioMixSchema.parse({ version: 1, durationSec: 30, tracks: cueSoundTracks(events, 30) });
  assert.equal(plan.tracks[0]!.startSec, 1);
  assert.equal(plan.tracks[0]!.role, "sfx");
  assert.ok(plan.tracks.every((track) => (track.sourceEndSec ?? 0) <= 1.8));
});

test("every data block declares cues inside its own length with default props, mapped to pack sounds", async () => {
  const dataItems = (await loadLibrary()).items.filter((item) => item.category === "data");
  const kinds = new Set(readSynthPack(SHARED_SYNTH_PACK)!.entries.map((entry) => entry.kind));
  for (const item of dataItems) {
    assert.ok(item.cues, `${item.id} has cues`);
    const cues = item.cues(item.defaultProps);
    assert.ok(cues.length > 0, item.id);
    assert.ok(
      cues.some((cue) => cue.weight === "hero"),
      `${item.id} names its hero moment`,
    );
    for (const cue of cues)
      assert.ok(cue.frame >= 0 && cue.frame < item.durationInFrames, `${item.id} ${cue.label} at ${cue.frame}`);
    const { events } = planCueSounds([{ blockId: item.id, startFrame: 0, cues }], {
      fps: 30,
      durationInFrames: item.durationInFrames,
      pack: readSynthPack(SHARED_SYNTH_PACK)!.entries,
    });
    assert.ok(events.every((event) => kinds.has(event.sfx)));
  }
});

// --- Decisions: every cut and hero moment is a sound or a silence with its reason ---

test("a layered hero cue: transient on the frame, body and tail a frame later, quieter than the primary, deterministic", () => {
  const blocks = [
    {
      blockId: "a",
      startFrame: 0,
      cues: [
        {
          frame: 100,
          kind: "reveal" as const,
          sfx: "tick" as const,
          weight: "hero" as const,
          layers: ["whoosh", "sub-drop"] as ("whoosh" | "sub-drop")[],
          label: "reveal",
        },
      ],
    },
  ];
  const first = planCueSounds(blocks, options);
  assert.deepEqual(planCueSounds(blocks, options), first, "same input, same plan");
  const primary = first.events.find((event) => !event.layerOf)!;
  const layers = first.events.filter((event) => event.layerOf === primary.id);
  assert.equal(primary.cueFrame, 100);
  assert.deepEqual(layers.map((event) => [event.sfx, event.layer, event.cueFrame]).sort(), [
    ["sub-drop", "tail", 101],
    ["whoosh", "body", 101],
  ]);
  assert.ok(layers.every((event) => event.gain < primary.gain && event.gain <= 0.2 && event.weight === "support"));
  assert.equal(new Set(first.events.map((event) => event.id)).size, first.events.length, "ids are unique");
});

test("a layer obeys the budget: a sub-drop layer inside an impact's window is dropped, the primary kept", () => {
  const { events, dropped } = planCueSounds(
    [
      { blockId: "a", startFrame: 0, cues: [{ frame: 60, kind: "land", sfx: "impact", weight: "hero" }] },
      {
        blockId: "b",
        startFrame: 0,
        cues: [{ frame: 200, kind: "reveal", sfx: "tick", weight: "hero", layers: ["sub-drop"] }],
      },
    ],
    options,
  );
  assert.ok(events.some((event) => event.cueFrame === 200 && event.sfx === "tick"));
  assert.ok(!events.some((event) => event.sfx === "sub-drop"));
  assert.ok(dropped.some((item) => /:layer:sub-drop$/.test(item.id) && /budget/.test(item.reason)));
  const support = planCueSounds(
    [{ blockId: "c", startFrame: 0, cues: [{ frame: 50, kind: "cut", sfx: "whoosh", layers: ["tick"] }] }],
    options,
  );
  assert.equal(support.events.length, 1);
  assert.match(support.dropped[0]!.reason, /hero/);
});

test("an explicit silence places nothing, is recorded, and silences the block's own whoosh on that cut", () => {
  const { events, dropped, silences } = planCueSounds(
    [
      { blockId: "whip-pan", startFrame: 0, cues: [{ frame: 91, kind: "cut", sfx: "whoosh", weight: "hero" }] },
      {
        blockId: "cue-sheet",
        startFrame: 0,
        cues: [
          {
            frame: 90,
            kind: "cut",
            sfx: "none",
            decided: true,
            silent: { reason: "the music drops out; the cut lands in silence" },
            label: "c2",
          },
        ],
      },
    ],
    options,
  );
  assert.equal(events.length, 0);
  assert.deepEqual(
    silences.map((item) => [item.cueFrame, item.reason]),
    [[90, "the music drops out; the cut lands in silence"]],
  );
  assert.match(dropped[0]!.reason, /decided silent at frame 90/);
});

test("a decided sound replaces the block's sound on the same cut instead of doubling it", () => {
  const { events, dropped } = planCueSounds(
    [
      { blockId: "whip-pan", startFrame: 0, cues: [{ frame: 120, kind: "cut", sfx: "whoosh", weight: "hero" }] },
      {
        blockId: "cue-sheet",
        startFrame: 0,
        cues: [{ frame: 121, kind: "cut", sfx: "tick", decided: true, label: "c3" }],
      },
    ],
    options,
  );
  assert.deepEqual(
    events.map((event) => event.sfx),
    ["tick"],
  );
  assert.match(dropped[0]!.reason, /replaced by the decision/);
});

test("cue decisions: sfx or silent with a reason; none, both, unknown kinds and silence are told apart", () => {
  const cue = (extra: Record<string, unknown>) => ({
    id: "x",
    kind: "cut" as const,
    intentSec: 1,
    snap: "none" as const,
    snappedSec: 1,
    frame: 30,
    deltaSec: 0,
    ...extra,
  });
  assert.equal(cueDecision(cue({ sfx: "whoosh" })).state, "sound");
  assert.equal(cueDecision(cue({ silent: { reason: "held breath" } })).state, "silent");
  assert.equal(cueDecision(cue({})).state, "undecided");
  assert.equal(cueDecision(cue({ sfx: "none" })).state, "undecided");
  assert.equal(cueDecision(cue({ sfx: "whoosh", silent: { reason: "held breath" } })).state, "conflict");
  assert.equal(cueDecision(cue({ sfx: "swoosh-low" })).state, "unknown-sfx");
  assert.equal(cueDecision(cue({ kind: "hit", weight: "support" })).state, "not-required");
  assert.equal(
    cueDecision(cue({ kind: "reveal" })).state,
    "undecided",
    "a reveal is a hero moment unless marked support",
  );
  assert.throws(() =>
    CueSheetSchema.parse({
      schemaVersion: 1,
      fps: 30,
      audioMapPath: "x",
      musicOffsetSec: 0,
      cues: [cue({ silent: { reason: "" } })],
    }),
  );
  assert.deepEqual(
    undecidedCues({ cues: [cue({ sfx: "tick" }), cue({ id: "y", shotId: "s2" })] }).map((row) => [row.id, row.shotId]),
    [["y", "s2"]],
  );
});

test("film events: plan boundaries meet their cue-sheet cues; an unnamed boundary is undecided; a block's sound decides only what the sheet leaves out", () => {
  const shot = (id: string, startFrame: number, durationFrames: number, transitionToNext?: string) => ({
    id,
    startFrame,
    durationFrames,
    ...(transitionToNext ? { transitionToNext } : {}),
  });
  const plan = {
    fps: 30,
    shots: [shot("a", 0, 60, "whip"), shot("b", 60, 60), shot("c", 120, 60), shot("d", 180, 60)],
  } as never;
  const sheetCue = (id: string, frame: number, extra: Record<string, unknown>) => ({
    id,
    kind: "cut" as const,
    intentSec: frame / 30,
    snap: "none" as const,
    snappedSec: frame / 30,
    frame,
    deltaSec: 0,
    ...extra,
  });
  const cueSheet = { fps: 30, cues: [sheetCue("cb", 59, { sfx: "whoosh" }), sheetCue("cc", 120, {})] };
  const events = decideFilmEvents({
    fps: 30,
    plan,
    cueSheet,
    blocks: [
      {
        blockId: "zoom",
        startFrame: 150,
        cues: [
          { frame: 30, kind: "cut", sfx: "whoosh" },
          { frame: -30, kind: "cut", sfx: "tick" },
        ],
      },
    ],
  });
  const at = (frame: number) => events.find((event) => event.frame === frame)!;
  assert.equal(at(59).state, "sound");
  assert.deepEqual([...at(59).sources].sort(), ["cue-sheet", "plan"]);
  assert.equal(at(59).transition, "whip");
  assert.equal(at(120).state, "undecided", "a block's tick cannot decide a cue the sheet left undecided");
  assert.equal(at(180).state, "sound");
  assert.equal(at(180).by, "block");
  assert.deepEqual(describeUndecided(events), ["cut @120 (c) cue cc: neither sfx nor silent"]);
});

test("seamFrame moves a transition's cut cue onto the film's seam; without it the preview seam stays and the caller warns", () => {
  const cues = [
    { frame: 40, kind: "cut" as const, sfx: "whoosh" as const },
    { frame: 5, kind: "peak" as const },
  ];
  assert.deepEqual(seamCues(cues, { seamFrame: 12 }), {
    cues: [
      { frame: 12, kind: "cut", sfx: "whoosh" },
      { frame: 5, kind: "peak" },
    ],
    placed: true,
  });
  assert.deepEqual(seamCues(cues, {}), { cues, placed: false });
});
