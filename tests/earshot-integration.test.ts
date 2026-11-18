// Earshot in the production flow (docs/audio-integrations.md): offline, Earshot injected or absent.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readSoundReviews, reviewDirOf } from "../src/lib/audio/review-evidence";
import { sfxEvidenceLeg } from "../src/lib/film/sfx-evidence";
import { assembleSfxMap, placedDensity, sfxDensityComparison, SFX_MAP_QUERIES } from "../src/lib/audio/sfx-map";
import { SfxMapSchema } from "../src/types/sfx-map";
import { planCueSounds, type LibrarySound, type PackSound } from "../src/lib/audio/cue-sounds";
import { soundCueWeight } from "../src/lib/audio/cut-decisions";
import {
  audition,
  chooseCandidate,
  cueRoom,
  gatherSounds,
  heroSoundCues,
  packSounds,
  scoreCandidate,
  selectedSounds,
  selectionProblems,
  type RawCandidate,
} from "../src/lib/audio/sfx-audition";
import { cutSoundCoverageLeg, measuredLeadSec } from "../src/lib/film/cut-sound";
import { CueSheetSchema, type CueSheet } from "../src/types/film";
import { SfxSelectionSchema, type SfxCandidate } from "../src/types/sfx-selection";

const SHA = (n: number) => n.toString(16).padStart(64, "0");

function sheet(cues: Partial<CueSheet["cues"][number]>[]): CueSheet {
  return CueSheetSchema.parse({
    schemaVersion: 1,
    fps: 30,
    audioMapPath: "pipeline/audio-map.json",
    musicOffsetSec: 0,
    cues: cues.map((cue, index) => ({
      id: `c${index + 1}`,
      kind: "cut",
      intentSec: (cue.frame ?? 0) / 30,
      snap: "beat",
      snappedSec: (cue.frame ?? 0) / 30,
      deltaSec: 0,
      frame: 0,
      ...cue,
    })),
  });
}

const sound = (over: Partial<LibrarySound>): LibrarySound => ({
  kind: "whoosh",
  file: "shared/sfx/whoosh/a.wav",
  durationSec: 0.8,
  onsetSec: 0.05,
  peakSec: 0.35,
  tailSec: 0.45,
  dynamics: "sweep",
  integratedLufs: -20,
  ...over,
});

const raw = (over: Partial<RawCandidate> & { sound?: Partial<LibrarySound> }): RawCandidate => ({
  origin: over.origin ?? "library",
  sound: sound(over.sound ?? {}),
  sha256: over.sha256 ?? SHA(1),
  loudness: over.loudness ?? { integratedLufs: -20, truePeakDb: -3 },
  checks: over.checks ?? { engine: "earshot", ok: true, warnings: [], notes: [] },
});

// --- 1. Hero cues and the shared weight rule ---

test("hero sound cues follow sfx:cues' weight rule: a moment or layered cut is hero, a plain cut support", () => {
  const cues = sheet([
    { frame: 30, kind: "cut", sfx: "whoosh" },
    { frame: 60, kind: "reveal", sfx: "impact" },
    { frame: 90, kind: "cut", sfx: "whoosh", layers: ["tick"] },
    { frame: 120, kind: "hit", silent: { reason: "the drop speaks" } },
    { frame: 150, kind: "reveal", sfx: "chime", weight: "support" },
    { frame: 180, kind: "transition", sfx: "riser", weight: "hero" },
  ]);
  assert.deepEqual(
    heroSoundCues(cues).map((cue) => [cue.cueId, cue.sfx]),
    [
      ["c2", "impact"],
      ["c3", "whoosh"],
      ["c6", "riser"],
    ],
  );
  assert.equal(soundCueWeight({ kind: "cut" }), "support");
  assert.equal(soundCueWeight({ kind: "reveal" }), "hero");
  assert.equal(soundCueWeight({ kind: "cut", layers: ["tick"] }), "hero");
  assert.deepEqual(cueRoom(cues, 2), { beforeSec: 1, afterSec: 1 });
});

// --- 1. Scoring, exclusion and choice ---

test("candidates are excluded for silence, clipping, a hard Earshot warning or a pre-roll before the film", () => {
  const room = { beforeSec: 1, afterSec: 1 };
  assert.match(
    scoreCandidate(raw({ loudness: { integratedLufs: null, truePeakDb: null } }), room, 2).excluded!,
    /silent/,
  );
  assert.match(
    scoreCandidate(raw({ loudness: { integratedLufs: -10, truePeakDb: 0.4 } }), room, 2).excluded!,
    /clipped/,
  );
  assert.match(
    scoreCandidate(
      raw({
        checks: { engine: "earshot", ok: false, warnings: [{ code: "edge", msg: "starts off zero" }], notes: [] },
      }),
      room,
      2,
    ).excluded!,
    /Earshot edge/,
  );
  assert.match(scoreCandidate(raw({}), room, 0.1).excluded!, /before the film/);
  const clean = scoreCandidate(raw({}), room, 2);
  const flawed = scoreCandidate(
    raw({
      checks: {
        engine: "earshot",
        ok: false,
        warnings: [{ code: "clicks", msg: "2 clicks" }],
        notes: [{ code: "tail", msg: "rises" }],
      },
    }),
    room,
    2,
  );
  assert.equal(clean.excluded, undefined);
  assert.equal(clean.scores.artifacts, 1);
  assert.equal(flawed.scores.artifacts, 0.82);
  assert.ok(flawed.scores.total < clean.scores.total);
  const unaudited = scoreCandidate(raw({ checks: { engine: "none", reason: "not prepared" } }), room, 2);
  assert.equal(unaudited.scores.artifacts, null);
  assert.equal(unaudited.scores.total, unaudited.scores.fit);
});

const candidate = (over: Partial<SfxCandidate>): SfxCandidate => ({
  id: "A",
  origin: "library",
  file: "a.wav",
  sha256: SHA(1),
  timing: { durationSec: 1, alignSec: 0.3, onsetSec: 0, peakSec: 0.3, tailSec: 0.7 },
  loudness: { integratedLufs: -20, truePeakDb: -3 },
  checks: { engine: "earshot", ok: true, warnings: [], notes: [] },
  scores: { fit: 0.8, artifacts: 1, total: 0.8 },
  ...over,
});

test("choice: best total, ties to the more specific origin, a repeat yields to a close second, none says why", () => {
  const synth = candidate({ id: "A", origin: "synth", sha256: SHA(1) });
  const take = candidate({ id: "B", origin: "earshot", sha256: SHA(2) });
  assert.equal(chooseCandidate([synth, take]).selected, "B");
  const close = candidate({
    id: "C",
    origin: "library",
    sha256: SHA(3),
    scores: { fit: 0.75, artifacts: 1, total: 0.75 },
  });
  const repeat = chooseCandidate([take, close], SHA(2));
  assert.equal(repeat.selected, "C");
  assert.match(repeat.reason, /repeats the previous/);
  const far = candidate({ id: "D", sha256: SHA(4), scores: { fit: 0.5, artifacts: 1, total: 0.5 } });
  assert.equal(chooseCandidate([take, far], SHA(2)).selected, "B");
  const none = chooseCandidate([candidate({ excluded: "clipped (true peak 1 dBTP)" })]);
  assert.equal(none.selected, null);
  assert.match(none.reason, /clipped/);
  assert.match(chooseCandidate([take]).reason, /Only one candidate/);
});

test("gathering keeps the best per source, takes first, each file once; the synth pack maps hit to impact", () => {
  const room = { beforeSec: 1, afterSec: 1 };
  const pack = packSounds(
    [
      { kind: "hit", file: "hit.wav", alignSec: 0, durationSec: 1.2 },
      { kind: "whoosh", file: "whoosh.wav", alignSec: 0.4, durationSec: 0.7 },
    ],
    "projects/demo/assets/sfx/synth",
  );
  assert.equal(pack[0]!.kind, "impact");
  const library = [1, 2, 3, 4].map((n) => sound({ file: `shared/sfx/whoosh/${n}.wav`, peakSec: 0.1 * n }));
  const gathered = gatherSounds("whoosh", room, {
    takes: [{ sound: sound({ file: "projects/demo/sfx/take.wav", alignSec: 0.3 }), receipt: "take.wav.take.json" }],
    library: [...library, library[0]!],
    pack,
  });
  assert.deepEqual(
    gathered.map((item) => item.origin),
    ["earshot", "library", "library", "library", "synth"],
  );
  assert.equal(gathered[0]!.takeReceipt, "take.wav.take.json");
  assert.equal(new Set(gathered.map((item) => item.sound.file)).size, gathered.length);
});

test("audition is offline-safe: one measurement per file, no audit without Earshot, a valid selection", async () => {
  const calls: string[] = [];
  const selection = await audition({
    project: "demo",
    sheet: sheet([
      { frame: 60, kind: "reveal", sfx: "whoosh" },
      { frame: 120, kind: "reveal", sfx: "whoosh" },
    ]),
    cueSheet: { path: "public/projects/demo/pipeline/cue-sheet.json", sha256: SHA(9) },
    sources: {
      library: [sound({ file: "shared/sfx/whoosh/1.wav" }), sound({ file: "shared/sfx/whoosh/2.wav", peakSec: 0.3 })],
    },
    earshot: { available: false, reason: "not prepared" },
    deps: {
      hash: (file) => SHA(file.endsWith("1.wav") ? 1 : 2),
      loudness: () => ({ integratedLufs: -20, truePeakDb: -2 }),
      check: (file) => (calls.push(file), { engine: "none", reason: "not prepared" }),
    },
  });
  assert.equal(SfxSelectionSchema.parse(selection).cues.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(
    selection.cues.every((cue) => cue.selected && cue.candidates.every((item) => item.scores.artifacts === null)),
  );
  // The second whoosh avoids repeating the first when the other is close.
  const files = selection.cues.map((cue) => cue.candidates.find((item) => item.id === cue.selected)!.file);
  assert.notEqual(files[0], files[1]);
  const chosen = selectedSounds(selection);
  assert.equal(chosen.get("c1")!.sound.file, files[0]);
  assert.equal(selectedSounds(undefined).size, 0);
});

// --- 1. The planner places the selection ---

test("sfx:cues places a cue's selected sound on its frame, with its measured phase and attack", () => {
  const pack: PackSound[] = [{ kind: "whoosh", file: "whoosh.wav", alignSec: 0.4, durationSec: 0.7 }];
  const chosen = sound({ file: "projects/demo/sfx/take.wav", alignSec: 0.32, onsetSec: 0.04 });
  const planned = planCueSounds(
    [
      {
        blockId: "cue-sheet",
        startFrame: 0,
        cues: [
          { frame: 60, kind: "cut", sfx: "whoosh", decided: true, weight: "hero", label: "c1", sound: chosen },
          // Kind mismatch: the selection is ignored, the pack plays.
          { frame: 200, kind: "cut", sfx: "impact", decided: true, weight: "hero", label: "c2", sound: chosen },
        ],
      },
    ],
    { fps: 30, durationInFrames: 300, pack: [...pack, { kind: "hit", file: "hit.wav", alignSec: 0, durationSec: 1 }] },
  );
  const first = planned.events.find((event) => event.label === "c1")!;
  assert.equal(first.file, "projects/demo/sfx/take.wav");
  assert.equal(first.alignSec, 0.32);
  assert.equal(first.onsetSec, 0.04);
  assert.equal(first.startFrame, 60 - Math.round(0.32 * 30));
  assert.equal(planned.events.find((event) => event.label === "c2")!.file, "shared/sfx/synth/hit.wav");
});

// --- 1. The sound step's done check ---

test("hero-sounds-selected: missing, stale, unplaced and swapped sounds are problems; one candidate is advisory", () => {
  const cues = sheet([{ frame: 60, kind: "reveal", sfx: "impact" }]);
  const selection = SfxSelectionSchema.parse({
    version: 1,
    project: "demo",
    fps: 30,
    cueSheet: { path: "cue-sheet.json", sha256: SHA(9) },
    earshot: { available: false, reason: "x" },
    criteria: "c",
    cues: [
      {
        cueId: "c1",
        frame: 60,
        kind: "reveal",
        sfx: "impact",
        room: { beforeSec: 2, afterSec: 4 },
        candidates: [candidate({ id: "A", file: "shared/sfx/impact/a.wav", sha256: SHA(5) })],
        selected: "A",
        reason: "A only",
      },
    ],
    notice: "n",
  });
  const hashOf = (file: string) => (file.endsWith("a.wav") ? SHA(5) : SHA(6));
  const base = { sheet: cues, sheetSha256: SHA(9), selection, hashOf };
  assert.match(selectionProblems({ ...base, selection: undefined }).problems[0]!, /not auditioned/);
  assert.match(selectionProblems({ ...base, sheetSha256: SHA(8) }).problems[0]!, /another cue sheet/);
  assert.match(selectionProblems(base).problems[0]!, /no sound-cues.json/);
  assert.match(selectionProblems({ ...base, placed: [] }).problems[0]!, /placed no sound/);
  assert.match(
    selectionProblems({ ...base, placed: [{ label: "c1", file: "shared/sfx/impact/b.wav" }] }).problems[0]!,
    /not the selected A/,
  );
  const frozen = selectionProblems({
    ...base,
    placed: [{ label: "c1", file: "projects/demo/assets/sfx/library/a.wav" }],
  });
  assert.deepEqual(frozen.problems, []);
  assert.match(frozen.advisories[0]!, /compared 1 candidate/);
  assert.deepEqual(selectionProblems({ ...base, sheet: sheet([{ frame: 10, kind: "cut", sfx: "whoosh" }]) }), {
    problems: [],
    advisories: [],
  });
});

// --- 2. Coverage measures each cue's lead from the placed sounds ---

test("cut-sound-coverage reads the placed sound's measured lead instead of the family constant", () => {
  const cues = sheet([
    { frame: 300, kind: "transition", sfx: "riser" },
    { frame: 600, kind: "cut", sfx: "whoosh" },
  ]);
  // A 6 s riser: its attack starts 6 s before the cue, beyond the 4 s constant.
  const placed = {
    fps: 30,
    events: [
      { cueFrame: 300, startFrame: 120, onsetSec: 0 },
      { cueFrame: 600, startFrame: 597, onsetSec: 0 },
    ],
  };
  assert.equal(measuredLeadSec(placed, 10, 30), 6);
  assert.equal(measuredLeadSec(placed, 20, 30), 0.1);
  assert.equal(measuredLeadSec(placed, 15, 30), undefined);
  // Onsets: the riser's start at 4 s, and a music hit 0.5 s before the whoosh cue (not the whoosh).
  const onsetsSec = [4, 19.5];
  const fallback = cutSoundCoverageLeg({ cueSheet: cues, onsetsSec, fps: 30 });
  assert.equal(fallback.status, "warn");
  assert.match(fallback.evidence.join(" "), /c1: cue 300, lead 4 s \(default\)/);
  const measured = cutSoundCoverageLeg({ cueSheet: cues, onsetsSec, fps: 30, soundCues: placed });
  assert.equal(measured.status, "warn");
  assert.match(measured.message, /2 measured from the placed sounds/);
  // The riser is now covered; the whoosh is not, because the 19.5 s onset is outside its measured 0.1 s lead.
  assert.deepEqual(
    measured.evidence.map((line) => line.split(":")[0]),
    ["c2"],
  );
  const covered = cutSoundCoverageLeg({ cueSheet: cues, onsetsSec: [4, 19.92], fps: 30, soundCues: placed });
  assert.equal(covered.status, "pass");
});

// --- 5. Saved audits reach film:measure and the critic, never run Earshot ---

test("saved audits are read by the file's current bytes; other bytes and malformed reports are ignored", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "earshot-reviews-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = (sha256: string, ok: boolean, warnings: string[]) =>
    JSON.stringify({
      engine: "earshot",
      advisory: true,
      source: { file: "x.wav", sha256 },
      result: { ok, warnings: warnings.map((code) => ({ code, msg: code })), notes: [] },
    });
  writeFileSync(path.join(dir, `${SHA(1)}.json`), report(SHA(1), true, []));
  writeFileSync(path.join(dir, `${SHA(2)}.json`), report(SHA(2), false, ["clicks"]));
  writeFileSync(path.join(dir, `${SHA(3)}.json`), report(SHA(7), true, []));
  writeFileSync(path.join(dir, `${SHA(4)}.json`), "{not json");
  const hashes: Record<string, string> = {
    "a.wav": SHA(1),
    "b.wav": SHA(2),
    "c.wav": SHA(3),
    "d.wav": SHA(4),
    "e.wav": SHA(5),
  };
  const rows = readSoundReviews(
    ["a.wav", "b.wav", "c.wav", "d.wav", "e.wav", "a.wav", "gone.wav"],
    dir,
    (file) => hashes[file],
  );
  assert.deepEqual(
    rows.map((row) => [row.file, row.review?.ok ?? null, row.review?.warnings ?? null]),
    [
      ["a.wav", true, []],
      ["b.wav", false, ["clicks"]],
      ["c.wav", null, null],
      ["d.wav", null, null],
      ["e.wav", null, null],
    ],
  );
  assert.equal(reviewDirOf("public/projects/demo"), path.join("public/projects/demo", "pipeline", "audio-review"));
});

test("sfx-evidence is advisory: skipped without placed sounds or audits, warns on flags and gaps, never fails", () => {
  assert.equal(sfxEvidenceLeg(undefined).status, "skipped");
  assert.equal(sfxEvidenceLeg([{ file: "a.wav", sha256: SHA(1) }]).status, "skipped");
  const clean = { file: "a.wav", sha256: SHA(1), review: { ok: true, warnings: [], notes: [], report: "r" } };
  assert.equal(sfxEvidenceLeg([clean]).status, "pass");
  const leg = sfxEvidenceLeg([
    clean,
    { file: "b.wav", sha256: SHA(2), review: { ok: false, warnings: ["truncated"], notes: ["tail"], report: "r" } },
    { file: "c.wav", sha256: SHA(3) },
  ]);
  assert.equal(leg.status, "warn");
  assert.equal(leg.value, 0.667);
  assert.deepEqual(leg.evidence, ["b.wav: truncated, tail (note)", "c.wav: no saved audit"]);
});

// --- 3. The reference's sound map ---

test("sfx:map keeps strong and plausible events, gives an overlap to the higher z, and summarises density and gaps", () => {
  const seg = (start: number, end: number, z: number, verdict = "strong") => ({
    start,
    end,
    z,
    verdict,
    peak_dbfs: -6,
  });
  const map = SfxMapSchema.parse(
    assembleSfxMap({
      source: { file: "ref.mp4", sha256: SHA(1), durationSec: 60 },
      analysedRange: { startSec: 0, endSec: 60 },
      modelRevision: "m",
      packageSha: "p",
      found: [
        { kind: "whoosh", segments: [seg(1, 1.6, 3.4), seg(10, 10.5, 2.6, "plausible"), seg(30, 30.4, 2.1, "weak")] },
        // The same sound at 10 s read as an impact, more strongly: the impact keeps it.
        { kind: "impact", segments: [seg(10.1, 10.6, 3.1), seg(50, 51, 2.0, "weak")] },
        { kind: "riser", segments: [] },
      ],
    }),
  );
  assert.deepEqual(
    map.events.map((event) => [event.kind, event.startSec]),
    [
      ["whoosh", 1],
      ["impact", 10.1],
    ],
  );
  assert.deepEqual(map.summary.byKind, { whoosh: { count: 1, perMinute: 1 }, impact: { count: 1, perMinute: 1 } });
  assert.equal(map.summary.perMinute, 2);
  assert.deepEqual(map.summary.longestGaps[0], { startSec: 10.6, endSec: 60, durationSec: 49.4 });
  assert.equal(map.queries["riser"], SFX_MAP_QUERIES.riser);

  const ours = placedDensity([{ sfx: "hit" }, { sfx: "tick", layerOf: "x" }, { sfx: "whoosh" }, { sfx: "whoosh" }], 30);
  assert.deepEqual(ours, { events: 3, perMinute: 6, byKind: { impact: 2, whoosh: 4 } });
  const side = sfxDensityComparison(map, [{ sfx: "whoosh" }], 60);
  assert.deepEqual(side.perMinute, { reference: 2, ours: 1 });
  assert.deepEqual(side.byKind["impact"], { reference: 1, ours: 0 });
});
