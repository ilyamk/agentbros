import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  gatherEvidence,
  gridChangedShare,
  laplacianVariance,
  parseLoudnessLog,
  sharpnessStep,
  type FilmEvidence,
} from "../src/lib/film/evidence";
import { FAST_SHARP_MAX, measureFilm, measureRender, MOTION_SPREAD_MAX } from "../src/lib/film/measure";
import { readRenderOnsets } from "../src/lib/film/cut-sound";
import {
  classifyBoundary,
  checkPlan,
  FILM_GATE_DIMENSIONS,
  normaliseTreatment,
  requiredReadingSec,
  SLOP_PLAN_DIMENSIONS,
  UNSCORED_PLAN_DIMENSIONS,
} from "../src/lib/film/plan-check";
import {
  audioAnchors,
  beatAnchors,
  changeSpikesAt,
  frozenSpans,
  readAnchors,
  readCues,
  readFastSharp,
  readMotionSpread,
  readShots,
  softBoundaryShare,
} from "../src/lib/film/readings";
import {
  CORPUS_LOUDNESS_SLACK,
  CORPUS_PACE_SLACK,
  CORPUS_VARIETY_SHARE,
  cutCrossCheck,
  judgedCutTimes,
  parseRange,
  targetsFromCorpus,
  targetsFromEvidence,
} from "../src/lib/film/targets";
import type { ReferenceCorpus } from "../src/types/reference";
import { matchingTimes, windowsAround } from "../src/lib/film/critic-pack";
import { MotionPlanSchema } from "../src/types/creative";
import { AudioMapSchema, CueSheetSchema, FilmMeasureSchema, FilmTargetsSchema, type CueSheet } from "../src/types/film";

const repo = path.resolve(import.meta.dirname, "..");
const tsx = path.join(repo, "node_modules/tsx/dist/cli.mjs");
const fixtures = path.join(repo, "tests/fixtures/film");
const fixture = (name: string) => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));

function workspace(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "film-sensors-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function ffmpeg(args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** Shots of flat colour with a moving box, so a shot's picture never freezes. Lengths in seconds. */
function film(file: string, lengths: number[], options: { audio?: "tone" | "silent"; frozen?: boolean } = {}) {
  const colours = ["red", "blue", "green", "yellow", "white", "purple", "orange", "cyan"];
  const inputs: string[] = [];
  const parts: string[] = [];
  lengths.forEach((length, index) => {
    inputs.push("-f", "lavfi", "-i", `color=c=${colours[index % colours.length]}:s=320x180:r=30:d=${length}`);
    const box = options.frozen ? "" : `,drawbox=x='mod(n*12\\,280)':y=60:w=40:h=40:color=black:t=fill`;
    parts.push(
      `[${index}:v]format=yuv420p,setsar=1${box.replace("x='mod(n*12\\,280)'", `x=${(index * 40) % 280}`)}[v${index}]`,
    );
  });
  // A slow drift, clipped: geq wraps past 255, and a quarter-cycle a frame turned bright shots into a 7.5 Hz strobe (FLASH_RISK).
  const moving = options.frozen ? "" : ",geq=lum='clip(lum(X,Y)+40*sin((X+N*3)/9),16,235)':cb='cb(X,Y)':cr='cr(X,Y)'";
  const chain = `${parts.join(";")};${lengths.map((_, index) => `[v${index}]`).join("")}concat=n=${lengths.length}:v=1:a=0${moving}[out]`;
  const duration = lengths.reduce((sum, length) => sum + length, 0);
  const audio =
    options.audio === "tone"
      ? ["-f", "lavfi", "-i", `sine=frequency=220:duration=${duration}`]
      : options.audio === "silent"
        ? ["-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${duration}`]
        : [];
  const audioIndex = lengths.length;
  ffmpeg([
    ...inputs,
    ...audio,
    "-filter_complex",
    chain,
    "-map",
    "[out]",
    ...(audio.length ? ["-map", `${audioIndex}:a`, "-c:a", "aac", "-t", String(duration)] : []),
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    file,
  ]);
}

function runCli(script: string, args: string[]) {
  const child = spawnSync(process.execPath, [tsx, path.join(repo, "scripts", script), ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME },
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `stdout must be one JSON line: ${child.stdout} ${child.stderr}`);
  return { status: child.status, json: JSON.parse(lines[0]!) };
}

const leg = (measure: ReturnType<typeof measureFilm>, id: string) => {
  const found = measure.legs.find((row) => row.id === id);
  assert.ok(found, `no leg ${id}`);
  return found;
};

const POLYMARKET = () => FilmTargetsSchema.parse(fixture("polymarket-targets.json"));

/** Evidence with a known shape, for the rules that do not need pixels. */
function syntheticEvidence(cuts: number[], durationSec: number, overrides: Partial<FilmEvidence> = {}): FilmEvidence {
  const motion = Array.from({ length: Math.floor(durationSec * 10) - 1 }, (_, index) => ({
    timeSec: (index + 1) / 10,
    energy: 3,
    changed: 0.05,
  }));
  return {
    schemaVersion: 3,
    sha256: "a".repeat(64),
    path: "x.mp4",
    video: {
      width: 1920,
      height: 1080,
      fps: 30,
      frameCount: Math.round(durationSec * 30),
      durationSec,
      hasAudio: true,
    },
    detector: "test",
    boundaries: cuts.map((timeSec) => ({
      timeSec,
      startSec: timeSec,
      endSec: timeSec,
      kind: "cut",
      confidence: 0.9,
      measures: { engines: 2, changedFraction: 0.9 },
    })),
    candidateCount: 0,
    motion,
    audio: {
      integratedLufs: -14,
      loudnessRangeLu: 5,
      truePeakDb: -1.5,
      perSecond: Array.from({ length: Math.ceil(durationSec) }, (_, index) => ({ timeSec: index, lufs: -14 })),
      silences: [],
    },
    ...overrides,
  };
}

const varied = (duration: number) => {
  const pattern = [0.5, 1.5, 0.8, 2.4, 0.4, 1.1, 3, 0.7];
  const cuts: number[] = [];
  let at = 0;
  for (let index = 0; at < duration - 3; index++) {
    at += pattern[index % pattern.length]!;
    cuts.push(Number(at.toFixed(2)));
  }
  return cuts;
};

// --- Whole videos ---

test("a uniform silent slideshow fails, naming audio and cadence", (t) => {
  const root = workspace(t);
  const file = path.join(root, "slideshow.mp4");
  film(file, [2, 2, 2, 2, 2, 2, 2, 2]);
  const evidence = gatherEvidence(file);
  const measure = FilmMeasureSchema.parse(measureFilm({ evidence }));
  assert.equal(measure.verdict, "fail");
  assert.equal(leg(measure, "audio-present").status, "fail");
  assert.match(leg(measure, "audio-present").fix!, /--audio/);
  assert.equal(leg(measure, "shot-length-variety").status, "fail");
  assert.match(leg(measure, "shot-length-variety").fix!, /uniform/);
  assert.ok(Math.abs(leg(measure, "shot-length-median").value! - 2) < 0.15);
});

test("a varied film with sound passes against targets taken from itself, and a slideshow fails against them", (t) => {
  const root = workspace(t);
  const variedFile = path.join(root, "varied.mp4");
  const slideshow = path.join(root, "slideshow.mp4");
  film(variedFile, [0.6, 1.8, 0.8, 3, 0.5, 1.2, 2.2, 0.7, 1.5, 0.9], { audio: "tone" });
  film(slideshow, [3, 3, 3, 3, 3], { audio: "tone" });
  const evidence = gatherEvidence(variedFile);
  assert.ok(evidence.boundaries.length >= 7, `detector found ${evidence.boundaries.length} cuts`);
  const targets = targetsFromEvidence({ evidence, referenceId: "varied" });
  const own = measureFilm({ evidence, targets });
  assert.equal(own.verdict, "pass", JSON.stringify(own.legs.filter((row) => row.status === "fail")));
  assert.equal(leg(own, "audio-not-silent-throughout").status, "pass");
  const other = measureFilm({ evidence: gatherEvidence(slideshow), targets });
  assert.equal(other.verdict, "fail");
  assert.equal(leg(other, "shot-length-median").status, "fail");
  assert.equal(leg(other, "cuts-per-minute").status, "fail");
});

test("a cue sheet cannot claim a pace the picture does not have", (t) => {
  const root = workspace(t);
  const file = path.join(root, "slow.mp4");
  film(file, [3, 3, 3, 3, 3], { audio: "tone" });
  const evidence = gatherEvidence(file);
  const invented = Array.from({ length: 17 }, (_, index) => ({
    id: `c${index}`,
    kind: "cut" as const,
    intentSec: (index + 1) * 0.8,
    snap: "none" as const,
    snappedSec: (index + 1) * 0.8,
    frame: (index + 1) * 24,
    deltaSec: 0,
  }));
  const cueSheet = CueSheetSchema.parse({
    schemaVersion: 1,
    fps: 30,
    audioMapPath: "x",
    musicOffsetSec: 0,
    cues: invented,
  });
  const measure = measureFilm({ evidence, cueSheet, targets: POLYMARKET() });
  assert.equal(leg(measure, "cue-sheet-drift").status, "fail");
  assert.equal(leg(measure, "shot-length-median").status, "fail");
  assert.ok(leg(measure, "shot-length-median").value! >= 2.4, String(leg(measure, "shot-length-median").value));
});

test("a flat swap on a still ground spikes, and steady motion does not", () => {
  const still = syntheticEvidence([], 10).motion.map((row) => ({ ...row, changed: row.timeSec === 5 ? 0.01 : 0 }));
  assert.equal(changeSpikesAt(still, 5), true);
  assert.equal(changeSpikesAt(still, 7), false);
  const busy = syntheticEvidence([], 10).motion;
  assert.equal(changeSpikesAt(busy, 5), false);
});

test("no targets fails the measure: a slideshow with sound cannot pass by skipping film:targets", () => {
  const measure = measureFilm({ evidence: syntheticEvidence([2, 4, 6, 8, 10, 12, 14, 16], 18) });
  assert.equal(measure.verdict, "fail");
  assert.equal(leg(measure, "targets-present").status, "fail");
  assert.match(leg(measure, "targets-present").fix!, /film:targets/);
  assert.equal(
    leg(measureFilm({ evidence: syntheticEvidence(varied(30), 30), targets: POLYMARKET() }), "targets-present").status,
    "pass",
  );
});

test("a silent soundtrack is not a soundtrack", (t) => {
  const root = workspace(t);
  const file = path.join(root, "silent.mp4");
  film(file, [1, 2, 1, 3, 1, 2], { audio: "silent" });
  const measure = measureFilm({ evidence: gatherEvidence(file) });
  assert.equal(leg(measure, "audio-present").status, "pass");
  assert.equal(leg(measure, "audio-not-silent-throughout").status, "fail");
});

test("a frozen stretch is listed with its times and fails a tight target", (t) => {
  const root = workspace(t);
  const file = path.join(root, "frozen.mp4");
  film(file, [2, 3, 2], { audio: "tone", frozen: true });
  const evidence = gatherEvidence(file);
  const spans = frozenSpans(evidence.motion);
  assert.ok(spans.length >= 2);
  assert.ok(spans.some((span) => span.endSec - span.startSec > 2));
  const targets = FilmTargetsSchema.parse({ ...POLYMARKET(), longestStillSec: { max: 1 }, stillShare: { max: 0.1 } });
  const measure = measureFilm({ evidence, targets });
  assert.equal(leg(measure, "longest-still").status, "fail");
  assert.equal(leg(measure, "still-share").status, "fail");
  assert.ok(leg(measure, "longest-still").fix!.includes("s"));
  assert.ok(measure.frozenSpans.length >= 2);
});

test("film:measure writes one line, exits non-zero on failure and carries the report; film:targets --manual demands a reason", (t) => {
  const root = workspace(t);
  const file = path.join(root, "slideshow.mp4");
  film(file, [2, 2, 2, 2, 2, 2]);
  const failed = runCli("film-measure.ts", [
    "--render",
    file,
    "--targets",
    path.join(fixtures, "polymarket-targets.json"),
    "--output",
    path.join(root, "measure.json"),
  ]);
  assert.equal(failed.status, 1);
  assert.equal(failed.json.error, "VALIDATION");
  assert.ok(
    failed.json.metadata.legs.some(
      (row: { id: string; status: string }) => row.id === "audio-present" && row.status === "fail",
    ),
  );
  FilmMeasureSchema.parse(JSON.parse(readFileSync(path.join(root, "measure.json"), "utf8")));

  const noReason = runCli("film-targets.ts", [
    "--manual",
    "--output",
    path.join(root, "t.json"),
    "--median-shot",
    "1:2",
    "--variety",
    "2:",
    "--cuts-per-minute",
    "30:",
    "--longest-still",
    ":1.5",
  ]);
  assert.equal(noReason.status, 1);
  assert.match(noReason.json.message, /--reason/);
  const manual = runCli("film-targets.ts", [
    "--manual",
    "--reason",
    "No reference fits this brief",
    "--output",
    path.join(root, "t.json"),
    "--median-shot",
    "1:2",
    "--variety",
    "2:",
    "--cuts-per-minute",
    "30:",
    "--longest-still",
    ":1.5",
    "--loudness=-16:-12",
  ]);
  assert.equal(manual.status, 0);
  const targets = FilmTargetsSchema.parse(JSON.parse(readFileSync(path.join(root, "t.json"), "utf8")));
  assert.equal(targets.source, "manual");
  assert.deepEqual(targets.loudnessLufs, { min: -16, max: -12 });
  const twoSources = runCli("film-targets.ts", ["--manual", "--video", file, "--output", path.join(root, "t.json")]);
  assert.equal(twoSources.status, 1);
});

test("critic:pack lists what it drew, in reading order, with no cue explanations", (t) => {
  const root = workspace(t);
  const file = path.join(root, "film.mp4");
  const critique = path.join(root, "critique.json");
  writeFileSync(critique, "{}");
  film(file, [1, 2, 1, 3, 1], { audio: "tone" });
  const cues = path.join(root, "cues.json");
  writeFileSync(
    cues,
    JSON.stringify({
      schemaVersion: 1,
      fps: 30,
      audioMapPath: "x",
      musicOffsetSec: 0,
      cues: [{ id: "a", kind: "hit", intentSec: 1.5, snap: "none", snappedSec: 1.5, frame: 45, deltaSec: 0 }],
    }),
  );
  const { status, json } = runCli("critic-pack.ts", [
    "--render",
    file,
    "--output-dir",
    path.join(root, "pack"),
    "--cue-sheet",
    cues,
    "--reference",
    file,
    "--previous-critique",
    critique,
  ]);
  assert.equal(status, 0, JSON.stringify(json));
  const pack = json.metadata;
  for (const key of ["frameDifferenceCurve", "waveform", "loudness", "phoneSheet", "numbers", "sideBySide"])
    assert.ok(readFileSync(pack[key]).length > 0, key);
  assert.ok(pack.sheets.length >= 1);
  assert.ok(pack.transitions.length >= 2);
  assert.ok(pack.clips.length >= 2, "a clip around each cut");
  for (const clip of pack.clips) assert.ok(readFileSync(clip).length > 0 && pack.readingOrder.includes(clip), clip);
  assert.equal(pack.readingOrder.at(-1), path.resolve(critique));
  assert.ok(pack.readingOrder.includes(pack.phoneSheet));
  assert.match(readFileSync(pack.loudness, "utf8"), /integrated_lufs\t-/);
});

test("side by side pairs the i-th downbeat of film and reference, else matching times", () => {
  const paired = matchingTimes(10, 20, [1, 3, 5, 7], [2, 6, 10, 14, 18], 3);
  assert.deepEqual(
    paired.map((pair) => [pair.film, pair.reference]),
    [
      [1, 2],
      [5, 10],
      [7, 14],
    ],
  );
  assert.ok(paired.every((pair) => pair.label.startsWith("DOWNBEAT")));
  const plain = matchingTimes(10, 20, [], [2, 6], 4);
  assert.deepEqual(
    plain.map((pair) => pair.film),
    [1.25, 3.75, 6.25, 8.75],
  );
  assert.ok(plain.every((pair) => pair.film === pair.reference && pair.label === ""));
});

test("critic:pack gives the critic the mix, duck depth, sync v2 and the reference's sync and pilot spec", (t) => {
  const root = workspace(t);
  const file = path.join(root, "film.mp4");
  film(file, [2, 2, 2, 2], { audio: "tone" });
  const referenceDir = path.join(root, "library/ref");
  mkdirSync(path.join(referenceDir, "media"), { recursive: true });
  copyFileSync(file, path.join(referenceDir, "media/source.mp4"));
  writeFileSync(path.join(referenceDir, "source.json"), "{}");
  writeFileSync(
    path.join(referenceDir, "audio.json"),
    JSON.stringify({ tempo: { beatsSec: [0, 1, 2, 3, 4, 5, 6, 7], downbeatsSec: [0, 2, 4, 6] } }),
  );
  writeFileSync(
    path.join(referenceDir, "sync.json"),
    JSON.stringify({ metrics: { cutsOnBeatLift: 2.4, cutsOnDownbeatFrameLift: 6 } }),
  );
  writeFileSync(path.join(referenceDir, "pilot-spec.md"), "# Pilot\n");
  const map = path.join(root, "audio-map.json");
  writeFileSync(
    map,
    JSON.stringify(
      AUDIO_MAP({
        source: { path: "x.wav", sha256: "b".repeat(64), durationSec: 8 },
        beatsSec: [0, 1, 2, 3, 4, 5, 6, 7],
        downbeatsSec: [0, 2, 4, 6],
      }),
    ),
  );
  const mix = path.join(root, "mix-report.json");
  writeFileSync(
    mix,
    JSON.stringify({
      ok: true,
      metadata: {
        analysis: { integratedLufs: -14.1, truePeakDb: -1.2 },
        duck: { medianDuckDb: -8.5, deepestDuckDb: -9 },
      },
    }),
  );
  const critique = path.join(root, "critique.json");
  writeFileSync(critique, "{}");
  const { status, json } = runCli("critic-pack.ts", [
    "--render",
    file,
    "--output-dir",
    path.join(root, "pack"),
    "--reference",
    path.join(referenceDir, "media/source.mp4"),
    "--audio-map",
    map,
    "--mix-report",
    mix,
    "--previous-critique",
    critique,
  ]);
  assert.equal(status, 0, JSON.stringify(json));
  const pack = json.metadata;
  const sound = JSON.parse(readFileSync(pack.sound, "utf8"));
  assert.equal(sound.mix.integratedLufs, -14.1);
  assert.equal(sound.duck.medianDuckDb, -8.5);
  assert.equal(sound.sync.gridTrust, "reliable");
  assert.ok(sound.sync.cutsOnDownbeatFrameLift > 1);
  assert.equal(sound.referenceSync.cutsOnDownbeatFrameLift, 6);
  assert.equal(pack.pilotSpec, path.join(referenceDir, "pilot-spec.md"));
  assert.ok(pack.readingOrder.indexOf(pack.pilotSpec) < pack.readingOrder.indexOf(path.resolve(critique)));
  assert.ok(pack.readingOrder.includes(pack.sound));
  assert.ok(readFileSync(pack.sideBySide).length > 0);
});

test("film:render refuses a silent film before rendering", () => {
  const { status, json } = runCli("film-render.ts", [
    "--composition",
    "Anything",
    "--output",
    "/tmp/never-rendered.mp4",
  ]);
  assert.equal(status, 1);
  assert.equal(json.error, "VALIDATION");
  assert.match(json.message, /refuses/);
});

// --- Rules ---

test("targets keep the detector's reading and widen by its known error", () => {
  const shots = {
    schemaVersion: 1 as const,
    referenceId: "x",
    detector: { name: "t", params: {} },
    shots: [
      { id: "s1", startSec: 0, endSec: 2, transitionIn: "unknown" as const, transitionConfidence: 0 },
      { id: "s2", startSec: 2, endSec: 4, transitionIn: "cut" as const, transitionConfidence: 1 },
      { id: "s3", startSec: 4, endSec: 6, transitionIn: "cut" as const, transitionConfidence: 1 },
    ],
    candidates: [],
    summary: { count: 3, medianDurationSec: 2, cutsPerMinute: 20 },
  };
  const claim = <T>(value: T) => ({ value, basis: "observed" as const, confidence: 1, evidence: [] });
  const judged = judgedCutTimes(shots, {
    corrections: [
      claim({ kind: "split" as const, shotIds: ["s1"], timeSec: 1, note: "" }),
      claim({ kind: "merge" as const, shotIds: ["s2", "s3"], note: "" }),
      claim({ kind: "retype" as const, shotIds: ["s2"], note: "" }),
    ],
  });
  assert.deepEqual(judged, [1, 2]);

  const evidence = syntheticEvidence([2, 4, 6, 8, 10, 12, 14, 16, 18], 20);
  const plain = targetsFromEvidence({ evidence });
  const corrected = targetsFromEvidence({ evidence, judgedCuts: varied(20).concat([2, 4]) });
  assert.ok(corrected.cutsPerMinute.max! > plain.cutsPerMinute.max!);
  assert.ok(corrected.medianShotSec.min! < plain.medianShotSec.min!);
  assert.equal(corrected.measuredFrom.detectedCuts, 9);
  assert.ok(corrected.measuredFrom.judgedCuts! > 9);
  FilmTargetsSchema.parse(corrected);
});

test("film:targets takes its cuts from the judged edit layer, keeps the detector as a cross-check and notes a gap over 25%", (t) => {
  const root = workspace(t);
  const reference = path.join(root, "judged");
  cpSync(path.join(fixtures, "reference-judged"), reference, { recursive: true });
  mkdirSync(path.join(reference, "media"));
  film(path.join(reference, "media/source.mp4"), [3, 3, 3, 3]);
  const output = path.join(root, "targets.json");

  const judged = runCli("film-targets.ts", ["--reference-dir", reference, "--output", output]);
  assert.equal(judged.status, 0, JSON.stringify(judged.json));
  const targets = FilmTargetsSchema.parse(judged.json.metadata.targets);
  assert.equal(judged.json.metadata.cutsFrom, "judged");
  assert.equal(targets.measuredFrom.detectedCuts, 3);
  assert.equal(targets.measuredFrom.judgedCuts, 9);
  assert.equal(targets.measuredFrom.cutsFromJudged, 1);
  const rate = targets.measuredFrom.judgedCutsPerMinute!;
  assert.ok(
    Math.abs(targets.cutsPerMinute.min! - Math.round(rate * 0.7 * 10) / 10) < 0.11,
    "the lower bound follows the judged rate, not the detector's",
  );
  assert.ok(
    targets.cutsPerMinute.min! > targets.measuredFrom.detectedCutsPerMinute!,
    "the detector's 3 cuts no longer pull the target down",
  );
  assert.ok(targets.medianShotSec.max! < 3, "the median follows the judged shots");
  assert.deepEqual([judged.json.metadata.crossCheck.detectedCuts, judged.json.metadata.crossCheck.judgedCuts], [3, 9]);
  assert.equal(judged.json.metadata.crossCheck.disagreement, 0.667);
  assert.match(judged.json.metadata.crossCheck.note, /detector found 3 cuts, the analyst's edit 9 \(67% apart\)/);
  assert.ok(judged.json.metadata.warnings.includes(judged.json.metadata.crossCheck.note));

  rmSync(path.join(reference, "edit.json"));
  const detected = runCli("film-targets.ts", ["--reference-dir", reference, "--output", output]);
  assert.equal(detected.json.metadata.cutsFrom, "detector");
  assert.equal(detected.json.metadata.crossCheck, undefined);
  assert.ok(detected.json.metadata.targets.cutsPerMinute.min < targets.cutsPerMinute.min!);
});

test("a judged count within 25% of the detector's carries no note", () => {
  const evidence = syntheticEvidence(varied(30), 30);
  const cuts = evidence.boundaries.map((row) => row.timeSec);
  const close = targetsFromEvidence({ evidence, judgedCuts: [...cuts, 29.5] });
  assert.equal(cutCrossCheck(close)!.note, undefined);
  assert.equal(cutCrossCheck(targetsFromEvidence({ evidence })), undefined);
});

test("soft boundaries widen the lower bound on cuts, so a collage's count is not demanded", () => {
  const firm = syntheticEvidence(varied(30), 30);
  const collage = {
    ...firm,
    boundaries: firm.boundaries.map((row, index) =>
      index % 2 ? { ...row, measures: { engines: 1, changedFraction: 0.3 } } : row,
    ),
  };
  assert.ok(softBoundaryShare(collage.boundaries) > 0.4);
  assert.ok(
    targetsFromEvidence({ evidence: collage }).cutsPerMinute.min! <
      targetsFromEvidence({ evidence: firm }).cutsPerMinute.min!,
  );
});

test("variety target is capped: bursty references do not demand burstiness", () => {
  const evidence = syntheticEvidence([0.1, 0.2, 0.3, 0.4, 5, 10, 15, 20, 25], 30);
  assert.ok(
    readShots(
      evidence.boundaries.map((row) => row.timeSec),
      30,
    ).variety > 10,
  );
  assert.equal(targetsFromEvidence({ evidence }).shotLengthVariety.min, 3);
});

test("one long take is reported as one, not as a uniform cadence", () => {
  const measure = measureFilm({ evidence: syntheticEvidence([], 20), targets: POLYMARKET() });
  const variety = leg(measure, "shot-length-variety");
  assert.equal(variety.status, "skipped");
  assert.match(variety.message, /one continuous take/);
  assert.equal(leg(measure, "shot-length-median").status, "fail");
});

test("a cue sheet is the truth about cuts, and a cue with no change on screen fails", () => {
  const cueSheet = CueSheetSchema.parse(fixture("showcase-cue-sheet.json"));
  const truth = cueSheet.cues.map((cue) => cue.frame / 30);
  const evidence = syntheticEvidence([5.1, 8.8, ...truth, 19], 35.4);
  const reading = readCues(evidence, cueSheet);
  assert.equal(
    reading.rows.every((row) => row.state === "matched"),
    true,
  );
  assert.deepEqual(reading.unclaimedBoundaries, [5.1, 8.8, 19]);

  const withCues = measureFilm({ evidence, cueSheet });
  assert.equal(leg(withCues, "shot-length-median").value, 3.9);
  assert.equal(leg(withCues, "cue-sheet-drift").status, "pass");

  const frozen = syntheticEvidence(truth, 35.4, {
    motion: syntheticEvidence([], 35.4).motion.map((row) => ({ ...row, changed: 0 })),
  });
  const claimed: CueSheet = {
    ...cueSheet,
    cues: [
      ...cueSheet.cues,
      { id: "imagined", kind: "cut", intentSec: 20, snap: "none", snappedSec: 20, frame: 600, deltaSec: 0 },
      { id: "imagined2", kind: "cut", intentSec: 21, snap: "none", snappedSec: 21, frame: 630, deltaSec: 0 },
    ],
  };
  const measure = measureFilm({ evidence: frozen, cueSheet: claimed });
  assert.equal(leg(measure, "cue-sheet-drift").status, "fail");
  assert.ok(leg(measure, "cue-sheet-drift").evidence.some((line) => line.includes("imagined")));
  assert.equal(readCues(frozen, claimed).confirmedTimes.includes(20), false);

  const late = syntheticEvidence(
    truth.map((time) => time + 0.1),
    35.4,
  );
  assert.equal(leg(measureFilm({ evidence: late, cueSheet }), "cue-sheet-drift").status, "fail");
});

const AUDIO_MAP = (overrides = {}) =>
  AudioMapSchema.parse({
    schemaVersion: 1,
    source: { path: "x.wav", sha256: "b".repeat(64), durationSec: 30 },
    tempo: { bpm: 120, confidence: 0.9, gridTrust: "reliable" },
    beatsSec: Array.from({ length: 60 }, (_, index) => index * 0.5),
    downbeatsSec: Array.from({ length: 15 }, (_, index) => index * 2),
    phrases: [],
    sections: [{ startSec: 0, endSec: 30, level: "mid", density: 1, feel: "x" }],
    events: [],
    keyMoments: [],
    silences: [],
    risers: [],
    energyCurve: [],
    ...overrides,
  });

test("cuts on audio are judged by lift over chance, and an untrusted grid is not an anchor", () => {
  const onBeat = syntheticEvidence(
    Array.from({ length: 20 }, (_, index) => (index + 1) * 1.5),
    31,
  );
  const offBeat = syntheticEvidence(
    Array.from({ length: 20 }, (_, index) => (index + 1) * 1.5 + 0.25),
    31,
  );
  const targets = FilmTargetsSchema.parse({
    ...POLYMARKET(),
    measuredFrom: { ...POLYMARKET().measuredFrom, cutsOnAudioLift: 0.3 },
  });
  assert.equal(leg(measureFilm({ evidence: onBeat, targets, audioMap: AUDIO_MAP() }), "cuts-on-audio").status, "pass");
  assert.equal(leg(measureFilm({ evidence: offBeat, targets, audioMap: AUDIO_MAP() }), "cuts-on-audio").status, "fail");
  assert.equal(leg(measureFilm({ evidence: onBeat }), "cuts-on-audio").status, "skipped");

  const untrusted = audioAnchors(
    AUDIO_MAP({
      tempo: { confidence: 0.1, gridTrust: "none" },
      keyMoments: [{ timeSec: 7, kind: "drop", strength: 1 }],
    }),
  );
  assert.deepEqual(untrusted, [0, 7]);
  assert.deepEqual(audioAnchors(AUDIO_MAP({ beatsSec: [1, 2], downbeatsSec: [] }), 1.5).slice(0, 1), [0.5]);
  const full = AUDIO_MAP({ keyMoments: [{ timeSec: 0.25, kind: "drop", strength: 1 }] });
  assert.ok(beatAnchors(full).length < audioAnchors(full).length);
  assert.equal(beatAnchors(full).includes(0.25), false);
  const reading = readAnchors([0.5, 1, 1.5], [0.5, 1, 1.5], 10)!;
  assert.equal(reading.ratio, 1);
  assert.ok(reading.lift > 0.5);
});

test("sync v2: targets keep beats and downbeats apart, measure judges lift over chance, old targets keep v1", () => {
  const downbeatCuts = Array.from({ length: 14 }, (_, index) => (index + 1) * 2);
  const reference = syntheticEvidence(downbeatCuts, 30);
  const targets = targetsFromEvidence({ evidence: reference, audioMap: AUDIO_MAP() });
  assert.equal(targets.measuredFrom["syncMetric"], 2);
  assert.ok(targets.measuredFrom["cutsOnBeatLift"]! > 1.5);
  assert.ok(targets.measuredFrom["cutsOnDownbeatFrameLift"]! > 1.5);
  assert.equal(targets.measuredFrom["signedMedianCutToBeatSec"], 0);
  assert.equal(targets.measuredFrom["cutsOnAudioLift"], undefined);
  assert.deepEqual(targets.cutsOnAudioRatio, {});
  const fromLayer = targetsFromEvidence({
    evidence: reference,
    grid: { beatsSec: AUDIO_MAP().beatsSec, downbeatsSec: AUDIO_MAP().downbeatsSec },
  });
  assert.equal(fromLayer.measuredFrom["cutsOnDownbeatFrameLift"], targets.measuredFrom["cutsOnDownbeatFrameLift"]);

  const onDownbeats = syntheticEvidence(
    downbeatCuts.map((time) => time - 1 / 30),
    31,
  );
  const offGrid = syntheticEvidence(
    downbeatCuts.map((time) => time + 0.25),
    31,
  );
  const late = syntheticEvidence(
    downbeatCuts.map((time) => time + 0.1),
    31,
  );
  const on = measureFilm({ evidence: onDownbeats, targets, audioMap: AUDIO_MAP() });
  assert.equal(leg(on, "cuts-on-audio").status, "pass");
  assert.match(leg(on, "cuts-on-audio").message, /downbeats/);
  assert.equal(leg(on, "cut-to-beat-offset").status, "pass");
  assert.equal(leg(measureFilm({ evidence: offGrid, targets, audioMap: AUDIO_MAP() }), "cuts-on-audio").status, "fail");
  const trailing = leg(measureFilm({ evidence: late, targets, audioMap: AUDIO_MAP() }), "cut-to-beat-offset");
  assert.equal(trailing.status, "warn");
  assert.match(trailing.fix!, /trail/);

  const unsynced = FilmTargetsSchema.parse({
    ...targets,
    measuredFrom: { ...targets.measuredFrom, cutsOnBeatLift: 1, cutsOnDownbeatFrameLift: 0.8 },
  });
  assert.notEqual(
    leg(measureFilm({ evidence: offGrid, targets: unsynced, audioMap: AUDIO_MAP() }), "cuts-on-audio").status,
    "fail",
  );
  const untrusted = measureFilm({
    evidence: offGrid,
    targets,
    audioMap: AUDIO_MAP({ tempo: { confidence: 0.1, gridTrust: "none" } }),
  });
  assert.equal(leg(untrusted, "cut-to-beat-offset").status, "skipped");
  assert.notEqual(leg(untrusted, "cuts-on-audio").status, "fail");
});

test("beat sync is not a norm: corpus targets whose median reference does not cut on the beat ask for no lift and read no offset", () => {
  const downbeatCuts = Array.from({ length: 14 }, (_, index) => (index + 1) * 2);
  const offGrid = syntheticEvidence(
    downbeatCuts.map((time) => time + 0.25),
    31,
  );
  // The professional corpus, 2026-11-15: median beat lift 1.0, downbeat lift 0.2.
  const corpus = FilmTargetsSchema.parse({
    ...POLYMARKET(),
    source: "corpus",
    corpus: { referenceIds: ["a", "b", "c"] },
    measuredFrom: { syncMetric: 2, cutsOnBeatLift: 1.0, cutsOnDownbeatFrameLift: 0.2, signedMedianCutToBeatSec: 0.012 },
    cutsOnAudioRatio: {},
  });
  const measured = measureFilm({ evidence: offGrid, targets: corpus, audioMap: AUDIO_MAP() });
  assert.equal(leg(measured, "cuts-on-audio").status, "pass", leg(measured, "cuts-on-audio").message);
  assert.match(leg(measured, "cuts-on-audio").message, /corpus does not cut to its grid/);
  assert.equal(leg(measured, "cut-to-beat-offset").status, "skipped");
  // A film that does cut on the beat is still read for where it sits.
  const onBeat = measureFilm({
    evidence: syntheticEvidence(
      downbeatCuts.map((time) => time - 1 / 30),
      31,
    ),
    targets: corpus,
    audioMap: AUDIO_MAP(),
  });
  assert.equal(leg(onBeat, "cut-to-beat-offset").status, "pass");
});

test("calibrated constants keep their measured rationale (design-reference/calibration.md, 20 references, 2026-11-15)", () => {
  // Professional distributions recorded that day: a changed constant must still pass these readings and still fail the weak films.
  const SPREAD = { p90: 0.29, max: 0.39 };
  assert.ok(
    MOTION_SPREAD_MAX >= SPREAD.max && MOTION_SPREAD_MAX <= SPREAD.p90 + 0.12,
    "motion-spread ceiling is p90 + 0.1 and clears the busiest reference",
  );
  assert.ok(MOTION_SPREAD_MAX < 0.78, "the synthetic whole-frame drift reads 0.79 and must still fail");
  assert.equal(FAST_SHARP_MAX, 0.5);
  for (const fps of [24, 25, 30, 50, 60])
    assert.ok(
      sharpnessStep(fps) % 2 && sharpnessStep(fps) % 3,
      `step ${sharpnessStep(fps)} at ${fps} fps must not line up with holds on twos or threes`,
    );
  const row = (p10: number, p25: number, median: number, p75: number, p90: number, n = 20) => ({
    n,
    min: p10,
    p10,
    p25,
    median,
    p75,
    p90,
    max: p90,
  });
  const corpus = {
    referenceIds: Array.from({ length: 20 }, (_, index) => `ref-${index}`),
    excluded: [],
    metrics: {
      medianShotSec: row(0.131, 0.673, 0.984, 1.775, 2.47),
      cutsPerMinute: row(19.98, 23.825, 40.6, 63.15, 93.14),
      shotLengthVariety: row(2.96, 3.27, 5.795, 17.22, 30.015),
      integratedLufs: row(-16.794, -15.355, -14.1, -13.025, -12.152, 19),
    },
  } as unknown as ReferenceCorpus;
  const { targets } = targetsFromCorpus(corpus);
  assert.equal(targets.medianShotSec.max, Math.round(2.47 * CORPUS_PACE_SLACK * 100) / 100);
  assert.equal(targets.shotLengthVariety.min, Math.round(2.96 * CORPUS_VARIETY_SHARE * 100) / 100);
  assert.equal(targets.loudnessLufs.min, Math.round((-16.794 - CORPUS_LOUDNESS_SLACK) * 10) / 10);
  // The weak film the user judged: about 4 s shots, uniform lengths, no sound. Its 12 cuts a minute sit just under the floor (13.3): the
  // slowest professional films cut nearly as rarely, so uniform lengths, the long median and the silence are what catch it surely.
  const slideshow = { ...syntheticEvidence([4, 8, 12, 16], 20), audio: undefined };
  const weak = measureFilm({ evidence: slideshow, targets });
  for (const id of ["audio-present", "shot-length-median", "shot-length-variety", "cuts-per-minute"])
    assert.equal(leg(weak, id).status, "fail", id);
  // A slow professional film (13.6 cuts a minute, 3.6 s median, varied) still passes the pace legs.
  const slow = syntheticEvidence([1, 3, 6.6, 10.2, 13.8, 17.4, 21, 24.6, 29, 36], 44);
  const slowMeasure = measureFilm({ evidence: slow, targets });
  for (const id of ["shot-length-median", "cuts-per-minute", "shot-length-variety"])
    assert.equal(leg(slowMeasure, id).status, "pass", leg(slowMeasure, id).message);
});

test("the end card may not fall away, and a deliberate silence on the map is allowed", () => {
  const perSecond = Array.from({ length: 30 }, (_, index) => ({ timeSec: index, lufs: index >= 27 ? -33 : -14 }));
  const base = syntheticEvidence(varied(30), 30);
  const quiet = { ...base, audio: { ...base.audio!, perSecond } };
  const end = leg(measureFilm({ evidence: quiet }), "loudness-sections");
  assert.equal(end.status, "fail");
  assert.ok(end.value! > 15);
  assert.match(end.fix!, /end card/);

  const silent = { ...base, audio: { ...base.audio!, silences: [{ startSec: 10, endSec: 14 }] } };
  assert.equal(leg(measureFilm({ evidence: silent }), "sound-silence").status, "fail");
  const named = measureFilm({ evidence: silent, audioMap: AUDIO_MAP({ silences: [{ startSec: 10, endSec: 14 }] }) });
  assert.equal(leg(named, "sound-silence").status, "pass");

  const hot = { ...base, audio: { ...base.audio!, truePeakDb: 0.4 } };
  assert.equal(leg(measureFilm({ evidence: hot }), "true-peak").status, "fail");
  const hotReference = FilmTargetsSchema.parse({ ...POLYMARKET(), measuredFrom: { truePeakDb: 0.5 } });
  assert.equal(leg(measureFilm({ evidence: hot, targets: hotReference }), "true-peak").status, "warn");
});

test("a stated silence passes the audio leg; a reference without sound does not require it", () => {
  const evidence = { ...syntheticEvidence(varied(30), 30), audio: undefined };
  assert.equal(leg(measureFilm({ evidence }), "audio-present").status, "fail");
  const decision = {
    schemaVersion: 1 as const,
    askedUser: { question: "q", answer: "a", at: "t" },
    route: "silence" as const,
    delivery: "none" as const,
    reason: "r",
  };
  assert.equal(leg(measureFilm({ evidence, decision }), "audio-present").status, "pass");
  const targets = FilmTargetsSchema.parse({ ...POLYMARKET(), audioRequired: false });
  assert.equal(leg(measureFilm({ evidence, targets }), "audio-present").status, "pass");
});

test("the loudness log parser reads per-second loudness, peak and silence", () => {
  const log = [
    "[silencedetect @ 0x1] silence_start: 2.5",
    "[silencedetect @ 0x1] silence_end: 4 | silence_duration: 1.5",
    "[Parsed_ebur128_1 @ 0x1] t: 0.1  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS   LRA:   0.0 LU",
    "[Parsed_ebur128_1 @ 0x1] t: 0.5  TARGET:-23 LUFS    M: -14.0 S: -14.0     I: -14.0 LUFS   LRA:   0.0 LU",
    "[Parsed_ebur128_1 @ 0x1] t: 1.5  TARGET:-23 LUFS    M: -10.0 S: -12.0     I: -12.0 LUFS   LRA:   1.0 LU",
    "[Parsed_ebur128_1 @ 0x1] Summary:",
    "  Integrated loudness:",
    "    I:         -13.5 LUFS",
    "  Loudness range:",
    "    LRA:         5.5 LU",
    "  True peak:",
    "    Peak:       -0.7 dBFS",
  ].join("\n");
  const audio = parseLoudnessLog(log, 6);
  assert.equal(audio.integratedLufs, -13.5);
  assert.equal(audio.truePeakDb, -0.7);
  assert.equal(audio.loudnessRangeLu, 5.5);
  assert.deepEqual(audio.silences, [{ startSec: 2.5, endSec: 4 }]);
  assert.equal(audio.perSecond.length, 2);
  assert.equal(audio.perSecond[1]!.lufs, -10);
  assert.equal(parseLoudnessLog("silence_start: 1\nSummary:\n I: -70.0 LUFS\n", 3).integratedLufs, null);
  assert.deepEqual(parseLoudnessLog("silence_start: 1\nSummary:\n", 3).silences, [{ startSec: 1, endSec: 3 }]);
});

test("range flags and pack windows", () => {
  assert.deepEqual(parseRange("0.8:1.6"), { min: 0.8, max: 1.6 });
  assert.deepEqual(parseRange(":1.5"), { max: 1.5 });
  assert.deepEqual(parseRange("-16:-12"), { min: -16, max: -12 });
  assert.throws(() => parseRange("fast"));
  assert.deepEqual(windowsAround([1, 1.2, 5], 6, 30), [
    { startSec: 0.7, endSec: 1.5 },
    { startSec: 4.7, endSec: 5.3 },
  ]);
  const long = windowsAround(
    Array.from({ length: 40 }, (_, index) => index * 0.5),
    20,
    30,
  );
  assert.ok(long.length > 1);
  assert.ok(long.every((span) => (span.endSec - span.startSec) * 30 <= 119.5));
});

// --- Plan check ---

const PLAN = (name: string) => MotionPlanSchema.parse(fixture(name));

test("plan:check blocks a plan like the Showcase, for the reasons it was weak", () => {
  const result = checkPlan(
    PLAN("plan-showcase-like.json"),
    POLYMARKET(),
    CueSheetSchema.parse(fixture("showcase-cue-sheet.json")),
  );
  assert.equal(result.verdict, "fail");
  assert.ok(result.riskScore >= 2.5);
  assert.equal(result.stats.medianShotSec, 3.9);
  const failing = result.findings.filter((row) => row.status === "fail").map((row) => row.dimension);
  for (const dimension of [
    "shot-length",
    "shot-count",
    "holds-without-motion",
    "entrance-variety",
    "shot-boundaries",
    "reading-time",
  ])
    assert.ok(failing.includes(dimension), dimension);
  assert.ok(result.findings.filter((row) => row.status === "fail").every((row) => row.fix));
  assert.equal(result.findings.find((row) => row.dimension === "holds-without-motion")!.value, 5);
});

test("plan:check passes a plan derived from the polymarket blueprint", () => {
  const result = checkPlan(PLAN("plan-polymarket-derived.json"), POLYMARKET());
  assert.equal(result.verdict, "pass", JSON.stringify(result.findings.filter((row) => row.status === "fail")));
  assert.ok(result.riskScore < 1);
});

test("plan:check CLI: blocks with exit 1, and refuses to run without targets", (t) => {
  const root = workspace(t);
  const blocked = runCli("plan-check.ts", [
    "--plan",
    path.join(fixtures, "plan-showcase-like.json"),
    "--targets",
    path.join(fixtures, "polymarket-targets.json"),
    "--output",
    path.join(root, "check.json"),
  ]);
  assert.equal(blocked.status, 1);
  assert.equal(blocked.json.error, "VALIDATION");
  assert.equal(JSON.parse(readFileSync(path.join(root, "check.json"), "utf8")).verdict, "fail");
  assert.deepEqual(
    blocked.json.outputs,
    [path.join(root, "check.json")],
    "the report path is a top-level output, as on a pass",
  );
  assert.equal(blocked.json.metadata.outputs, undefined);
  const noTargets = runCli("plan-check.ts", ["--plan", path.join(fixtures, "plan-showcase-like.json")]);
  assert.equal(noTargets.status, 1);
  assert.equal(noTargets.json.error, "STAGE_INCOMPLETE");
  assert.equal(
    runCli("plan-check.ts", [
      "--plan",
      path.join(fixtures, "plan-polymarket-derived.json"),
      "--targets",
      path.join(fixtures, "polymarket-targets.json"),
    ]).status,
    0,
  );
});

test("a boundary must name what crosses it", () => {
  assert.equal(classifyBoundary({ transitionToNext: "cut" }), "unnamed");
  assert.equal(classifyBoundary({ transitionToNext: "whip pan" }), "unnamed");
  assert.equal(classifyBoundary({}), "unnamed");
  assert.equal(classifyBoundary({ transitionToNext: "hard cut on the downbeat" }), "hard-cut");
  assert.equal(classifyBoundary({ carry: "hard-cut: new idea" }), "hard-cut");
  assert.equal(classifyBoundary({ carry: "the coin" }), "carry");
  assert.equal(classifyBoundary({ transitionToNext: "the coin becomes the card" }), "carry");
});

test("reading time and treatment names", () => {
  assert.equal(requiredReadingSec("Start"), 0.8);
  assert.equal(requiredReadingSec("one two three four five six"), 1.8);
  assert.equal(requiredReadingSec("Старт"), 1);
  assert.equal(requiredReadingSec("один два три четыре"), 1.5);
  assert.equal(normaliseTreatment("Fade up 12f, ease-out"), normaliseTreatment("fade up 20 frames"));
  assert.notEqual(normaliseTreatment("rise from below"), normaliseTreatment("fade up"));
});

// --- Slop signatures ---

test("plan:check fails a sloppy plan on linear curves, long holds and an unordered entrance, outside the risk mean", () => {
  const result = checkPlan(PLAN("plan-sloppy.json"), POLYMARKET());
  const finding = (dimension: string) => result.findings.find((row) => row.dimension === dimension)!;
  assert.equal(result.verdict, "fail");
  assert.equal(finding("curve-linear").status, "fail");
  assert.deepEqual(finding("curve-linear").shotIds, ["title", "features"]);
  assert.equal(finding("text-hold-long").status, "fail", "a stated 4.5 s hold on two words");
  assert.deepEqual(finding("text-hold-long").shotIds, ["title"]);
  assert.equal(finding("entry-hierarchy").status, "warn");
  assert.deepEqual(finding("entry-hierarchy").shotIds, ["title", "features"]);
  for (const dimension of SLOP_PLAN_DIMENSIONS)
    assert.ok(finding(dimension).status === "pass" || finding(dimension).fix, dimension);
  const scored = result.findings.filter((row) => !(SLOP_PLAN_DIMENSIONS as readonly string[]).includes(row.dimension));
  assert.equal(
    result.riskScore,
    Math.round((scored.reduce((sum, row) => sum + row.score, 0) / scored.length) * 100) / 100,
  );
});

test("plan:check's film gates (signature-element, cross-film-repetition) block outside the risk mean, only with a project's context", () => {
  assert.deepEqual([...UNSCORED_PLAN_DIMENSIONS], [...SLOP_PLAN_DIMENSIONS, ...FILM_GATE_DIMENSIONS]);
  const plan = PLAN("plan-polymarket-derived.json");
  const bare = checkPlan(plan, POLYMARKET());
  const hero = { id: "hero-stat-odometer", propsHash: "0123456789abcdef", weight: "hero" as const };
  const gated = checkPlan(plan, POLYMARKET(), undefined, undefined, {
    bespoke: true,
    blocks: [hero],
    recent: [{ schemaVersion: 1, projectId: "last", date: "2026-11-01", blocks: [hero] }],
  });
  const finding = (dimension: string) => gated.findings.find((row) => row.dimension === dimension)!;
  assert.equal(finding("signature-element").status, "fail");
  assert.equal(finding("cross-film-repetition").status, "fail");
  assert.equal(gated.verdict, "fail");
  assert.equal(gated.riskScore, bare.riskScore);
  const signed = {
    ...plan,
    signature: { description: "the price line tears", shotIds: [plan.shots[0]!.id], whyFromIdea: "odds move" },
  };
  const fresh = checkPlan(signed, POLYMARKET(), undefined, undefined, { bespoke: true, blocks: [hero], recent: [] });
  assert.equal(fresh.findings.find((row) => row.dimension === "signature-element")!.status, "pass");
  assert.equal(fresh.verdict, bare.verdict);
});

test("plan:check's slop dimensions pass the clean plan, warn on an inferred hold and accept a named order", () => {
  const clean = checkPlan(PLAN("plan-polymarket-derived.json"), POLYMARKET());
  assert.equal(clean.findings.find((row) => row.dimension === "curve-linear")!.status, "pass");
  assert.notEqual(clean.findings.find((row) => row.dimension === "text-hold-long")!.status, "fail");
  const plan = PLAN("plan-sloppy.json");
  plan.shots[0] = {
    ...plan.shots[0]!,
    curve: "linear (constant drift)",
    entrance: "none",
    readingHoldSec: undefined,
    durationFrames: 120,
  };
  plan.shots[1] = { ...plan.shots[1]!, entrance: "cards stagger in 4f apart, the middle one first" };
  const result = checkPlan(plan, POLYMARKET());
  const status = (dimension: string) => result.findings.find((row) => row.dimension === dimension)!.status;
  assert.equal(status("curve-linear"), "fail", "features still enters on linear");
  assert.deepEqual(result.findings.find((row) => row.dimension === "curve-linear")!.shotIds, ["features"]);
  assert.equal(status("text-hold-long"), "warn", "3.7 s inferred against a 2.5 s bound");
  assert.equal(status("entry-hierarchy"), "warn");
  assert.deepEqual(result.findings.find((row) => row.dimension === "entry-hierarchy")!.shotIds, ["title"]);
});

test("grid spread and sharpness: pure pixel helpers", () => {
  const width = 8;
  const height = 8;
  const flat = new Uint8Array(width * height).fill(100);
  const all = new Uint8Array(width * height).fill(200);
  const corner = Uint8Array.from(flat, (value, index) =>
    index % width < 2 && Math.floor(index / width) < 2 ? 200 : value,
  );
  assert.equal(gridChangedShare(all, flat, width, height), 1);
  assert.equal(gridChangedShare(flat, flat, width, height), 0);
  assert.equal(gridChangedShare(corner, flat, width, height), 1 / 16);
  const checker = Uint8Array.from({ length: width * height }, (_, index) =>
    ((index % width) + Math.floor(index / width)) % 2 ? 255 : 0,
  );
  const soft = Uint8Array.from(checker, (value) => 96 + value / 4);
  assert.ok(laplacianVariance(checker, width, height) > 10 * laplacianVariance(soft, width, height));
  assert.equal(laplacianVariance(flat, width, height), 0);
});

test("readings: spread ignores cuts, and sharp fast frames are judged against their own shot's settled frames", () => {
  const motion = Array.from({ length: 40 }, (_, index) => ({ timeSec: (index + 1) / 10, energy: 3, changed: 0.1 }));
  const spread = motion.map((row) => (row.timeSec <= 2 ? 1 : 0.1));
  const reading = readMotionSpread({ motion, spread }, [1])!;
  assert.equal(reading.samples, 37, "three samples sit on the cut at 1 s");
  assert.ok(Math.abs(reading.share - 17 / 37) < 0.001, String(reading.share));
  assert.deepEqual(reading.spans, [
    { startSec: 0, endSec: 0.8 },
    { startSec: 1.1, endSec: 2 },
  ]);
  assert.equal(readMotionSpread({ motion, spread: undefined }, []), undefined);
  const sample = (timeSec: number, change: number, sharpness: number) => ({ timeSec, change, sharpness });
  const video = { width: 320, height: 180, fps: 30, frameCount: 120, durationSec: 4, hasAudio: false };
  const samples = [
    sample(0, 0, 1000),
    sample(0.4, 0.3, 950),
    sample(0.8, 0.3, 900),
    sample(1.2, 0.3, 300),
    sample(2.4, 0.3, 2000),
  ];
  const fast = readFastSharp({ video, sharpness: { width: 320, height: 180, samples } }, [2])!;
  assert.deepEqual(
    [fast.fast, fast.sharp, fast.times],
    [3, 2, [0.4, 0.8]],
    "the shot after the cut has no settled frame, so it is not judged",
  );
});

test("film:measure warns on whole-frame motion and on it without blur; blur passes the sharpness leg", (t) => {
  const root = workspace(t);
  const sharp = path.join(root, "sharp.mp4");
  const blurred = path.join(root, "blurred.mp4");
  // A checkerboard that rests for a second, then slides 7 px a frame for a second, over and over.
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=320x180:r=30:d=6",
    "-vf",
    "format=gray,geq=lum='255*mod(floor((X+7*(floor(N/60)*30+max(0\\,mod(N\\,60)-30)))/20)+floor(Y/20)\\,2)',format=yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "16",
    sharp,
  ]);
  ffmpeg(["-i", sharp, "-vf", "tmix=frames=5", "-c:v", "libx264", "-crf", "16", blurred]);
  const sharpEvidence = gatherEvidence(sharp);
  const slop = measureFilm({ evidence: sharpEvidence });
  // Both advisory until judge:calibrate finds them eligible (design-reference/calibration.md).
  assert.equal(leg(slop, "motion-spread").status, "warn");
  assert.ok(leg(slop, "motion-spread").fix);
  assert.equal(leg(slop, "fast-motion-sharp").status, "warn");
  assert.match(leg(slop, "fast-motion-sharp").fix!, /blur/);
  const clean = measureFilm({ evidence: gatherEvidence(blurred) });
  assert.equal(leg(clean, "fast-motion-sharp").status, "pass", leg(clean, "fast-motion-sharp").message);
  const own = targetsFromEvidence({ evidence: sharpEvidence, referenceId: "slide" });
  assert.ok(own.measuredFrom.motionSpreadShare! > 0.35);
  assert.equal(
    leg(measureFilm({ evidence: sharpEvidence, targets: own }), "motion-spread").status,
    "pass",
    "a reference that moves the whole frame raises the ceiling",
  );
});

// --- Sound decisions ---

const decisionCue = (id: string, frame: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "cut",
  intentSec: frame / 30,
  snap: "none",
  snappedSec: frame / 30,
  frame,
  deltaSec: 0,
  ...extra,
});

test("plan:check cut-sound-decided: an undecided cut blocks, a silence with a reason decides, no cue sheet is not judged", () => {
  const plan = PLAN("plan-polymarket-derived.json");
  assert.equal(plan.fps, 30);
  const sheet = (cues: Record<string, unknown>[]) =>
    CueSheetSchema.parse({ schemaVersion: 1, fps: 30, audioMapPath: "x", musicOffsetSec: 0, cues });
  const boundaries = plan.shots.slice(1).map((shot, index) =>
    decisionCue(`cut-${index}`, shot.startFrame, {
      shotId: shot.id,
      ...(index % 2 ? { silent: { reason: "a breath before the next idea" } } : { sfx: "tick" }),
    }),
  );
  assert.ok(boundaries.length >= 3);
  const decided = checkPlan(
    plan,
    POLYMARKET(),
    sheet([
      ...boundaries.map((cue, index) =>
        index === 0 ? { ...cue, sfx: "whoosh", layers: ["tick", "sub-drop"], weight: "hero" } : cue,
      ),
      decisionCue("support-hit", 5, { kind: "hit", weight: "support" }),
    ]),
  );
  assert.equal(decided.findings.find((row) => row.dimension === "cut-sound-decided")!.status, "pass");
  // One cue left open, one boundary with no cue at all, one hero reveal with a bare "none".
  const open = checkPlan(
    plan,
    POLYMARKET(),
    sheet([
      { ...boundaries[0]!, sfx: undefined, silent: undefined },
      ...boundaries.slice(2),
      decisionCue("reveal", 5, { kind: "reveal", sfx: "none" }),
    ]),
  );
  const finding = open.findings.find((row) => row.dimension === "cut-sound-decided")!;
  assert.equal(finding.status, "fail");
  assert.equal(finding.value, 3);
  assert.deepEqual([...finding.shotIds].sort(), [plan.shots[1]!.id, plan.shots[2]!.id].sort());
  assert.match(finding.message, /no cue in the cue sheet/);
  assert.match(finding.fix!, /silent/);
  assert.equal(open.verdict, "fail");
  const none = checkPlan(plan, POLYMARKET()).findings.find((row) => row.dimension === "cut-sound-decided")!;
  assert.deepEqual([none.status, none.score, none.value], ["pass", 0, null]);
});

test("cut-sound-coverage: every decided-sound cut is heard on the render within 2 frames; a deliberate silence is not listened for", (t) => {
  const root = workspace(t);
  const file = path.join(root, "tones.mp4");
  // Short 1 kHz bursts at 1 s and 2 s (frames 30 and 60), nothing at 3 s (frame 90).
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x90:r=30:d=4",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=exprs='0.5*sin(2*PI*1000*t)*(between(t,1,1.05)+between(t,2,2.05))':s=48000:d=4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  const onsetsSec = readRenderOnsets(file);
  const sheet = (third: Record<string, unknown>) =>
    CueSheetSchema.parse({
      schemaVersion: 1,
      fps: 30,
      audioMapPath: "x",
      musicOffsetSec: 0,
      cues: [
        decisionCue("one", 30, { sfx: "tick" }),
        decisionCue("two", 60, { sfx: "impact" }),
        decisionCue("three", 90, third),
      ],
    });
  const evidence = syntheticEvidence([1, 2, 3], 4);
  const forgotten = leg(measureFilm({ evidence, cueSheet: sheet({ sfx: "tick" }), onsetsSec }), "cut-sound-coverage");
  // Advisory until calibration makes it eligible (design-reference/calibration.md).
  assert.equal(forgotten.status, "warn", JSON.stringify({ onsetsSec, forgotten }));
  assert.equal(forgotten.value, 0.667);
  assert.match(forgotten.message, /three @3 s/);
  const silent = leg(
    measureFilm({ evidence, cueSheet: sheet({ silent: { reason: "the cut lands dry" } }), onsetsSec }),
    "cut-sound-coverage",
  );
  assert.equal(silent.status, "pass", silent.message);
  assert.equal(silent.value, 1);
  assert.equal(
    leg(measureFilm({ evidence, cueSheet: sheet({ sfx: "tick" }) }), "cut-sound-coverage").status,
    "skipped",
    "no onsets read",
  );
  assert.equal(leg(measureFilm({ evidence }), "cut-sound-coverage").status, "skipped", "no cue sheet");
});

test("film:render and film:measure measure a render through one helper, so cut-sound-coverage reads the same in both", (t) => {
  const root = workspace(t);
  const file = path.join(root, "tones.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x90:r=30:d=3",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=exprs='0.5*sin(2*PI*1000*t)*between(t,1,1.05)':s=48000:d=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  const cueSheet = CueSheetSchema.parse({
    schemaVersion: 1,
    fps: 30,
    audioMapPath: "x",
    musicOffsetSec: 0,
    cues: [decisionCue("one", 30, { sfx: "tick" })],
  });
  const coverage = leg(measureRender(file, { evidence: syntheticEvidence([1], 3), cueSheet }), "cut-sound-coverage");
  assert.notEqual(coverage.status, "skipped", coverage.message);
  assert.equal(coverage.value, 1);
  const silentEvidence = syntheticEvidence([1], 3, {
    video: { width: 1920, height: 1080, fps: 30, frameCount: 90, durationSec: 3, hasAudio: false },
  });
  assert.equal(
    leg(measureRender(file, { evidence: silentEvidence, cueSheet }), "cut-sound-coverage").status,
    "skipped",
    "no audio stream, no onsets",
  );
  for (const script of ["film-render.ts", "film-measure.ts"]) {
    const source = readFileSync(path.join(repo, "scripts", script), "utf8");
    assert.match(source, /measureRender\(/, script);
    assert.doesNotMatch(source, /measureFilm\(|readRenderOnsets\(/, `${script} measures only through measureRender`);
  }
});

test("old plans without the new fields stay valid", () => {
  const plan = PLAN("plan-showcase-like.json");
  assert.equal(plan.shots[0]!.carry, undefined);
  assert.equal(plan.shots[0]!.layers, undefined);
});
