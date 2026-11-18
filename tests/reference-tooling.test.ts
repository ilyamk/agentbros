import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { judgedCutTimes } from "../src/lib/film/targets";
import { rgbToLab, sampleFilm } from "../src/lib/reference/align";
import { blueprintLeaks, stem } from "../src/lib/reference/blueprint-content";
import { correctedShots } from "../src/lib/reference/corrected";
import {
  bezierFamily,
  buildCorpus,
  easeFamilyKey,
  normaliseEaseName,
  techniqueEaseFamilies,
} from "../src/lib/reference/corpus";
import { correctionWarnings, tempoDisagrees, validateReference } from "../src/lib/reference/library";
import { shotColour } from "../src/lib/reference/look";
import { suspectFitReasons } from "../src/lib/reference/motion";
import { phaseSlips } from "../src/lib/reference/sync";
import { buildShotSheet } from "../src/lib/vision/sheets";
import { probeVideo } from "../src/lib/vision/media";
import {
  primitiveKind,
  ReferenceBlueprintSchema,
  ReferenceEditSchema,
  ReferenceSpeechTextSchema,
  ReferenceTechniquesSchema,
  ShotCameraSchema,
  type ReferenceShots,
} from "../src/types/reference";

const repo = path.resolve(import.meta.dirname, "..");
const library = path.join(repo, "tests/fixtures/reference-corpus");

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "reference-tooling-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

const claimed = <T>(value: T) => ({ value, basis: "observed" as const, confidence: 0.9, evidence: [] });
const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const write = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const shots: ReferenceShots = {
  schemaVersion: 1,
  referenceId: "x",
  detector: { name: "fixture", params: {} },
  shots: [
    { id: "s001", startSec: 0, endSec: 2, transitionIn: "unknown", transitionConfidence: 0 },
    { id: "s002", startSec: 2, endSec: 5, transitionIn: "cut", transitionConfidence: 1 },
    { id: "s003", startSec: 5, endSec: 8, transitionIn: "cut", transitionConfidence: 1 },
  ],
  candidates: [],
  summary: { count: 3, medianDurationSec: 3, cutsPerMinute: 15 },
};

const edit = (corrections: unknown[]) =>
  ReferenceEditSchema.parse({
    schemaVersion: 1,
    referenceId: "x",
    rhythm: claimed("r"),
    shots: [],
    corrections: corrections.map(claimed),
  });

test("a move correction shifts a cut in both appliers; shotId is shorthand and toSec is required", () => {
  const moved = edit([{ kind: "move", shotId: "s003", toSec: 5.4, note: "The real cut is four frames later." }]);
  assert.deepEqual(moved.corrections[0]!.value.shotIds, ["s003"]);
  const corrected = correctedShots(shots, moved);
  assert.deepEqual(
    corrected.map((shot) => [shot.id, shot.startSec, shot.endSec]),
    [
      ["s001", 0, 2],
      ["s002", 2, 5.4],
      ["s003", 5.4, 8],
    ],
  );
  assert.deepEqual(judgedCutTimes(shots, moved), [2, 5.4]);
  // A move that crosses another cut reorders cleanly.
  assert.deepEqual(judgedCutTimes(shots, edit([{ kind: "move", shotIds: ["s002"], toSec: 6, note: "x" }])), [5, 6]);
  // With a split in the same shot, the moved cut and the split both stand.
  assert.deepEqual(
    judgedCutTimes(
      shots,
      edit([
        { kind: "move", shotId: "s003", toSec: 5.4, note: "x" },
        { kind: "split", shotIds: ["s003"], timeSec: 6.5, note: "y" },
      ]),
    ),
    [2, 5.4, 6.5],
  );
  assert.equal(
    ReferenceEditSchema.safeParse({
      ...moved,
      corrections: [claimed({ kind: "move", shotId: "s003", note: "no time" })],
    }).success,
    false,
  );
  assert.equal(
    ReferenceEditSchema.safeParse({ ...moved, corrections: [claimed({ kind: "split", timeSec: 3, note: "no shot" })] })
      .success,
    false,
  );
  // Older files: shotIds on every kind, unchanged.
  assert.deepEqual(judgedCutTimes(shots, edit([{ kind: "merge", shotIds: ["s002", "s003"], note: "one" }])), [2]);
});

test("ref:validate warns about corrections that do nothing or name the wrong shot", () => {
  const warnings = correctionWarnings(
    shots,
    edit([
      { kind: "split", shotIds: ["s002"], note: "no time" },
      { kind: "split", shotIds: ["s002"], timeSec: 6, note: "wrong shot" },
      { kind: "split", shotIds: ["s003"], timeSec: 6, note: "fine" },
      { kind: "move", shotId: "s003", toSec: 9, note: "past the end" },
      { kind: "reject", shotIds: ["s099"], note: "unknown" },
    ]),
  );
  assert.equal(warnings.length, 4, JSON.stringify(warnings));
  assert.match(warnings[0]!, /without timeSec/);
  assert.match(warnings[1]!, /6 lies outside s002/);
  assert.match(warnings[2]!, /toSec 9 is outside the film/);
  assert.match(warnings[3]!, /no shot s099/);
});

test("techniques take occurrences, shot ranges, ease phases, new sound kinds and per-role typography; old files still parse", () => {
  const old = json(path.join(library, "alpha/techniques.json"));
  ReferenceTechniquesSchema.parse(old);
  const base = (old.techniques as Record<string, unknown>[])[0]!;
  const typed = {
    ...base,
    shots: ["s004.1", "s004.2", "s005"],
    occurrences: [
      { span: { startSec: 0, endSec: 1.5 }, fromShot: 0, toShot: 1, timing: { durationSec: 0.4 } },
      { span: { startSec: 9, endSec: 10 }, shots: ["s003", "s004"] },
    ],
    ease: {
      source: "strip",
      phases: [
        { part: "exit", name: "power2.in" },
        { part: "entry", cubicBezier: [0.2, 0.8, 0.3, 1] },
      ],
      truncated: true,
    },
    sound: { kind: "music-bed", timingBasis: "measured", sourceBasis: "inferred" },
    typography: [
      { role: "headline", alignment: "split-edges", size: 0.12 },
      { role: "label", alignment: "free" },
    ],
  };
  const parsed = ReferenceTechniquesSchema.parse({ ...old, techniques: [typed] }).techniques[0]!;
  assert.equal(parsed.occurrences?.length, 2);
  assert.deepEqual(
    techniqueEaseFamilies(parsed.ease!).map((family) => family.family),
    ["in", "out"],
  );
  assert.equal(
    ReferenceTechniquesSchema.safeParse({ ...old, techniques: [{ ...typed, sound: { kind: "unknown" } }] }).success,
    true,
  );
  assert.equal(
    ReferenceTechniquesSchema.safeParse({
      ...old,
      techniques: [
        {
          ...typed,
          sound: { kind: "dip", confidence: 0.6 },
          timing: { durationSec: 0.3, confidence: 0.9 },
          ease: { source: "strip", name: "expo.out", confidence: 0.5 },
        },
      ],
    }).success,
    true,
  );
  assert.equal(
    ReferenceTechniquesSchema.safeParse({
      ...old,
      techniques: [{ ...typed, timing: { durationSec: 0.3, confidence: 1.5 } }],
    }).success,
    false,
    "confidence is 0 to 1",
  );
  for (const transition of ["iris", "morph", "bleach"])
    assert.equal(
      correctedShots(shots, edit([{ kind: "retype", shotIds: ["s002"], transition, note: "x" }]))[1]!.transitionIn,
      transition,
    );
  assert.equal(
    ReferenceTechniquesSchema.safeParse({ ...old, techniques: [{ ...typed, typography: { alignment: "diagonal" } }] })
      .success,
    false,
  );
  assert.equal(
    ReferenceTechniquesSchema.safeParse({ ...old, techniques: [{ ...typed, typography: { size: 1.5 } }] }).success,
    false,
    "size is a share of the frame height",
  );
  assert.equal(
    ReferenceTechniquesSchema.safeParse({
      ...old,
      techniques: [{ ...typed, ease: { source: "strip", phases: [{ part: "middle" }] } }],
    }).success,
    false,
  );
  const editFile = json(path.join(library, "alpha/edit.json"));
  const moves = editFile.signatureMoves as { value: Record<string, unknown> }[];
  ReferenceEditSchema.parse({
    ...editFile,
    signatureMoves: [
      {
        ...moves[0],
        value: {
          ...moves[0]!.value,
          spans: [
            { startSec: 4.8, endSec: 5.2 },
            { startSec: 14.8, endSec: 15.2 },
          ],
        },
      },
    ],
  });
});

test("ease names normalise to families with a strength", () => {
  const cases: [string, string][] = [
    ["power2.out", "out:2"],
    ["expo.out", "out:5"],
    ["circ.in", "in:3"],
    ["sine.in", "in:0.5"],
    ["power2.inOut", "inOut:2"],
    ["none", "linear"],
    ["linear", "linear"],
    ["steps(5)", "steps:5"],
    ["steps", "steps"],
    ["hold", "steps"],
    ["back.out", "out:2"],
    ["spring(mass 1, stiffness 120, damping 14)", "spring"],
    ["spring(120, 14)", "spring"],
    ["cubic-bezier(0.2, 0.8, 0.3, 1)", "out"],
    ["cubic-bezier(0.6, 0, 0.9, 0.4)", "in"],
    ["cubic-bezier(0.65, 0, 0.35, 1)", "inOut"],
    ["ease-in-out", "inOut"],
    ["power2.in (exit); power2.out (entry)", "in:2"],
    ["none (linear letter cadence)", "linear"],
    ["wobbly", "unknown"],
  ];
  for (const [name, key] of cases) assert.equal(easeFamilyKey(normaliseEaseName(name)), key, name);
  assert.equal(bezierFamily([0, 0, 1, 1]), "linear");
  assert.equal(bezierFamily([1.4, 0, 0.2, 1]), "unknown");
});

test("requiredPrimitives prefixes: only missing: counts as a gap", (t) => {
  assert.deepEqual(primitiveKind("remotion:interpolate"), { kind: "remotion", name: "interpolate" });
  assert.deepEqual(primitiveKind("block:ground-swap-cut"), { kind: "block", name: "ground-swap-cut" });
  assert.deepEqual(primitiveKind("library:texture-overlay"), { kind: "block", name: "texture-overlay" });
  assert.deepEqual(primitiveKind("missing: Foo, which does x"), { kind: "missing", name: "Foo, which does x" });
  assert.deepEqual(primitiveKind("RegionCamera"), { kind: "repo", name: "RegionCamera" });
  assert.deepEqual(primitiveKind("texture-overlay (library block)"), {
    kind: "repo",
    name: "texture-overlay (library block)",
  });

  const root = workspace(t);
  cpSync(path.join(library, "alpha"), path.join(root, "alpha"), { recursive: true });
  const file = path.join(root, "alpha/techniques.json");
  const techniques = json(file) as { techniques: { requiredPrimitives: string[] }[] };
  techniques.techniques[0]!.requiredPrimitives = [
    "remotion:spring",
    "block:hero-word",
    "missing: Bar-Baz, a new thing",
    "missing:foo-bar",
  ];
  write(file, techniques);
  assert.deepEqual(
    buildCorpus({ libraryRoot: root }).gaps.missingPrimitives.map((row) => row.name),
    ["bar-baz", "foo-bar"],
  );
});

test("the corpus groups eases by family and leaves out fits across a judged cut or marked suspect", (t) => {
  const root = workspace(t);
  cpSync(path.join(library, "alpha"), path.join(root, "alpha"), { recursive: true });
  const corpus = buildCorpus({ libraryRoot: root });
  assert.deepEqual(corpus.easeFamilies, { motion: { "out:2": 1 }, techniques: { "out:2": 1 } });
  assert.deepEqual(corpus.excludedEaseFits, []);
  assert.equal(corpus.techniques.byFunction.hook![0]!.easeFamily, "out");

  // A split the analyst found at 1 s falls inside the fitted push (0.2-2 s): the fit spans a hidden cut.
  const motionFile = path.join(root, "alpha/motion.json");
  const motion = json(motionFile) as { shots: { camera: Record<string, unknown> }[] };
  Object.assign(motion.shots[0]!.camera, { startSec: 0.2, endSec: 2, durationSec: 1.8 });
  write(motionFile, motion);
  const editFile = path.join(root, "alpha/edit.json");
  const editJson = json(editFile) as { corrections: unknown[] };
  editJson.corrections.push(
    claimed({ kind: "split", shotIds: ["s001"], timeSec: 1, transition: "cut", note: "A text swap." }),
  );
  write(editFile, editJson);
  const split = buildCorpus({ libraryRoot: root });
  assert.deepEqual(split.easeNames, {});
  assert.deepEqual(split.excludedEaseFits, [
    { refId: "alpha", shotId: "s001", ease: "power2.out", reason: "spans the judged cut at 1 s" },
  ]);

  // A fit marked suspect in motion.json is left out too.
  editJson.corrections.pop();
  write(editFile, editJson);
  Object.assign(motion.shots[0]!.camera, { suspect: true, suspectReasons: ["element motion"] });
  write(motionFile, motion);
  assert.match(buildCorpus({ libraryRoot: root }).excludedEaseFits![0]!.reason, /^suspect: element motion/);
});

test("suspect camera fits: poor fit, degenerate curve, untracked frames, a move longer than its shot", () => {
  const camera = ShotCameraSchema.parse(
    (json(path.join(library, "alpha/motion.json")).shots as { camera: unknown }[])[0]!.camera,
  );
  assert.deepEqual(suspectFitReasons(camera, { startSec: 0, endSec: 5 }), []);
  const ease = camera.ease!;
  assert.deepEqual(suspectFitReasons({ ...camera, ease: { ...ease, gsapRmse: 0.3 } }), ["fit error 0.3 above 0.1"]);
  assert.deepEqual(suspectFitReasons({ ...camera, ease: { ...ease, cubicBezier: [1.3, 0, 0.2, 1] } }), [
    "degenerate bezier",
  ]);
  assert.match(suspectFitReasons({ ...camera, trackedShare: 0.3 })[0]!, /element motion/);
  assert.match(
    suspectFitReasons({ ...camera, durationSec: 2 }, { startSec: 0, endSec: 1 })[0]!,
    /fitted 2 s in a 1 s shot/,
  );
});

test("the blueprint check matches the film's words by stem and ignores everyday words, schema words, technique ids and referenceId", () => {
  assert.equal(stem("Portals"), stem("portal"));
  const speechText = ReferenceSpeechTextSchema.parse({
    schemaVersion: 1,
    referenceId: "acme-film",
    speech: {
      available: true,
      words: [
        { startSec: 0, endSec: 0.3, text: "Meet" },
        { startSec: 0.3, endSec: 0.6, text: "Zorblax," },
        { startSec: 0.6, endSec: 0.9, text: "the" },
        { startSec: 0.9, endSec: 1.2, text: "style" },
        { startSec: 1.2, endSec: 1.5, text: "broker" },
      ],
    },
    screenText: {
      available: true,
      items: [
        { startSec: 1, endSec: 2, text: "Your broker portals, sorted", confidence: 0.9 },
        { startSec: 3, endSec: 4, text: "slam", confidence: 0.9 },
      ],
    },
  });
  const blueprint = ReferenceBlueprintSchema.parse({
    schemaVersion: 1,
    referenceId: "acme-film",
    format: { width: 1080, height: 1920, fps: 30 },
    durationSec: 4,
    slots: [
      {
        id: "hook",
        role: "Name the Zorblax brand",
        startSec: 0,
        durationSec: 4,
        visualRecipe: "Brokers' portal grid on white; the slam word centred.",
        motionRecipe: "power2.out over 8 frames",
        soundRecipe: "hit on the cut",
        techniqueIds: ["hero-word-slam"],
      },
    ],
    rhythm: { cutGrid: "every beat" },
    style: "Flat style, the acme-film look.",
    transferRules: { keep: ["the slam"], mustChange: ["brand"] },
  });
  const leaks = blueprintLeaks(blueprint, speechText, { schemaVersion: 1, referenceId: "acme-film", techniques: [] });
  assert.deepEqual(leaks, [
    { word: "zorblax", kind: "name", where: ["slots[0].role"] },
    { word: "brokers", kind: "word", where: ["slots[0].visualRecipe"] },
    { word: "portal", kind: "word", where: ["slots[0].visualRecipe"] },
  ]);
  assert.deepEqual(blueprintLeaks(blueprint, undefined), [], "no speech-text layer, nothing to compare");
});

test("ref:validate reports blueprint leaks and tempo disagreement as warnings, not failures", (t) => {
  const root = workspace(t);
  const directory = path.join(root, "alpha");
  cpSync(path.join(library, "alpha"), directory, { recursive: true });
  write(path.join(directory, "blueprint.json"), {
    schemaVersion: 1,
    referenceId: "alpha",
    format: { width: 1920, height: 1080, fps: 30 },
    durationSec: 30,
    slots: [
      {
        id: "s",
        role: "Say Hello to the World",
        startSec: 0,
        durationSec: 30,
        visualRecipe: "v",
        motionRecipe: "m",
        soundRecipe: "s",
      },
    ],
    rhythm: { cutGrid: "free" },
    style: "plain",
    transferRules: { keep: [], mustChange: [] },
  });
  write(path.join(directory, "audiomap.json"), { tempo: { bpm: 163 } });
  const audio = json(path.join(directory, "audio.json")) as { tempo?: { bpm: number } };
  const report = validateReference(directory);
  assert.equal(report.invalid.length, 0, JSON.stringify(report.invalid));
  assert.deepEqual(
    report.blueprintLeaks.map((leak) => leak.word),
    ["hello", "world"],
  );
  assert.ok(
    report.warnings.some((warning) => /everyday words.*hello, world/.test(warning)),
    JSON.stringify(report.warnings),
  );
  if (audio.tempo)
    assert.equal(
      report.warnings.some((warning) => /audiomap\.json 163 BPM/.test(warning)),
      tempoDisagrees(audio.tempo.bpm, 163),
    );
  assert.equal(tempoDisagrees(127.6, 163), true);
  assert.equal(tempoDisagrees(120, 240), false, "double time");
  assert.equal(tempoDisagrees(120, 180), false, "3:2");
  assert.equal(tempoDisagrees(120, 126), false, "within 10%");
});

test("a beat grid sliding against the onsets is warned about, a steady one is not", () => {
  const beats = Array.from({ length: 24 }, (_, index) => index * 0.5);
  const steady = beats.map((beat) => beat + 0.01);
  assert.deepEqual(phaseSlips(beats, steady, [], 12), []);
  const sliding = beats.map((beat, index) => beat + 0.012 * index);
  const warnings = phaseSlips(beats, sliding, [{ startSec: 0, endSec: 12, label: "verse" }], 12);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /phase slips 0\.\d+ s .* verse.*run ahead/);
});

test("neutral grey and black frames read a = b = 0", (t) => {
  for (const value of [0, 1, 128, 200, 255]) {
    const [, a, b] = rgbToLab(value, value, value);
    assert.ok(Math.abs(a) < 0.02 && Math.abs(b) < 0.02, `${value}: ${a} ${b}`);
  }
  const root = workspace(t);
  const film = path.join(root, "neutral.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x808080:s=64x36:r=30:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=64x36:r=30:d=1",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv444p[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-qp",
    "0",
    film,
  ]);
  const samples = sampleFilm(film, probeVideo(film));
  for (const span of [
    { startSec: 0, endSec: 1 },
    { startSec: 1, endSec: 2 },
  ]) {
    const colour = shotColour(samples, span);
    assert.equal(colour.a, 0, JSON.stringify(colour));
    assert.equal(colour.b, 0, JSON.stringify(colour));
    assert.deepEqual([colour.percentiles.a[1], colour.percentiles.b[1]], [0, 0]);
  }
});

test("a one-frame last shot still draws on the contact sheet", (t) => {
  const root = workspace(t);
  const film = path.join(root, "short.mp4");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=64x36:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", film]);
  const info = probeVideo(film);
  const last = (info.frameCount - 1) / info.fps;
  // The source's duration can run a frame past the copy's decoded frames: the last shot starts at or after the final frame.
  const { shots: report } = buildShotSheet(film, info, [
    { startSec: 0, endSec: last },
    { startSec: last, endSec: last + 1 / info.fps },
    { startSec: info.frameCount / info.fps, endSec: info.frameCount / info.fps + 0.01 },
  ]);
  assert.ok(
    report.at(-1)!.frames.every((row) => row.frame === info.frameCount - 1),
    JSON.stringify(report.at(-1)),
  );
  assert.throws(() => buildShotSheet(film, info, [{ startSec: 0.5, endSec: 0.5 }]), /selects no frames/);
});
