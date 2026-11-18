import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAudioMap } from "../src/lib/audio-map/analyse";
import { backtime } from "../src/lib/audio-map/backtime";
import { readCueDrafts, snapCues, suggestCuts, type CueDraft } from "../src/lib/audio-map/snap";
import { addReference } from "../src/lib/reference/add";
import { analyseReference } from "../src/lib/reference/analyse";
import { validateReference } from "../src/lib/reference/library";
import { AudioMapSchema, CueSheetSchema, type AudioMap } from "../src/types/film";
import { detectDecoderDelay } from "../src/lib/audio-map/decoder-delay";
import { tryStems } from "../src/lib/audio-map/stems";
import { drumTrack, kickTrainTrack, noiseSource, randomKicks, RATE, type Hit, writeWav } from "./fixtures/audio-tracks";

// --- Pure logic on a hand-written map: known anchors, known outcomes ---

const SHA = "a".repeat(64);

function reliableMap(overrides: Partial<AudioMap> = {}): AudioMap {
  const beats = Array.from({ length: 40 }, (_, index) => index * 0.5);
  return AudioMapSchema.parse({
    schemaVersion: 1,
    source: { path: "track.wav", sha256: SHA, durationSec: 20 },
    tempo: { bpm: 120, confidence: 0.9, gridTrust: "reliable" },
    beatsSec: beats,
    downbeatsSec: beats.filter((_, index) => index % 4 === 0),
    phrases: [
      { startSec: 0, endSec: 8, energy: 0.5 },
      { startSec: 8, endSec: 16, energy: 0.8 },
      { startSec: 16, endSec: 20, energy: 0.6 },
    ],
    sections: [
      { startSec: 0, endSec: 8, level: "mid", density: 2, feel: "steady" },
      { startSec: 8, endSec: 17, level: "high", density: 6, feel: "busy" },
      { startSec: 17, endSec: 20, level: "low", density: 0.5, feel: "falling" },
    ],
    events: beats.map((timeSec, index) => ({
      timeSec,
      kind: index % 4 === 0 ? "kick" : "hat",
      strength: index % 4 === 0 ? 0.9 : 0.4,
      metric: index % 4 === 0 ? "downbeat" : "beat",
    })),
    keyMoments: [
      { timeSec: 8.21, kind: "surge", strength: 0.8 },
      { timeSec: 17.03, kind: "hard-stop", strength: 0.9 },
    ],
    silences: [{ startSec: 17.05, endSec: 18 }],
    risers: [],
    energyCurve: [
      { timeSec: 0, rms: 0, low: 0, high: 0 },
      { timeSec: 20, rms: 1, low: 1, high: 1 },
    ],
    ...overrides,
  });
}

const weakMap = () => reliableMap({ tempo: { bpm: 120, confidence: 0.3, gridTrust: "weak" } });
// Anchor logic is checked without the per-kind lead; the lead has its own test below.
const snap = (drafts: CueDraft[], map = reliableMap(), fps = 30, musicOffsetSec = 0) =>
  snapCues({ drafts, map, fps, musicOffsetSec, audioMapPath: "map.json", leadFrames: false });

test("edit:snap carries each cue's sound decision onto the sheet", () => {
  const { sheet } = snap([
    { id: "a", kind: "cut", intentSec: 4.1, silent: { reason: "the beat drops out" } },
    { id: "b", kind: "reveal", intentSec: 6, sfx: "tick", layers: ["whoosh", "sub-drop"], weight: "hero" },
  ]);
  const byId = Object.fromEntries(sheet.cues.map((cue) => [cue.id, cue]));
  assert.deepEqual(byId.a!.silent, { reason: "the beat drops out" });
  assert.deepEqual([byId.b!.sfx, byId.b!.layers, byId.b!.weight], ["tick", ["whoosh", "sub-drop"], "hero"]);
});

test("per-kind leads: a cut lands a frame before its downbeat, a sound effect on it, a hit up to three early", () => {
  const { sheet } = snapCues({
    drafts: [
      { id: "cut", kind: "cut", intentSec: 4.1 },
      { id: "sfx", kind: "sfx", intentSec: 5.02 },
      { id: "hit", kind: "hit", intentSec: 7.05 },
    ],
    map: reliableMap(),
    fps: 30,
    musicOffsetSec: 0,
    audioMapPath: "map.json",
    leadFrames: { hit: 9 },
  });
  const byId = Object.fromEntries(sheet.cues.map((cue) => [cue.id, cue]));
  assert.equal(byId.cut!.frame, 119);
  assert.equal(byId.cut!.anchorFrame, 120);
  assert.equal(byId.cut!.leadFrames, 1);
  assert.equal(byId.cut!.snappedSec, 4, "snappedSec stays the music anchor");
  assert.equal(byId.sfx!.frame, 150);
  assert.equal(byId.sfx!.leadFrames, undefined);
  assert.equal(byId.hit!.frame, 207, "a hit lead is clamped to three frames");
  CueSheetSchema.parse(sheet);
});

test("a hard cut within 0.15 s moves to a downbeat, frame-exact, with its delta", () => {
  const { sheet, unanchored } = snap([{ id: "a", kind: "cut", intentSec: 4.1 }]);
  const cue = sheet.cues[0]!;
  assert.deepEqual(unanchored, []);
  assert.equal(cue.snap, "downbeat");
  assert.equal(cue.frame, 120);
  assert.equal(cue.snappedSec, 4);
  assert.equal(cue.deltaSec, -0.1);
  CueSheetSchema.parse(sheet);
});

test("a hard cut further than 0.15 s from a strong anchor stays where it was and is named", () => {
  // 5.0 is a beat but not a strong one, and 4.0 and 6.0 are too far.
  const { sheet, unanchored } = snap([{ id: "a", kind: "cut", intentSec: 5.0 }]);
  assert.equal(sheet.cues[0]!.snap, "none");
  assert.equal(sheet.cues[0]!.frame, 150);
  assert.equal(unanchored[0]!.id, "a");
  assert.match(unanchored[0]!.reason, /within 0.15/);
});

test("a small entrance moves to a beat within 0.10 s, and no further", () => {
  const near = snap([{ id: "a", kind: "hit", intentSec: 5.08 }]);
  assert.equal(near.sheet.cues[0]!.snap, "beat");
  assert.equal(near.sheet.cues[0]!.frame, 150);
  const far = snap([{ id: "a", kind: "hit", intentSec: 5.14 }]);
  assert.equal(far.sheet.cues[0]!.snap, "none");
  assert.equal(far.unanchored.length, 1);
});

test("a reveal asked to take a beat is treated as a small entrance", () => {
  const { sheet } = snap([{ id: "a", kind: "reveal", intentSec: 5.05, snap: "beat" }]);
  assert.equal(sheet.cues[0]!.snap, "beat");
  assert.equal(sheet.cues[0]!.frame, 150);
});

test("the tolerance is checked on the delivered frame, so rounding never carries a cue past it", () => {
  // At 10 fps the anchor 0.26 rounds to 0.3: within 0.15 of the anchor's own time, not of the cue at 0.14.
  const map = reliableMap({
    beatsSec: [],
    downbeatsSec: [],
    phrases: [],
    sections: [],
    events: [],
    keyMoments: [{ timeSec: 0.26, kind: "impact", strength: 1 }],
    silences: [],
  });
  const { sheet, unanchored } = snap([{ id: "a", kind: "cut", intentSec: 0.14 }], map, 10);
  assert.equal(sheet.cues[0]!.snap, "none");
  assert.equal(unanchored.length, 1);
});

test("offsets convert the track's anchors to film time", () => {
  const { sheet } = snap([{ id: "a", kind: "cut", intentSec: 2.0 }], reliableMap(), 30, 2);
  assert.equal(sheet.cues[0]!.snap, "downbeat");
  assert.equal(sheet.cues[0]!.frame, 60);
  assert.equal(sheet.musicOffsetSec, 2);
  // Track's downbeat at 6.0 is film 3.1 with this offset, and frame-exact there.
  const shifted = snap([{ id: "a", kind: "cut", intentSec: 3.0 }], reliableMap(), 30, 2.9);
  assert.equal(shifted.sheet.cues[0]!.snap, "downbeat");
  assert.equal(shifted.sheet.cues[0]!.frame, 93);
  assert.equal(shifted.sheet.cues[0]!.snappedSec, 3.1);
});

test("without a reliable grid a cue never lands on a beat, even when it asks to", () => {
  const { sheet, unanchored, warnings } = snap(
    [
      { id: "a", kind: "cut", intentSec: 4.1 },
      { id: "b", kind: "reveal", intentSec: 5.02, snap: "beat" },
      { id: "c", kind: "hit", intentSec: 8.15 },
      { id: "d", kind: "cut", intentSec: 16.05, snap: "downbeat" },
    ],
    weakMap(),
  );
  const byId = Object.fromEntries(sheet.cues.map((cue) => [cue.id, cue]));
  assert.equal(byId.a!.snap, "none");
  assert.equal(byId.b!.snap, "none");
  assert.equal(byId.c!.snap, "key-moment");
  assert.equal(byId.d!.snap, "phrase");
  assert.ok(sheet.cues.every((cue) => cue.snap !== "beat" && cue.snap !== "downbeat"));
  assert.deepEqual(
    unanchored.map((item) => item.id),
    ["a", "b"],
  );
  assert.equal(warnings.length, 2);
});

test("a stop can land on the start of a silence, and two cuts never share a frame", () => {
  const stop = snap([{ id: "a", kind: "stop", intentSec: 17.1 }]);
  assert.equal(stop.sheet.cues[0]!.snap, "key-moment");
  const both = snap([
    { id: "a", kind: "cut", intentSec: 3.95 },
    { id: "b", kind: "cut", intentSec: 4.05 },
  ]);
  assert.equal(both.sheet.cues[0]!.frame, 120);
  assert.equal(both.sheet.cues[1]!.snap, "none");
});

test("snap none holds the cue without reporting it", () => {
  const { sheet, unanchored } = snap([{ id: "a", kind: "cut", intentSec: 4.1, snap: "none" }]);
  assert.equal(sheet.cues[0]!.frame, 123);
  assert.deepEqual(unanchored, []);
});

test("duplicate ids are refused and drafts read from either shape", () => {
  assert.throws(
    () =>
      snap([
        { id: "a", kind: "cut", intentSec: 1 },
        { id: "a", kind: "cut", intentSec: 2 },
      ]),
    /unique/,
  );
  const directory = mkdtempSync(path.join(tmpdir(), "audio-map-drafts-"));
  try {
    const list = path.join(directory, "list.json");
    writeFileSync(list, JSON.stringify([{ id: "a", kind: "cut", intentSec: 1 }]));
    assert.equal(readCueDrafts(list).length, 1);
    writeFileSync(list, JSON.stringify({ cues: [{ id: "a", kind: "cut", intentSec: 1 }], other: true }));
    assert.equal(readCueDrafts(list).length, 1);
    writeFileSync(list, JSON.stringify({ shots: [] }));
    assert.throws(() => readCueDrafts(list), /cues/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--suggest varies shot lengths, skips most beats and leaves silences open", () => {
  const map = reliableMap();
  const { sheet, sections, stats } = suggestCuts({ map, fps: 30, musicOffsetSec: 0, audioMapPath: "map.json" });
  CueSheetSchema.parse(sheet);
  assert.ok(sheet.cues.length >= 5);
  assert.ok(stats.shotLengthVariety! >= 1.5, `variety ${stats.shotLengthVariety}`);
  assert.ok(stats.beatsUsedShare! < 0.6, `beats used ${stats.beatsUsedShare}`);
  assert.ok(stats.minShotSec! >= 10 / 30 - 1e-9, `shortest shot ${stats.minShotSec}`);
  assert.equal(sheet.cues.filter((cue) => cue.snappedSec >= 17.05 && cue.snappedSec <= 18).length, 0);
  const high = sections.find((section) => section.level === "high")!;
  const mid = sections.find((section) => section.level === "mid")!;
  assert.ok(
    high.cuts / (high.endSec - high.startSec) > mid.cuts / (mid.endSec - mid.startSec),
    "the busy section cuts faster",
  );
  assert.deepEqual(
    suggestCuts({ map, fps: 30, musicOffsetSec: 0, audioMapPath: "map.json" }),
    { sheet, sections, stats },
    "deterministic",
  );
});

test("--suggest on a weak grid uses no beats and holds longer", () => {
  const events = reliableMap().events.map((event) => ({
    ...event,
    metric: "off-grid" as const,
    kind: "perc" as const,
    strength: 0.7,
    timeSec: event.timeSec + 0.17,
  }));
  const map = reliableMap({ tempo: { confidence: 0.2, gridTrust: "none" }, beatsSec: [], downbeatsSec: [], events });
  const { sheet } = suggestCuts({ map, fps: 30, musicOffsetSec: 0, audioMapPath: "map.json" });
  assert.ok(sheet.cues.every((cue) => cue.snap !== "beat" && cue.snap !== "downbeat"));
  const firm = suggestCuts({ map: reliableMap(), fps: 30, musicOffsetSec: 0, audioMapPath: "map.json" }).sheet.cues
    .length;
  assert.ok(sheet.cues.length < firm);
});

test("backtime lands a strong moment on the end card and counts planned cues on anchors", () => {
  const drafts: CueDraft[] = [
    { id: "a", kind: "cut", intentSec: 1 },
    { id: "b", kind: "cut", intentSec: 3 },
  ];
  const { candidates, endCardSec } = backtime({ map: reliableMap(), filmSec: 8, endCardFrame: 180, fps: 30, drafts });
  assert.equal(endCardSec, 6);
  const stop = candidates.find((candidate) => candidate.anchorSec === 17.03)!;
  assert.equal(stop.offsetSec, 11.03);
  assert.equal(stop.landsOnFrame, 180);
  assert.equal(stop.cuesTotal, 2);
  assert.equal(stop.tailShortSec, 0);
  // At 2.21 the surge lands on the card, and the track's downbeats fall 0.21 s from cues at whole seconds.
  const surge = candidates.find((candidate) => candidate.anchorSec === 8.21)!;
  assert.equal(surge.offsetSec, 2.21);
  for (const candidate of candidates) assert.equal(candidate.landsOnFrame, 180);
  assert.deepEqual(
    candidates.map((item) => item.score),
    [...candidates.map((item) => item.score)].sort((a, b) => b - a),
    "ranked",
  );
});

test("backtime refuses offsets before the track starts and says what the track leaves uncovered", () => {
  const result = backtime({ map: reliableMap(), filmSec: 30, endCardFrame: 600, fps: 30 });
  assert.ok(result.excludedBeforeTrackStart >= 1, "the surge at 8.21 would need the track to start after the film");
  assert.ok(result.candidates.every((candidate) => candidate.offsetSec >= 0));
  const tight = backtime({ map: reliableMap(), filmSec: 10, endCardFrame: 180, fps: 30 }).candidates.find(
    (candidate) => candidate.anchorSec === 17.03,
  )!;
  assert.equal(tight.offsetSec, 11.03);
  assert.equal(tight.tailShortSec, 1.03);
});

// --- The worker on generated tracks: known tempo, silence and riser ---

const hasUv = spawnSync(process.env.REFERENCE_UVX ?? "uvx", ["--version"], { encoding: "utf8" }).status === 0;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
const worker = { skip: hasUv && hasFfmpeg ? false : "needs uv and ffmpeg", timeout: 600000 } as const;
function withTrack(t: { after: (fn: () => void) => void }, name: string, samples: Float32Array) {
  const directory = mkdtempSync(path.join(tmpdir(), "audio-map-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, `${name}.wav`);
  writeWav(input, samples);
  return { directory, input, output: path.join(directory, `${name}.json`) };
}

test("a drum track at a known tempo gives its tempo, a reliable grid and the right drums", worker, (t) => {
  const { input, output, directory } = withTrack(t, "drums", drumTrack(128, 24));
  const result = buildAudioMap({ input, output });
  const map = AudioMapSchema.parse(JSON.parse(readFileSync(output, "utf8")));
  assert.equal(map.tempo.gridTrust, "reliable", result.brief);
  assert.ok(Math.abs(map.tempo.bpm! - 128) < 1, `bpm ${map.tempo.bpm}`);
  assert.ok(map.tempo.confidence > 0.6);
  const period = 60 / 128;
  const offGrid = map.beatsSec.map((at) => Math.abs(at / period - Math.round(at / period)) * period);
  assert.ok(
    Math.max(...offGrid.slice(1, -1)) < 0.02,
    `beats off by ${offGrid.map((value) => value.toFixed(3)).join(" ")}`,
  );
  // Kicks every second beat, so downbeats keep to the kicks.
  assert.ok(map.downbeatsSec.every((at) => Math.round(at / period) % 2 === 0));
  const near = (kind: string, target: number) =>
    map.events.some((event) => event.kind === kind && Math.abs(event.timeSec - target) < 0.03);
  const heard = (kind: Hit, times: number[]) => times.filter((at) => near(kind, at)).length / times.length;
  const beats = Array.from({ length: 40 }, (_, index) => index * period);
  assert.ok(
    heard(
      "kick",
      beats.filter((_, index) => index % 2 === 0),
    ) > 0.8,
    `kicks ${map.events
      .slice(0, 24)
      .map((event) => `${event.timeSec}:${event.kind}`)
      .join(" ")}`,
  );
  assert.ok(
    heard(
      "snare",
      beats.filter((_, index) => index % 2 === 1),
    ) > 0.8,
    "snares",
  );
  // Half the hats fall in the tail of a snare and go unheard. The other half must be found and named.
  assert.ok(
    heard(
      "hat",
      beats.map((at) => at + period / 2),
    ) > 0.4,
    `hats ${map.events
      .slice(0, 30)
      .map((event) => `${event.timeSec}:${event.kind}`)
      .join(" ")}`,
  );
  assert.ok(
    map.events
      .filter((event) => event.kind === "kick")
      .every((event) => event.metric === "beat" || event.metric === "downbeat"),
  );
  assert.ok(result.imagePath && readFileSync(result.imagePath).length > 10000, "draws a map");
  assert.equal(path.dirname(result.imagePath!), directory);
  assert.match(result.brief, /128\.\d BPM, grid reliable/);
});

test("a kick train after a quiet intro proves its grid: tempo, beat 0 and downbeats from the hits", worker, (t) => {
  const { input, output } = withTrack(t, "kick-train", kickTrainTrack(140, 4, 18));
  const { map, brief, diagnostics } = buildAudioMap({ input, output, imagePath: null });
  assert.equal(map.tempo.gridTrust, "reliable", brief);
  assert.equal(map.grid?.source, "drums-mix", JSON.stringify(map.grid?.candidates));
  assert.ok(Math.abs(map.tempo.bpm! - 140) < 0.2, `bpm ${map.tempo.bpm}`);
  const period = 60 / 140;
  const nearest = map.beatsSec.reduce(
    (found, at) => (Math.abs(at - 4) < Math.abs(found - 4) ? at : found),
    Number.POSITIVE_INFINITY,
  );
  assert.ok(Math.abs(nearest - 4) <= 0.01, `beat 0 at ${nearest}`);
  const truth = Array.from({ length: 8 }, (_, bar) => 4 + bar * 4 * period);
  const matched = truth.filter((at) => map.downbeatsSec.some((downbeat) => Math.abs(downbeat - at) <= 0.02));
  assert.ok(matched.length >= 7, `downbeats ${map.downbeatsSec.join(" ")}`);
  assert.ok(
    map.beatsSec.every((at) => at >= 4 - period / 2),
    "no beats in the padded intro",
  );
  assert.equal(map.grid?.bars.length, map.downbeatsSec.length);
  assert.equal(map.grid?.barKnown, (map.grid?.downbeatConfidence ?? 0) >= 0.2);
  assert.ok((map.grid?.residualMs ?? 99) < 10);
  assert.ok(map.drums && map.drums.kick.length >= 30 && map.drums.source === "mix");
  assert.equal(diagnostics.gridSource, "drums-mix");
});

test("kicks at random times never prove a grid", worker, (t) => {
  const { input, output } = withTrack(t, "random-kicks", randomKicks(40, 16));
  const { map, brief } = buildAudioMap({ input, output, imagePath: null });
  assert.notEqual(map.tempo.gridTrust, "reliable", brief);
  assert.notEqual(map.grid?.candidates.find((item) => item.source === "drums-mix")?.trust, "reliable");
});

test("stems that cannot run fall back to the mix and say why", worker, (t) => {
  const previous = process.env.AUDIO_STEMS_UVX;
  process.env.AUDIO_STEMS_UVX = path.join(tmpdir(), "no-such-uvx");
  t.after(() =>
    previous === undefined ? delete process.env.AUDIO_STEMS_UVX : (process.env.AUDIO_STEMS_UVX = previous),
  );
  const { input, output, directory } = withTrack(t, "no-stems", kickTrainTrack(120, 1, 10));
  const outcome = tryStems(input, { root: directory });
  assert.equal(outcome.stems, null);
  const { map, diagnostics } = buildAudioMap({ input, output, imagePath: null, stems: true });
  assert.equal(map.stems, undefined);
  assert.match(diagnostics.stemsSkipped ?? "", /stem separation failed/);
  assert.equal(map.drums?.source, "mix");
});

const stemsGate = {
  skip:
    process.env.RUN_AUDIO_STEMS === "1" && hasUv && hasFfmpeg
      ? false
      : "set RUN_AUDIO_STEMS=1 (downloads torch and the htdemucs weights)",
  timeout: 1800000,
} as const;

test("with Demucs stems the grid comes from the drums stem", stemsGate, (t) => {
  const { input, output, directory } = withTrack(t, "stems", kickTrainTrack(140, 4, 14));
  const outcome = tryStems(input, { root: directory });
  assert.ok(outcome.stems, "stems" in outcome && outcome.stems === null ? outcome.reason : "");
  const { map } = buildAudioMap({ input, output, imagePath: null, stems: true });
  assert.equal(map.grid?.source, "drums-stem");
  assert.equal(map.tempo.gridTrust, "reliable");
  const nearest = map.beatsSec.reduce(
    (found, at) => (Math.abs(at - 4) < Math.abs(found - 4) ? at : found),
    Number.POSITIVE_INFINITY,
  );
  assert.ok(Math.abs(nearest - 4) <= 0.01, `beat 0 at ${nearest}`);
});

test("decoder delay: PCM has none, and AAC with an edit list presents no priming", worker, (t) => {
  const { input, directory } = withTrack(t, "pcm", kickTrainTrack(120, 0.5, 2));
  const pcm = detectDecoderDelay(input);
  assert.equal(pcm.primingSec, 0);
  assert.equal(pcm.primingCorrected, false);
  const m4a = path.join(directory, "aac.m4a");
  assert.equal(spawnSync("ffmpeg", ["-v", "error", "-y", "-i", input, "-c:a", "aac", m4a]).status, 0);
  const aac = detectDecoderDelay(m4a, true);
  assert.equal(aac.codec, "aac");
  assert.ok(aac.editList || aac.declaredDelaySamples > 0, JSON.stringify(aac));
  assert.equal(aac.primingSec, 0);
  assert.equal(aac.primingCorrected, false);
  const { map } = buildAudioMap({ input: m4a, output: path.join(directory, "aac.json"), imagePath: null });
  assert.equal(map.source.decoder?.codec, "aac");
});

test("a fade in the last second is the ending, not a drop", worker, (t) => {
  const track = drumTrack(120, 12);
  const fade = Math.round(0.4 * RATE);
  for (let index = 0; index < fade; index += 1) track[track.length - fade + index]! *= 1 - index / fade;
  const { input, output } = withTrack(t, "fade-end", track);
  const { map } = buildAudioMap({ input, output, imagePath: null });
  assert.ok(
    !map.keyMoments.some((moment) => moment.kind === "drop" && moment.timeSec > map.source.durationSec - 1),
    JSON.stringify(map.keyMoments),
  );
});

test("a level that swings with every bar is texture: no surges or drops inside it", worker, (t) => {
  const beat = 60 / 138;
  // Hits on the bar's first two beats only, so the level rises and falls once a bar.
  const track = drumTrack(138, 16, (at) => Math.round(at / beat) % 4 >= 2);
  const { input, output } = withTrack(t, "bar-swing", track);
  const { map } = buildAudioMap({ input, output, imagePath: null });
  const inside = map.keyMoments.filter(
    (moment) => (moment.kind === "drop" || moment.kind === "surge") && moment.timeSec > 1 && moment.timeSec < 15,
  );
  assert.deepEqual(inside, [], JSON.stringify(map.keyMoments));
});

test("the same file gives byte-identical JSON", worker, (t) => {
  const { input, output, directory } = withTrack(t, "same", drumTrack(100, 10));
  buildAudioMap({ input, output, imagePath: null });
  const first = readFileSync(output);
  const second = path.join(directory, "again.json");
  buildAudioMap({ input, output: second, imagePath: null });
  assert.ok(first.equals(readFileSync(second)));
});

test("a sparse pad does not get a grid the tracker invented", worker, (t) => {
  const seconds = 24;
  const track = new Float32Array(seconds * RATE);
  for (let index = 0; index < track.length; index += 1) {
    const time = index / RATE;
    const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * time) / 9);
    track[index] =
      0.2 *
      swell *
      (Math.sin(2 * Math.PI * 220 * time) +
        0.6 * Math.sin(2 * Math.PI * 277.2 * time) +
        0.5 * Math.sin(2 * Math.PI * 329.6 * time));
  }
  const { input, output } = withTrack(t, "pad", track);
  const result = buildAudioMap({ input, output, imagePath: null });
  assert.equal(result.map.tempo.gridTrust, "none", result.brief);
  assert.equal(result.map.tempo.bpm, undefined);
  assert.deepEqual(result.map.beatsSec, []);
  assert.deepEqual(result.map.downbeatsSec, []);
  assert.ok(result.map.events.every((event) => event.metric === "off-grid"));
  assert.ok(result.map.events.length < 16, `events ${result.map.events.length}`);
  assert.ok(result.map.phrases.length >= 1 && result.map.sections.length >= 1, "still has structure to pace by");
  // A slow swell has no point to cut on, however deep it goes.
  assert.deepEqual(
    result.map.keyMoments.filter(
      (moment) => moment.kind === "surge" || moment.kind === "drop" || moment.kind === "riser-end",
    ),
    [],
  );
  assert.deepEqual(result.map.risers, []);
  assert.ok(
    Math.max(...result.map.energyCurve.map((point) => point.high)) < 0.2,
    "a band that is barely there does not read as full",
  );
  assert.doesNotMatch(result.brief, /Cut to downbeats/);
  const snapped = snapCues({
    drafts: [
      { id: "a", kind: "cut", intentSec: 3 },
      { id: "b", kind: "hit", intentSec: 5, snap: "beat" },
    ],
    map: result.map,
    fps: 30,
    musicOffsetSec: 0,
    audioMapPath: output,
  });
  assert.ok(snapped.sheet.cues.every((cue) => cue.snap !== "beat" && cue.snap !== "downbeat"));
});

test("a known silence is measured, marked as a hard stop and holds no beats", worker, (t) => {
  // A held bass under the drums, so that everything stops at 12.0 and returns at 14.0.
  const track = drumTrack(120, 24, (at) => at >= 11.9 && at < 14);
  track.forEach((value, index) => {
    const time = index / RATE;
    track[index] = time >= 12 && time < 14 ? 0 : value + 0.25 * Math.sin(2 * Math.PI * 110 * time);
  });
  const { input, output } = withTrack(t, "gap", track);
  const { map, brief } = buildAudioMap({ input, output, imagePath: null });
  const silence = map.silences.find((span) => span.startSec > 10 && span.startSec < 13);
  assert.ok(silence, `no silence: ${brief}`);
  assert.ok(Math.abs(silence.startSec - 12) < 0.1 && Math.abs(silence.endSec - 14) < 0.1, JSON.stringify(silence));
  assert.ok(
    map.beatsSec.every((at) => at < silence.startSec || at > silence.endSec),
    "no beat inside the silence",
  );
  assert.ok(
    map.keyMoments.some((moment) => moment.kind === "hard-stop" && Math.abs(moment.timeSec - 12) < 0.15),
    JSON.stringify(map.keyMoments),
  );
  const suggested = suggestCuts({ map, fps: 30, musicOffsetSec: 0, audioMapPath: output });
  assert.ok(
    suggested.sheet.cues.every((cue) => cue.snappedSec <= silence.startSec || cue.snappedSec >= silence.endSec),
  );
});

test("a known riser is found and ends in a key moment", worker, (t) => {
  const seconds = 20;
  const track = new Float32Array(seconds * RATE);
  const noise = noiseSource(99);
  for (let index = Math.round(4 * RATE); index < Math.round(10 * RATE); index += 1) {
    const rise = (index / RATE - 4) / 6;
    track[index] = noise() * 0.4 * rise ** 3;
  }
  const loud = drumTrack(120, seconds, (at) => at < 10);
  loud.forEach((value, index) => (track[index]! += value));
  const { input, output } = withTrack(t, "riser", track);
  const { map, brief } = buildAudioMap({ input, output, imagePath: null });
  assert.ok(
    map.risers.some((span) => span.startSec < 8.5 && Math.abs(span.endSec - 10) < 0.6),
    `risers ${JSON.stringify(map.risers)} ${brief}`,
  );
  assert.ok(
    map.keyMoments.some((moment) => moment.kind === "riser-end" && Math.abs(moment.timeSec - 10) < 0.6),
    JSON.stringify(map.keyMoments),
  );
  const levels = map.sections.map((section) => `${section.startSec}:${section.level}`).join(" ");
  assert.equal(map.sections[0]!.level, "low", levels);
  assert.notEqual(map.sections.at(-1)!.level, "low", levels);
});

test("a level that sits flat and then jumps is a surge, not a riser", worker, (t) => {
  const { input, output } = withTrack(
    t,
    "jump",
    drumTrack(120, 16, (at) => at < 8),
  );
  const { map } = buildAudioMap({ input, output, imagePath: null });
  assert.deepEqual(map.risers, []);
  assert.ok(
    map.keyMoments.some((moment) => moment.kind === "surge" && Math.abs(moment.timeSec - 8) < 0.15),
    JSON.stringify(map.keyMoments),
  );
});

test(
  "ref:analyze writes the map beside audio.json as an extra, and a film without audio only reports it",
  worker,
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "audio-map-library-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const clip = path.join(root, "clip.wav");
    writeWav(clip, drumTrack(120, 8));
    const film = path.join(root, "film.mp4");
    const encoded = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:r=10:d=8",
        "-i",
        clip,
        "-shortest",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        film,
      ],
      { encoding: "utf8" },
    );
    assert.equal(encoded.status, 0, encoded.stderr);
    const silent = path.join(root, "silent.mp4");
    assert.equal(
      spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=black:s=64x64:r=10:d=2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          silent,
        ],
        { encoding: "utf8" },
      ).status,
      0,
    );
    const library = path.join(root, "library");
    addReference({ file: film, libraryRoot: library, id: "film" });
    addReference({ file: silent, libraryRoot: library, id: "silent" });

    const result = await analyseReference({ libraryRoot: library, id: "film", layers: ["audiomap"] });
    assert.equal((result.layers.audiomap as { available: boolean }).available, true);
    const directory = path.join(library, "film");
    const map = AudioMapSchema.parse(JSON.parse(readFileSync(path.join(directory, "audiomap.json"), "utf8")));
    assert.equal(map.mapImagePath, "visuals/audiomap.png");
    assert.ok(readFileSync(path.join(directory, "visuals", "audiomap.png")).length > 10000);
    assert.ok(!path.isAbsolute(map.source.path));
    const validation = validateReference(directory);
    assert.equal(validation.invalid.length, 0);
    assert.ok(!validation.valid.includes("audiomap.json" as never), "not one of the required layers");

    const none = await analyseReference({ libraryRoot: library, id: "silent", layers: ["audiomap"] });
    assert.equal((none.layers.audiomap as { available: boolean }).available, false);
  },
);
