import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress } from "../cli";
import { evidenceFor, writeJsonAtomic, type FilmEvidence } from "../film/evidence";
import { measureFilm } from "../film/measure";
import { cutSoundCoverageLeg, readRenderOnsets } from "../film/cut-sound";
import { readSync } from "../film/readings";
import { agreedPairs, type PairJudgement } from "../film/creative-rubric";
import { round } from "../film/stats";
import { decodeFrames, probeVideo, renderWaveform, writeImage } from "../vision/media";
import { composeGrid, evenSampleFrames, formatTimecode, tileSize, type Cell } from "../vision/sheets";
import type { CueSheet } from "../../types/film";
import {
  CalibrationManifestSchema,
  CalibrationReportSchema,
  CriticKeySchema,
  type CalibrationManifest,
  type CalibrationReport,
  type CriticJudgement,
  type CriticKey,
  type CriticPairs,
  type VariantKind,
} from "../../types/calibration";

// judge:calibrate: do our sensors and a blind critic tell a professional segment from a copy degraded on purpose?
// A judge earns a gate on a kind only by being right often enough on enough pairs. docs/reference-analysis.md, "Calibration".

export const MIN_ACCURACY = 0.85;
export const MIN_PAIRS = 6;
/** A control "alarms" when it reads the variant worse by more than this share of the original, and at least ALARM_FLOOR. */
const ALARM_SHARE = 0.1;
const ALARM_FLOOR = 0.02;
const DETECT_EPSILON = 1e-9;
/** Motion samples this close to a cut belong to the cut. */
const CUT_GUARD_SEC = 0.15;
const MIN_SHOT_SAMPLES = 4;

type Worse = "higher" | "lower";
export type SensorSpec = {
  id: string;
  group: "film:measure" | "sync" | "candidate";
  worse: Worse;
  targets: VariantKind[];
  describe: string;
};

/**
 * Each sensor, which way is worse, and the degradations it is expected to catch. Every other kind is a control for it.
 * Sync sensors need a beat grid in the manifest; candidates are not film:measure legs, only readings to try.
 */
export const SENSORS: readonly SensorSpec[] = [
  {
    id: "shot-length-variety",
    group: "film:measure",
    worse: "lower",
    targets: ["uniform-cuts"],
    describe: "film:measure leg: shot length p90/p10 (needs 5 shots)",
  },
  {
    id: "motion-spread",
    group: "film:measure",
    worse: "higher",
    targets: ["stutter"],
    describe: "film:measure leg: share of samples moving over 70% of the frame",
  },
  {
    id: "fast-motion-sharp",
    group: "film:measure",
    worse: "higher",
    targets: ["stutter"],
    describe: "film:measure leg: share of fast frames as sharp as settled ones",
  },
  {
    id: "cut-sound-coverage",
    group: "film:measure",
    worse: "lower",
    targets: ["no-sfx", "soft-transients", "desync"],
    describe: "film:measure leg on a cue sheet of the clip's own detected cuts, each as a sound",
  },
  {
    id: "cuts-on-beat",
    group: "sync",
    worse: "lower",
    targets: ["uniform-cuts", "desync"],
    describe: "readSync: share of cuts on a beat of the reference's grid",
  },
  {
    id: "cut-to-beat-offset",
    group: "sync",
    worse: "higher",
    targets: ["desync"],
    describe: "readSync: |signed median cut-to-beat offset + one frame|, distance from the default lead",
  },
  {
    id: "motion-energy-contrast",
    group: "candidate",
    worse: "lower",
    targets: ["linear-motion"],
    describe: "candidate: mean within-shot coefficient of variation of motion energy (eases make it uneven)",
  },
  {
    id: "colour-saturation",
    group: "candidate",
    worse: "lower",
    targets: ["flat-grade"],
    describe: "candidate: mean saturation (signalstats SATAVG)",
  },
];

export function selectSensors(value: string | undefined): SensorSpec[] {
  if (!value?.trim() || value.trim() === "all") return [...SENSORS];
  if (value.trim() === "none") return [];
  const picked = new Set<string>();
  for (const name of value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const group = SENSORS.filter((sensor) => sensor.group === name);
    if (group.length) group.forEach((sensor) => picked.add(sensor.id));
    else if (SENSORS.some((sensor) => sensor.id === name)) picked.add(name);
    else
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Unknown sensor ${name}. Known: ${SENSORS.map((sensor) => sensor.id).join(", ")}; groups film:measure, sync, candidate; all or none.`,
      });
  }
  return SENSORS.filter((sensor) => picked.has(sensor.id));
}

// --- Readings (IO) ---

export type ClipReading = Record<string, number | undefined>;

/** Within-shot unevenness of motion: eases speed up and slow down, constant speed does not. */
export function motionEnergyContrast(evidence: Pick<FilmEvidence, "motion" | "boundaries">): number | undefined {
  const cuts = evidence.boundaries.map((row) => row.timeSec).sort((a, b) => a - b);
  const edges = [0, ...cuts, Infinity];
  let weighted = 0;
  let total = 0;
  for (let index = 0; index + 1 < edges.length; index++) {
    const energies = evidence.motion
      .filter((row) => row.timeSec > edges[index]! + CUT_GUARD_SEC && row.timeSec < edges[index + 1]! - CUT_GUARD_SEC)
      .map((row) => row.energy);
    if (energies.length < MIN_SHOT_SAMPLES) continue;
    const mean = energies.reduce((sum, value) => sum + value, 0) / energies.length;
    if (mean <= 1e-6) continue;
    const deviation = Math.sqrt(energies.reduce((sum, value) => sum + (value - mean) ** 2, 0) / energies.length);
    weighted += (deviation / mean) * energies.length;
    total += energies.length;
  }
  return total ? round(weighted / total, 4) : undefined;
}

function meanSaturation(file: string): number | undefined {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      file,
      "-an",
      "-vf",
      "signalstats,metadata=print:key=lavfi.signalstats.SATAVG:file=-",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) return undefined;
  const values = [...result.stdout.matchAll(/SATAVG=([\d.]+)/g)].map((match) => Number(match[1]));
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 3) : undefined;
}

/** A cue sheet whose every cut decides a sound: what cut-sound-coverage listens for, from the clip's own cuts. */
export function cutsAsSoundCues(cutsSec: number[], fps: number): CueSheet {
  return {
    schemaVersion: 1,
    fps,
    audioMapPath: "",
    musicOffsetSec: 0,
    cues: cutsSec.map((timeSec, index) => ({
      id: `cut-${index + 1}`,
      kind: "cut",
      intentSec: timeSec,
      snap: "none",
      snappedSec: timeSec,
      frame: Math.round(timeSec * fps),
      deltaSec: 0,
      sfx: "impact",
    })),
  } as CueSheet;
}

/** Every selected sensor's value on one clip. `startSec` places the clip in the reference's time, for the grid. */
export function readClip(
  file: string,
  options: { sensors: SensorSpec[]; startSec: number; grid?: CalibrationManifest["grid"] },
): ClipReading {
  const ids = new Set(options.sensors.map((sensor) => sensor.id));
  const reading: ClipReading = {};
  const evidence = evidenceFor(file, `${file}.evidence.json`);
  const { fps, durationSec } = evidence.video;
  const cuts = evidence.boundaries.map((row) => row.timeSec);
  const measure = measureFilm({ evidence });
  for (const id of ["shot-length-variety", "motion-spread", "fast-motion-sharp"])
    if (ids.has(id)) reading[id] = measure.legs.find((leg) => leg.id === id)?.value ?? undefined;
  if (ids.has("cut-sound-coverage") && evidence.video.hasAudio && cuts.length)
    reading["cut-sound-coverage"] =
      cutSoundCoverageLeg({ cueSheet: cutsAsSoundCues(cuts, fps), onsetsSec: readRenderOnsets(file), fps }).value ??
      undefined;
  if (options.grid && (ids.has("cuts-on-beat") || ids.has("cut-to-beat-offset"))) {
    const shift = (times: number[]) =>
      times.map((time) => round(time - options.startSec, 4)).filter((time) => time >= 0 && time <= durationSec);
    const sync = readSync(
      cuts,
      { beatsSec: shift(options.grid.beatsSec), downbeatsSec: shift(options.grid.downbeatsSec) },
      durationSec,
      fps,
    );
    if (ids.has("cuts-on-beat")) reading["cuts-on-beat"] = sync.cutsOnBeatRatio;
    if (ids.has("cut-to-beat-offset") && sync.signedMedianCutToBeatSec !== undefined)
      reading["cut-to-beat-offset"] = round(Math.abs(sync.signedMedianCutToBeatSec + 1 / fps), 4);
  }
  if (ids.has("motion-energy-contrast")) reading["motion-energy-contrast"] = motionEnergyContrast(evidence);
  if (ids.has("colour-saturation")) reading["colour-saturation"] = meanSaturation(file);
  return reading;
}

// --- Scoring (pure) ---

export type PairReading = {
  manifest: string;
  variantId: string;
  kind: VariantKind;
  original: ClipReading;
  variant: ClipReading;
};

const worseBy = (worse: Worse, original: number, variant: number) =>
  worse === "higher" ? variant - original : original - variant;

export function calibrationReport(input: {
  manifests: string[];
  sensors: SensorSpec[];
  pairs: PairReading[];
  critic?: CalibrationReport["critic"];
  criticFailures?: CalibrationReport["failures"];
}): CalibrationReport {
  const kinds = [...new Set(input.pairs.map((pair) => pair.kind))].sort();
  const rows: CalibrationReport["sensors"] = [];
  const failures: CalibrationReport["failures"] = [];
  for (const sensor of input.sensors)
    for (const kind of kinds) {
      const role = sensor.targets.includes(kind) ? "target" : "control";
      const pairs = input.pairs.filter((pair) => pair.kind === kind);
      let n = 0;
      let detections = 0;
      let notMeasured = 0;
      let falseAlarms = 0;
      for (const pair of pairs) {
        const original = pair.original[sensor.id];
        const variant = pair.variant[sensor.id];
        if (original === undefined || variant === undefined) {
          notMeasured++;
          if (role === "target")
            failures.push({
              judge: sensor.id,
              kind,
              manifest: pair.manifest,
              variantId: pair.variantId,
              reason: `not measured on the ${original === undefined ? "original" : "variant"}`,
              original: original ?? null,
              variant: variant ?? null,
            });
          continue;
        }
        n++;
        const delta = worseBy(sensor.worse, original, variant);
        if (role === "target") {
          if (delta > DETECT_EPSILON) detections++;
          else
            failures.push({
              judge: sensor.id,
              kind,
              manifest: pair.manifest,
              variantId: pair.variantId,
              reason: Math.abs(delta) <= DETECT_EPSILON ? "no change" : "read the variant as better",
              original,
              variant,
            });
        } else if (delta > Math.max(ALARM_FLOOR, ALARM_SHARE * Math.abs(original))) falseAlarms++;
      }
      const accuracy = role === "target" && n ? round(detections / n, 3) : null;
      rows.push({
        sensor: sensor.id,
        kind,
        role,
        direction: `${sensor.worse} is worse`,
        n,
        detections: role === "target" ? detections : 0,
        accuracy,
        eligible: role === "target" && accuracy !== null && n >= MIN_PAIRS && accuracy >= MIN_ACCURACY,
        notMeasured,
        ...(role === "control" ? { falseAlarms } : {}),
      });
    }
  const byKind: CalibrationReport["byKind"] = {};
  for (const kind of kinds)
    byKind[kind] = {
      pairs: input.pairs.filter((pair) => pair.kind === kind).length,
      sensors: Object.fromEntries(
        rows.filter((row) => row.kind === kind && row.role === "target").map((row) => [row.sensor, row.accuracy]),
      ),
      ...(input.critic?.byKind[kind] ? { critic: input.critic.byKind[kind]!.accuracy } : {}),
    };
  for (const [kind, row] of Object.entries(input.critic?.byKind ?? {}))
    byKind[kind] ??= { pairs: row.n, sensors: {}, critic: row.accuracy };
  const eligibleGates = [
    ...rows
      .filter((row) => row.eligible)
      .map((row) => ({ judge: row.sensor, kind: row.kind, accuracy: row.accuracy!, n: row.n })),
    ...Object.entries(input.critic?.byKind ?? {})
      .filter(([, row]) => row.eligible)
      .map(([kind, row]) => ({
        judge: "creative-critic",
        kind: kind as VariantKind,
        accuracy: row.accuracy!,
        n: row.n,
      })),
  ];
  return CalibrationReportSchema.parse({
    schemaVersion: 1,
    manifests: input.manifests,
    rule: { minAccuracy: MIN_ACCURACY, minPairs: MIN_PAIRS },
    sensors: rows,
    byKind,
    eligibleGates,
    failures: [...failures, ...(input.criticFailures ?? [])],
    ...(input.critic ? { critic: input.critic } : {}),
  });
}

// --- Manifests ---

export function findManifests(options: { manifests?: string[]; dir?: string }): string[] {
  const found = new Set<string>((options.manifests ?? []).map((file) => path.resolve(file)));
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (name === "critic") continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "manifest.json") found.add(full);
    }
  };
  if (options.dir) {
    if (!existsSync(options.dir))
      throw new CliErrorObject({
        code: "FILE_NOT_FOUND",
        message: `No calibration directory at ${options.dir}. Run ref:degrade first.`,
      });
    walk(path.resolve(options.dir));
  }
  for (const file of found)
    if (!existsSync(file)) throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No manifest at ${file}.` });
  return [...found].sort();
}

export const readManifest = (file: string): CalibrationManifest =>
  CalibrationManifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));

/** Reads the original once and each variant against the clip it degrades. */
export function readPairs(manifestFiles: string[], sensors: SensorSpec[], repoRoot = process.cwd()): PairReading[] {
  const pairs: PairReading[] = [];
  for (const file of manifestFiles) {
    const manifest = readManifest(file);
    const dir = path.dirname(file);
    const label = path.relative(repoRoot, file).split(path.sep).join("/");
    const cache = new Map<string, ClipReading>();
    const read = (clip: { path: string; startSec: number }) => {
      if (!cache.has(clip.path)) {
        emitProgress(`Reading ${manifest.refId} ${manifest.segment.id} ${clip.path}`);
        cache.set(
          clip.path,
          readClip(path.join(dir, clip.path), { sensors, startSec: clip.startSec, grid: manifest.grid }),
        );
      }
      return cache.get(clip.path)!;
    };
    for (const variant of manifest.variants) {
      const against = variant.against === "originalLong" ? manifest.originalLong : manifest.original;
      if (!against)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: `${file}: ${variant.id} is against originalLong, which the manifest lacks.`,
        });
      pairs.push({
        manifest: label,
        variantId: variant.id,
        kind: variant.kind,
        original: read(against),
        variant: read(variant),
      });
    }
  }
  return pairs;
}

// --- Critic packets (blind) ---

const hex = (text: string) => createHash("sha256").update(text).digest("hex");

const QUESTION =
  "Which clip is better crafted: motion, cutting rhythm and sound against picture? Answer A, B, or tie only if you truly cannot tell.";
const RULES = [
  "You see each pair twice, in both orders, mixed among the others. Judge each question on its own.",
  "The strip shows ten evenly spaced frames of A, then of B, then ten consecutive frames of each from the middle: read held frames and strobing there.",
  "You cannot hear. The waveform image shows A's sound over B's; judge sound only from it and from the clips' timing.",
  "Answer in a JSON array of {pairId, order, winner: A|B|tie, reason}; the reason names the frames you used.",
];
/** A batch shows each pair once: the other order is another critic's. */
const BATCH_RULES = [
  "Each question is a different pair. Judge each on its own.",
  ...RULES.slice(1, 3),
  'Answer in a JSON array of {pairId, order: "ab", winner: A|B|tie, reason} with the question\'s pairId; the reason names the frames you used.',
];

function link(from: string, to: string) {
  rmSync(to, { force: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

function pairStrip(a: string, b: string, output: string) {
  const infoA = probeVideo(a);
  const infoB = probeVideo(b);
  const { width, height } = tileSize(infoA, infoA.height > infoA.width ? 120 : 200);
  const even = (file: string, info: typeof infoA, name: string): Cell[] =>
    evenSampleFrames(info, 10).map((frame) => ({
      image: decodeFrames(file, info, { startFrame: frame, count: 1, width, height })[0]!,
      label: `${name} ${formatTimecode(frame / info.fps)}`,
    }));
  const run = (file: string, info: typeof infoA, name: string): Cell[] => {
    const start = Math.max(0, Math.floor(info.frameCount / 2) - 5);
    return decodeFrames(file, info, { startFrame: start, count: 10, width, height }).map((image, index) => ({
      image,
      label: `${name} F${start + index}`,
    }));
  };
  const cells = [...even(a, infoA, "A"), ...even(b, infoB, "B"), ...run(a, infoA, "A"), ...run(b, infoB, "B")];
  writeImage(
    composeGrid(cells, { title: "ROWS: A SPREAD, B SPREAD, A CONSECUTIVE, B CONSECUTIVE", columns: 10 }),
    output,
  );
  if (infoA.hasAudio || infoB.hasAudio) {
    const wave = (file: string, info: typeof infoA) =>
      info.hasAudio ? renderWaveform(file, info.durationSec, 960, 90) : undefined;
    const waves = [wave(a, infoA), wave(b, infoB)];
    const blank = waves.find(Boolean)!;
    const cells2: Cell[] = waves.map((image, index) => ({
      image: image ?? blank,
      label: `${index ? "B" : "A"}${image ? "" : " NO SOUND"}`,
    }));
    writeImage(composeGrid(cells2, { title: "SOUND: A OVER B", columns: 1 }), output.replace(/\.png$/, "-sound.png"));
    return true;
  }
  return false;
}

/** Every pair of one reference segment shares its original: a critic who saw it in two pairs could spot it as the clip that repeats. */
const originalGroup = (pair: Pick<CriticKey["pairs"][number], "refId" | "segmentId" | "manifest">) =>
  `${pair.manifest}|${pair.refId}|${pair.segmentId}`;

/** Fewest batches that keep one original out of any batch twice: the two orders of each of its pairs each need a batch of their own. */
export function minimumBatches(
  pairs: readonly Pick<CriticKey["pairs"][number], "refId" | "segmentId" | "manifest">[],
): number {
  const counts = new Map<string, number>();
  for (const pair of pairs) counts.set(originalGroup(pair), (counts.get(originalGroup(pair)) ?? 0) + 1);
  return 2 * Math.max(0, ...counts.values());
}

/**
 * Deals each question (pair, order) to a batch so that no batch holds an original twice, in either order: the 2k
 * questions of an original with k pairs go to 2k different batches, from a seeded offset, so a critic never sees the
 * same original twice and never both orders of a pair. Refuses fewer batches than that needs.
 */
export function assignBatches(
  pairs: readonly Pick<CriticKey["pairs"][number], "pairId" | "refId" | "segmentId" | "manifest">[],
  batches: number,
  seed: string,
): { batch: number; pairId: string; order: "ab" | "ba" }[] {
  const minimum = minimumBatches(pairs);
  if (!Number.isInteger(batches) || batches < Math.max(2, minimum))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--batches ${batches} is too few: one original is in ${minimum / 2} pair(s), and each order of each pair needs its own batch. Pass --batches ${Math.max(2, minimum)} or more.`,
    });
  const groups = new Map<string, string[]>();
  for (const pair of pairs) groups.set(originalGroup(pair), [...(groups.get(originalGroup(pair)) ?? []), pair.pairId]);
  const dealt: { batch: number; pairId: string; order: "ab" | "ba" }[] = [];
  for (const [group, ids] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const offset = Number.parseInt(hex(`${seed}|batch|${group}`).slice(0, 8), 16) % batches;
    const questions = [...ids].sort().flatMap((pairId) => (["ab", "ba"] as const).map((order) => ({ pairId, order })));
    questions.forEach((question, index) => dealt.push({ ...question, batch: (offset + index) % batches }));
  }
  return dealt;
}

/** A question's id inside its batch: hashed from the seed, the batch, the pair and the order, so neither names nor order link two batches. */
const questionId = (seed: string, batch: number, pairId: string, order: string) =>
  `q${hex(`${seed}|question|${batch}|${pairId}|${order}`).slice(0, 12)}`;

/**
 * Results from one or more critics (one file per batch) as judgements by pair and order. Batch question ids map back
 * through the key; an id the key does not know, a question judged twice, or a batch question left unanswered is refused.
 */
export function mergeCriticResults(
  key: CriticKey,
  files: { file: string; judgements: CriticJudgement[] }[],
): CriticJudgement[] {
  const byId = new Map(
    (key.batches ?? []).flatMap((batch) =>
      batch.questions.map((question) => [question.id, { ...question, batch: batch.batch }] as const),
    ),
  );
  const pairIds = new Set(key.pairs.map((pair) => pair.pairId));
  const seen = new Map<string, string>();
  const merged: CriticJudgement[] = [];
  for (const { file, judgements } of files) {
    for (const row of judgements) {
      const mapped = byId.get(row.pairId);
      if (!mapped && (key.batches || !pairIds.has(row.pairId)))
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `${file}: ${row.pairId} is not a question of this answer key (seed ${key.seed}).`,
        });
      const judged = mapped ? { ...row, pairId: mapped.pairId, order: mapped.order } : row;
      const slot = `${judged.pairId}|${judged.order}`;
      if (seen.has(slot))
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `${file}: ${row.pairId}${mapped ? "" : ` ${row.order}`} was already judged in ${seen.get(slot)}.`,
        });
      seen.set(slot, file);
      merged.push(judged);
    }
  }
  if (key.batches) {
    const open = key.batches
      .map((batch) => ({
        batch: batch.batch,
        missing: batch.questions.filter((question) => !seen.has(`${question.pairId}|${question.order}`)).length,
        of: batch.questions.length,
      }))
      .filter((row) => row.missing);
    if (open.length)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Unanswered questions: ${open.map((row) => `batch-${row.batch} ${row.missing} of ${row.of}`).join(", ")}. Pass every batch's results, comma-separated.`,
      });
  }
  return merged;
}

/** The answer key sits beside the critic's folder, never in it. */
export const criticKeyPath = (criticDir: string) => path.join(path.dirname(path.resolve(criticDir)), "critic-key.json");

/**
 * Writes pairs.json, strips and neutrally named clip links into `outDir` (the critic's folder), and the answer key outside
 * it. With `batches`, writes batch-<k>.json and its own batch-<k>/ folder of copied clips instead, for one fresh critic
 * each: no original twice in a batch and the two orders of a pair in different batches (assignBatches).
 */
export function writeCriticPackets(
  manifestFiles: string[],
  outDir: string,
  seed: string,
  options: { keyFile?: string; repoRoot?: string; batches?: number } = {},
): { pairs: string; key: string; questions: number; batches?: string[] } {
  const repoRoot = options.repoRoot ?? process.cwd();
  const keyTarget = path.resolve(options.keyFile ?? criticKeyPath(outDir));
  if (!path.relative(path.resolve(outDir), keyTarget).startsWith(".."))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "The answer key must sit outside the critic's folder.",
    });
  mkdirSync(outDir, { recursive: true });
  const key: CriticKey = { schemaVersion: 1, seed, pairs: [] };
  const questions: CriticPairs["questions"] = [];
  if (options.batches !== undefined)
    return writeCriticBatches(manifestFiles, outDir, seed, options.batches, keyTarget, repoRoot);
  for (const file of manifestFiles) {
    const manifest = readManifest(file);
    const dir = path.dirname(file);
    for (const variant of manifest.variants) {
      const against = variant.against === "originalLong" ? manifest.originalLong! : manifest.original;
      const pairId = `p${hex(`${seed}|${manifest.refId}|${manifest.segment.id}|${variant.id}`).slice(0, 10)}`;
      const originalIsX = Number.parseInt(hex(`${seed}|${pairId}|x`).slice(0, 2), 16) % 2 === 0;
      const [x, y] = originalIsX ? [against.path, variant.path] : [variant.path, against.path];
      const xPath = path.join(dir, x);
      const yPath = path.join(dir, y);
      key.pairs.push({
        pairId,
        manifest: path.relative(repoRoot, file).split(path.sep).join("/"),
        refId: manifest.refId,
        segmentId: manifest.segment.id,
        variantId: variant.id,
        kind: variant.kind,
        original: originalIsX ? "x" : "y",
        x: path.relative(repoRoot, xPath).split(path.sep).join("/"),
        y: path.relative(repoRoot, yPath).split(path.sep).join("/"),
      });
      for (const order of ["ab", "ba"] as const) {
        const [a, b] = order === "ab" ? [xPath, yPath] : [yPath, xPath];
        const base = path.join(outDir, `${pairId}-${order}`);
        link(a, `${base}-A.mp4`);
        link(b, `${base}-B.mp4`);
        emitProgress(`Strip ${pairId} ${order}`);
        const sound = pairStrip(`${base}-A.mp4`, `${base}-B.mp4`, `${base}.png`);
        const rel = (target: string) => path.relative(outDir, target).split(path.sep).join("/");
        questions.push({
          pairId,
          order,
          strip: rel(`${base}.png`),
          a: rel(`${base}-A.mp4`),
          b: rel(`${base}-B.mp4`),
          ...(sound ? { waveform: rel(`${base}-sound.png`) } : {}),
        });
      }
    }
  }
  // Seeded shuffle: the two orders of a pair, and pairs of one kind, do not sit together.
  questions.sort((p, q) => hex(`${seed}|${p.pairId}|${p.order}`).localeCompare(hex(`${seed}|${q.pairId}|${q.order}`)));
  const pairs = writeJsonAtomic(path.join(outDir, "pairs.json"), {
    schemaVersion: 1,
    question: QUESTION,
    rules: RULES,
    questions,
  } satisfies CriticPairs);
  const keyFile = writeJsonAtomic(keyTarget, CriticKeySchema.parse(key));
  return { pairs, key: keyFile, questions: questions.length };
}

/** The answer key's pairs for these manifests: ids and which clip is the original follow the seed. */
function keyPairs(manifestFiles: string[], seed: string, repoRoot: string): CriticKey["pairs"] {
  return manifestFiles.flatMap((file) => {
    const manifest = readManifest(file);
    const dir = path.dirname(file);
    return manifest.variants.map((variant) => {
      const against = variant.against === "originalLong" ? manifest.originalLong! : manifest.original;
      const pairId = `p${hex(`${seed}|${manifest.refId}|${manifest.segment.id}|${variant.id}`).slice(0, 10)}`;
      const originalIsX = Number.parseInt(hex(`${seed}|${pairId}|x`).slice(0, 2), 16) % 2 === 0;
      const [x, y] = originalIsX ? [against.path, variant.path] : [variant.path, against.path];
      const rel = (clip: string) => path.relative(repoRoot, path.join(dir, clip)).split(path.sep).join("/");
      return {
        pairId,
        manifest: path.relative(repoRoot, file).split(path.sep).join("/"),
        refId: manifest.refId,
        segmentId: manifest.segment.id,
        variantId: variant.id,
        kind: variant.kind,
        original: originalIsX ? ("x" as const) : ("y" as const),
        x: rel(x),
        y: rel(y),
      };
    });
  });
}

function writeCriticBatches(
  manifestFiles: string[],
  outDir: string,
  seed: string,
  batches: number,
  keyTarget: string,
  repoRoot: string,
) {
  const pairs = keyPairs(manifestFiles, seed, repoRoot);
  const dealt = assignBatches(pairs, batches, seed);
  const byPair = new Map(pairs.map((pair) => [pair.pairId, pair]));
  const files: string[] = [];
  const keyBatches: NonNullable<CriticKey["batches"]> = [];
  for (let batch = 0; batch < batches; batch++) {
    const mine = dealt.filter((row) => row.batch === batch);
    if (!mine.length) continue;
    const folder = path.join(outDir, `batch-${batch}`);
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const entries = mine.map((row) => ({ ...row, id: questionId(seed, batch, row.pairId, row.order) }));
    const questions: CriticPairs["questions"] = [];
    for (const entry of entries) {
      const pair = byPair.get(entry.pairId)!;
      const [a, b] = entry.order === "ab" ? [pair.x, pair.y] : [pair.y, pair.x];
      const base = path.join(folder, entry.id);
      // Copies, never links: a link count or a shared inode would tie a clip to its labelled source.
      copyFileSync(path.resolve(repoRoot, a), `${base}-A.mp4`);
      copyFileSync(path.resolve(repoRoot, b), `${base}-B.mp4`);
      emitProgress(`Batch ${batch}: strip ${entry.id}`);
      const sound = pairStrip(`${base}-A.mp4`, `${base}-B.mp4`, `${base}.png`);
      const rel = (target: string) => path.relative(outDir, target).split(path.sep).join("/");
      questions.push({
        pairId: entry.id,
        order: "ab",
        strip: rel(`${base}.png`),
        a: rel(`${base}-A.mp4`),
        b: rel(`${base}-B.mp4`),
        ...(sound ? { waveform: rel(`${base}-sound.png`) } : {}),
      });
    }
    questions.sort((p, q) => p.pairId.localeCompare(q.pairId));
    files.push(
      writeJsonAtomic(path.join(outDir, `batch-${batch}.json`), {
        schemaVersion: 1,
        question: QUESTION,
        rules: BATCH_RULES,
        questions,
      } satisfies CriticPairs),
    );
    keyBatches.push({
      batch,
      questions: entries
        .map(({ id, pairId, order }) => ({ id, pairId, order }))
        .sort((p, q) => p.id.localeCompare(q.id)),
    });
  }
  const key = writeJsonAtomic(keyTarget, CriticKeySchema.parse({ schemaVersion: 1, seed, pairs, batches: keyBatches }));
  return { pairs: files[0]!, key, questions: dealt.length, batches: files };
}

/**
 * Both-orders rule (agreedPairs): a pair counts as right only when both orders name the original. A tie, a
 * disagreement or a missing order is not right; all pairs in the key are the denominator.
 */
export function criticAccuracy(
  key: CriticKey,
  judgements: CriticJudgement[],
): { critic: NonNullable<CalibrationReport["critic"]>; failures: CalibrationReport["failures"] } {
  const known = new Map(key.pairs.map((pair) => [pair.pairId, pair]));
  const translated: PairJudgement[] = judgements.flatMap((row) => {
    const pair = known.get(row.pairId);
    if (!pair) return [];
    const [first, second] =
      row.order === "ab" ? [`${row.pairId}:x`, `${row.pairId}:y`] : [`${row.pairId}:y`, `${row.pairId}:x`];
    return [{ first, second, winner: row.winner === "tie" ? "tie" : row.winner === "A" ? first : second }];
  });
  const outcomes = new Map(agreedPairs(translated).map((outcome) => [outcome.a.split(":")[0]!, outcome]));
  const byKind: NonNullable<CalibrationReport["critic"]>["byKind"] = {};
  let judged = 0;
  let agreed = 0;
  let correct = 0;
  const disagreements: string[] = [];
  const missing: string[] = [];
  const failures: CalibrationReport["failures"] = [];
  for (const pair of key.pairs) {
    const outcome = outcomes.get(pair.pairId);
    const both = outcome?.ab !== undefined && outcome?.ba !== undefined;
    const right = outcome?.agreed === true && outcome.winner === `${pair.pairId}:${pair.original}`;
    if (both) judged++;
    else missing.push(pair.pairId);
    if (outcome?.agreed) agreed++;
    else if (both) disagreements.push(pair.pairId);
    if (right) correct++;
    else
      failures.push({
        judge: "creative-critic",
        kind: pair.kind,
        manifest: pair.manifest,
        variantId: pair.variantId,
        reason: !both
          ? "not judged in both orders"
          : !outcome!.agreed
            ? outcome!.ab === "tie" || outcome!.ba === "tie"
              ? "a tie"
              : "the two orders disagree"
            : "preferred the degraded copy",
      });
    const row = (byKind[pair.kind] ??= { n: 0, detections: 0, accuracy: null, eligible: false });
    row.n++;
    if (right) row.detections++;
  }
  for (const row of Object.values(byKind)) {
    row.accuracy = row.n ? round(row.detections / row.n, 3) : null;
    row.eligible = row.n >= MIN_PAIRS && (row.accuracy ?? 0) >= MIN_ACCURACY;
  }
  return {
    critic: {
      pairs: key.pairs.length,
      judged,
      agreed,
      correct,
      accuracy: key.pairs.length ? round(correct / key.pairs.length, 3) : null,
      byKind,
      disagreements,
      missing,
    },
    failures,
  };
}
