import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { CliErrorObject } from "../cli";
import { readShots, readSync } from "../film/readings";
import { median, percentile, round } from "../film/stats";
import { gridFromAudioLayer, judgedCutTimes, MIN_SHOTS_FOR_VARIETY } from "../film/targets";
import { suspectFitReasons } from "./motion";
import { privateReferenceIds } from "./private";
import { normaliseText } from "./speech-text";
import { chanceRatio, hitRatio, lift, SYNC_TOLERANCE_SEC } from "./sync";
import {
  REFERENCE_LAYERS,
  ReferenceCorpusSchema,
  primitiveKind,
  TechniqueFunctionSchema,
  type CorpusDistribution,
  type ReferenceAudio,
  type ReferenceCorpus,
  type ReferenceEdit,
  type ReferenceLayerFile,
  type ReferenceMotion,
  type ReferenceShots,
  type ReferenceSource,
  type ReferenceSpeechText,
  type ReferenceSync,
  type ReferenceTechniques,
} from "../../types/reference";

// Every analysed reference read together, so an agent picks a pace or a technique from many films' numbers, not one film's taste.

export const CORPUS_FILE = "_corpus.json";
/** Optical-flow speed under this, in frame widths a second, counts as still: about one pixel a second on a 1080 frame. Flow layers only. */
export const STILL_FLOW_THRESHOLD = 0.001;
const MIN_STILL_SEC = 0.5;
/** Screen text whose box centre sits within this share of the frame width from the middle counts as centred. */
export const CENTRE_TOLERANCE = 0.06;
/** OCR samples of the same text closer than this are one appearance. Samples run at 2 fps, so touching spans merge. */
const TEXT_MERGE_GAP_SEC = 0.05;
const MIN_TEXT_CONFIDENCE = 0.5;
const MIN_TEXT_CHARACTERS = 2;
/** Onsets this close to a cut count as the cut's sound: the sync layer's own tolerance. */
export const ONSET_WINDOW_SEC = SYNC_TOLERANCE_SEC;

export const CORPUS_DEFINITIONS: Record<string, string> = {
  cutsPerMinute:
    "Cuts a minute: judged cuts (shots.json with edit.json corrections) when edit.json exists, else the detector's.",
  medianShotSec: "Median shot length in seconds, from the same cut list.",
  shotCount: "Shots in the film, from the same cut list.",
  shotLengthVariety: `Shot length p90 / p10; only with ${MIN_SHOTS_FOR_VARIETY} or more shots. 1 is a metronome.`,
  flowStillShare: `Share of the film where motion.json optical flow stays under ${STILL_FLOW_THRESHOLD} frame widths a second for ${MIN_STILL_SEC} s or more. Flow layers only (opencv), not the ffmpeg fallback. A different unit from film:measure's pixel-change stills.`,
  flowLongestStillSec: "Longest such still stretch in seconds.",
  cutsOnBeatRatio: "Share of cuts within 80 ms of a beat (audio.json grid, recomputed on the judged cuts).",
  cutsOnBeatLift: "cutsOnBeatRatio / the ratio random cuts reach: 1 is chance.",
  cutsOnDownbeatFrameLift: "Cuts within one frame of a downbeat, over chance.",
  signedMedianCutToBeatSec: "Median of cut minus nearest beat; negative cuts before the beat.",
  cutsOnOnsetRatio: "Share of cuts within 80 ms of an audio onset (audio.json onsetsSec).",
  cutsOnOnsetLift: "cutsOnOnsetRatio over chance at this onset density. Dense onsets keep it near 1.",
  onsetsPerCut: "Mean audio onsets within 80 ms of each cut: how much sound marks a cut (SFX, hits).",
  integratedLufs: "Integrated loudness of the film's sound (audio.json).",
  screenTextDwellSec:
    "Median seconds one piece of screen text stays up: OCR samples of the same text merged across time.",
  centredTextShare: `Share of screen-text appearances whose box centre is within ±${CENTRE_TOLERANCE * 100}% of the frame width from the middle.`,
  screenTextPerMinute: "Screen-text appearances a minute, after merging. OCR noise and UI text count too.",
};

const unitShare = (value: number) => round(value, 3);

export function distribution(values: number[]): CorpusDistribution | undefined {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return undefined;
  const at = (share: number) => round(percentile(finite, share), 3);
  return {
    n: finite.length,
    min: at(0),
    p10: at(0.1),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: at(1),
  };
}

type LayerRead<T> = { value?: T; issue?: string; present: boolean };

function readLayerSafely<File extends ReferenceLayerFile>(
  directory: string,
  file: File,
): LayerRead<z.output<(typeof REFERENCE_LAYERS)[File]>> {
  const target = path.join(directory, file);
  if (!existsSync(target)) return { present: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    return { present: true, issue: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = REFERENCE_LAYERS[file].safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { present: true, issue: first ? `${first.path.join(".")}: ${first.message}` : "invalid" };
  }
  return { present: true, value: parsed.data as z.output<(typeof REFERENCE_LAYERS)[File]> };
}

type Layers = {
  source?: ReferenceSource;
  shots?: ReferenceShots;
  speechText?: ReferenceSpeechText;
  audio?: ReferenceAudio;
  motion?: ReferenceMotion;
  sync?: ReferenceSync;
  edit?: ReferenceEdit;
  techniques?: ReferenceTechniques;
};

/** Still stretches from optical-flow energy. */
export function flowStills(
  motion: ReferenceMotion,
  durationSec: number,
): { share: number; longestSec: number } | undefined {
  const engine = `${motion.method} ${motion.status?.engine ?? ""}`.toLowerCase();
  if (!/opencv|farneback|flow/.test(engine) || /ffmpeg/.test(engine)) return undefined;
  const curve = motion.energyCurve;
  if (curve.length < 2 || durationSec <= 0) return undefined;
  const step = median(curve.slice(1).map((row, index) => row.timeSec - curve[index]!.timeSec));
  const spans: number[] = [];
  let start: number | undefined;
  let last = 0;
  const close = () => {
    if (start !== undefined && last - start >= MIN_STILL_SEC) spans.push(last - start);
    start = undefined;
  };
  for (const row of curve) {
    if (row.energy < STILL_FLOW_THRESHOLD) {
      start ??= Math.max(0, row.timeSec - step);
      last = row.timeSec;
    } else close();
  }
  close();
  return {
    share: unitShare(spans.reduce((sum, span) => sum + span, 0) / durationSec),
    longestSec: round(Math.max(0, ...spans), 2),
  };
}

/** Screen text as appearances: OCR samples of the same text (its `textId`, or its normalised words in an older full layer) merged while they touch. */
export function textAppearances(
  items: ReferenceSpeechText["screenText"]["items"],
): { key: string; startSec: number; endSec: number; centreX?: number }[] {
  const keyOf = (item: (typeof items)[number]) =>
    item.text !== undefined
      ? `t:${normaliseText(item.text)}`
      : item.textId !== undefined
        ? `#${item.textId}`
        : undefined;
  const charsOf = (item: (typeof items)[number]) =>
    item.text !== undefined ? normaliseText(item.text).length : (item.chars ?? 0);
  const kept = items.filter(
    (item) =>
      (item.confidence ?? 1) >= MIN_TEXT_CONFIDENCE &&
      charsOf(item) >= MIN_TEXT_CHARACTERS &&
      keyOf(item) !== undefined,
  );
  const byText = new Map<string, typeof kept>();
  for (const item of kept) {
    const key = keyOf(item)!;
    byText.set(key, [...(byText.get(key) ?? []), item]);
  }
  const appearances: { key: string; startSec: number; endSec: number; centreX?: number }[] = [];
  for (const [key, group] of byText) {
    const sorted = [...group].sort((a, b) => a.startSec - b.startSec);
    let current: (typeof appearances)[number] | undefined;
    for (const item of sorted) {
      if (current && item.startSec <= current.endSec + TEXT_MERGE_GAP_SEC)
        current.endSec = Math.max(current.endSec, item.endSec);
      else {
        if (current) appearances.push(current);
        current = {
          key,
          startSec: item.startSec,
          endSec: item.endSec,
          ...(item.box ? { centreX: item.box.x + item.box.width / 2 } : {}),
        };
      }
    }
    if (current) appearances.push(current);
  }
  return appearances.sort((a, b) => a.startSec - b.startSec);
}

export function easeName(ease: NonNullable<NonNullable<ReferenceMotion["shots"][number]["camera"]>["ease"]>): string {
  if (ease.pick === "gsap") return ease.gsap;
  if (ease.pick === "bezier") return ease.css;
  const { mass, stiffness, damping } = ease.spring.remotion;
  return `spring(mass ${mass}, stiffness ${stiffness}, damping ${damping})`;
}

export const EASE_FAMILIES = ["linear", "in", "out", "inOut", "spring", "steps", "unknown"] as const;
export type EaseFamily = (typeof EASE_FAMILIES)[number];
/** A normalised ease: its family, a strength where the name gives one (sine 0.5, power1 1 … power4 4, expo 5; steps: the count), and the curve's base name. */
export type NormalisedEase = { family: EaseFamily; strength?: number; curve?: string };

const CURVE_STRENGTH: Record<string, number> = {
  sine: 0.5,
  quad: 1,
  power1: 1,
  cubic: 2,
  power2: 2,
  quart: 3,
  power3: 3,
  circ: 3,
  quint: 4,
  power4: 4,
  strong: 4,
  expo: 5,
  back: 2,
  elastic: 2,
  bounce: 2,
};

/** Progress at time share u of a CSS cubic-bezier, by bisection on x. */
function bezierAt([x1, y1, x2, y2]: [number, number, number, number], u: number): number {
  const at = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (at(middle, x1, x2) < u) low = middle;
    else high = middle;
  }
  return at((low + high) / 2, y1, y2);
}

/** A cubic-bezier's family: slow first quarter is `in`, fast is `out`, both is `inOut`, neither is `linear`. */
export function bezierFamily(points: [number, number, number, number]): EaseFamily {
  if (
    points.some((value) => !Number.isFinite(value)) ||
    points[0] < 0 ||
    points[0] > 1 ||
    points[2] < 0 ||
    points[2] > 1
  )
    return "unknown";
  const early = bezierAt(points, 0.25) - 0.25;
  const late = bezierAt(points, 0.75) - 0.75;
  const margin = 0.04;
  if (Math.abs(early) <= margin && Math.abs(late) <= margin) return "linear";
  if (early < -margin && late > margin) return "inOut";
  if (early <= margin && late <= margin) return early + late < 0 ? "in" : "out";
  if (early >= -margin && late >= -margin) return "out";
  return "unknown";
}

/**
 * Free ease text to a controlled vocabulary, so ref:corpus counts `power2.out`, `cubic-bezier(.2,.8,.3,1)` and
 * `ease-out` together. Reads the first ease named: `power2.in (exit); power2.out (entry)` is `in`; give phases to keep both.
 */
export function normaliseEaseName(text: string | undefined): NormalisedEase {
  const value = (text ?? "").trim().toLowerCase();
  if (!value) return { family: "unknown" };
  const bezier = /cubic-bezier\(\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*\)/.exec(value);
  const steps = /^(?:steps|stepped|hold|step-start|step-end)\b(?:\s*\(\s*(\d+))?/.exec(value);
  if (steps) return { family: "steps", ...(steps[1] ? { strength: Number(steps[1]) } : {}), curve: "steps" };
  if (/^spring\b/.test(value)) return { family: "spring", curve: "spring" };
  if (bezier && value.indexOf("cubic-bezier") === value.search(/[a-z]/)) {
    const points = bezier.slice(1, 5).map(Number) as [number, number, number, number];
    return { family: bezierFamily(points), curve: "cubic-bezier" };
  }
  if (/^(?:none|linear)\b/.test(value)) return { family: "linear", curve: "linear" };
  const css = /^ease(-in-out|-in|-out)?\b/.exec(value);
  if (css)
    return {
      family: css[1] === "-in-out" ? "inOut" : css[1] === "-in" ? "in" : css[1] === "-out" ? "out" : "inOut",
      curve: "css",
    };
  const named =
    /^(sine|quad|cubic|quart|quint|strong|expo|circ|back|elastic|bounce|power([0-4]))(?:\.?(inout|in|out)|\b)/.exec(
      value.replace(/^ease(?=[a-z])/, "").replace(/[-_ ]/g, ""),
    );
  if (named) {
    const curve = named[1]!;
    if (curve === "power0") return { family: "linear", curve: "linear" };
    const direction = named[3] ?? "out";
    return {
      family: direction === "inout" ? "inOut" : direction === "in" ? "in" : "out",
      strength: CURVE_STRENGTH[curve] ?? (named[2] ? Number(named[2]) : undefined),
      curve,
    };
  }
  if (/\bspring\b/.test(value)) return { family: "spring", curve: "spring" };
  if (/\b(?:steps?|hold|stepped)\b/.test(value)) return { family: "steps", curve: "steps" };
  if (/\blinear\b/.test(value)) return { family: "linear", curve: "linear" };
  return { family: "unknown" };
}

/** The key ref:corpus counts eases by: the family, with its strength when it has one (`out:3`). */
export const easeFamilyKey = (ease: NormalisedEase) =>
  ease.strength !== undefined && ease.family !== "linear" && ease.family !== "spring"
    ? `${ease.family}:${ease.strength}`
    : ease.family;

/** A judged cut strictly inside a fit's window, one frame in from each end: the fit spans a cut the detector missed. */
export function cutInside(
  window: { startSec?: number; endSec?: number },
  cuts: number[],
  fps: number,
): number | undefined {
  if (window.startSec === undefined || window.endSec === undefined) return undefined;
  const frame = 1 / fps;
  return cuts.find((cut) => cut > window.startSec! + frame && cut < window.endSec! - frame);
}

type EaseFit = { shotId: string; ease: string; excluded?: string };

/** One reference's numbers. Layers that are missing or invalid leave their metrics out. */
export function referenceMetrics(layers: Layers): {
  metrics: Record<string, number>;
  cutsFrom?: "judged" | "detector";
  eases: string[];
  fits: EaseFit[];
} {
  const metrics: Record<string, number> = {};
  const durationSec = layers.source?.probe.durationSec ?? layers.shots?.shots.at(-1)?.endSec;
  const fps = layers.source?.probe.fps ?? 30;
  const eases: string[] = [];
  const fits: EaseFit[] = [];
  if (!durationSec) return { metrics, eases, fits };
  let cuts: number[] | undefined;
  let cutsFrom: "judged" | "detector" | undefined;
  if (layers.shots) {
    cuts = layers.edit
      ? judgedCutTimes(layers.shots, layers.edit)
      : layers.shots.shots.slice(1).map((shot) => shot.startSec);
    cutsFrom = layers.edit ? "judged" : "detector";
    const reading = readShots(cuts, durationSec);
    metrics.cutsPerMinute = reading.cutsPerMinute;
    metrics.medianShotSec = round(reading.medianSec, 3);
    metrics.shotCount = reading.lengths.length;
    if (reading.lengths.length >= MIN_SHOTS_FOR_VARIETY) metrics.shotLengthVariety = reading.variety;
  }
  if (layers.motion) {
    const stills = flowStills(layers.motion, durationSec);
    if (stills) {
      metrics.flowStillShare = stills.share;
      metrics.flowLongestStillSec = stills.longestSec;
    }
    // Only cuts the analyst added (split, move) can fall inside a fit: the detector's cuts bound the shots it was fitted in.
    const detectorCuts = new Set((layers.shots?.shots ?? []).slice(1).map((shot) => shot.startSec));
    const hidden =
      cutsFrom === "judged"
        ? (cuts ?? []).filter((cut) => ![...detectorCuts].some((time) => Math.abs(time - cut) < 1e-3))
        : [];
    const spans = new Map((layers.shots?.shots ?? []).map((shot) => [shot.id, shot]));
    for (const shot of layers.motion.shots) {
      const camera = shot.camera;
      if (!camera) continue;
      const add = (name: string, window: { startSec?: number; endSec?: number }, suspect: string[]) => {
        const cut = cutInside(window, hidden, fps);
        const excluded =
          cut !== undefined
            ? `spans the judged cut at ${cut} s`
            : suspect.length
              ? `suspect: ${suspect.join("; ")}`
              : undefined;
        fits.push({ shotId: shot.shotId, ease: name, ...(excluded ? { excluded } : {}) });
        if (!excluded) eases.push(name);
      };
      if (camera.ease)
        add(
          easeName(camera.ease),
          { startSec: camera.startSec, endSec: camera.endSec },
          suspectFitReasons(camera, spans.get(shot.shotId)),
        );
      for (const move of camera.otherMoves ?? [])
        if (move.ease) add(move.ease, { startSec: move.startSec, endSec: move.startSec + move.durationSec }, []);
    }
  }
  const inside = (cuts ?? []).filter((time) => time > 0.001 && time < durationSec - 0.001);
  if (inside.length >= 3) {
    const grid = gridFromAudioLayer(layers.audio);
    if (grid) {
      const sync = readSync(inside, grid, durationSec, fps);
      for (const key of [
        "cutsOnBeatRatio",
        "cutsOnBeatLift",
        "cutsOnDownbeatFrameLift",
        "signedMedianCutToBeatSec",
      ] as const)
        if (sync[key] !== undefined) metrics[key] = sync[key]!;
    } else if (layers.sync) {
      const { cutsOnBeatRatio, cutsOnBeatChance, cutsOnBeatLift } = layers.sync.metrics;
      const fallback = cutsOnBeatLift ?? lift(cutsOnBeatRatio, cutsOnBeatChance);
      if (fallback !== undefined) metrics.cutsOnBeatLift = fallback;
      if (cutsOnBeatRatio !== undefined) metrics.cutsOnBeatRatio = cutsOnBeatRatio;
    }
    const onsets = layers.audio?.onsetsSec ?? [];
    if (onsets.length) {
      const ratio = hitRatio(inside, onsets, ONSET_WINDOW_SEC);
      const chance = chanceRatio(onsets, ONSET_WINDOW_SEC, durationSec);
      if (ratio !== undefined) metrics.cutsOnOnsetRatio = ratio;
      const onsetLift = lift(ratio, chance);
      if (onsetLift !== undefined) metrics.cutsOnOnsetLift = onsetLift;
      metrics.onsetsPerCut = round(
        inside.reduce(
          (sum, cut) => sum + onsets.filter((onset) => Math.abs(onset - cut) <= ONSET_WINDOW_SEC).length,
          0,
        ) / inside.length,
        3,
      );
    }
  }
  const lufs = layers.audio?.loudness?.integratedLufs;
  if (layers.audio?.hasAudio !== false && lufs !== undefined && Number.isFinite(lufs)) metrics.integratedLufs = lufs;
  const screenText = layers.speechText?.screenText;
  if (screenText?.available && screenText.items.length) {
    const appearances = textAppearances(screenText.items);
    if (appearances.length) {
      metrics.screenTextDwellSec = round(median(appearances.map((row) => row.endSec - row.startSec)), 3);
      metrics.screenTextPerMinute = round((appearances.length / durationSec) * 60, 1);
      const boxed = appearances.filter((row) => row.centreX !== undefined);
      if (boxed.length)
        metrics.centredTextShare = unitShare(
          boxed.filter((row) => Math.abs(row.centreX! - 0.5) <= CENTRE_TOLERANCE).length / boxed.length,
        );
    }
  }
  return { metrics, ...(cutsFrom ? { cutsFrom } : {}), eases, fits };
}

const missingName = (name: string) => name.split(",")[0]!.trim().toLowerCase();

/** A technique ease's families: one per phase when it has phases, else its name or its cubic-bezier's. */
export function techniqueEaseFamilies(
  ease: NonNullable<ReferenceTechniques["techniques"][number]["ease"]>,
): NormalisedEase[] {
  const one = (name?: string, points?: [number, number, number, number]): NormalisedEase => {
    const named = normaliseEaseName(name);
    return named.family === "unknown" && points ? { family: bezierFamily(points), curve: "cubic-bezier" } : named;
  };
  return ease.phases?.length
    ? ease.phases.map((phase) => one(phase.name, phase.cubicBezier))
    : [one(ease.name, ease.cubicBezier)];
}

const labelOf = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");

function recurrence(rows: { name: string; refId: string }[], minRefs = 1) {
  const byName = new Map<string, Set<string>>();
  for (const { name, refId } of rows) if (name) byName.set(name, (byName.get(name) ?? new Set()).add(refId));
  return [...byName]
    .map(([name, refs]) => ({ name, count: refs.size, refs: [...refs].sort() }))
    .filter((row) => row.count >= minRefs)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

const sortedCounts = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));

export type CorpusRequest = { libraryRoot: string; exclude?: string[]; playbook?: string };

/** Every directory under the library root that holds a reference: `inbox` and names starting with `_` are skipped. */
export function corpusCandidates(libraryRoot: string): string[] {
  if (!existsSync(libraryRoot) || !statSync(libraryRoot).isDirectory())
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No reference library at ${libraryRoot}.` });
  return readdirSync(libraryRoot)
    .filter((name) => name !== "inbox" && !name.startsWith("_") && !name.startsWith("."))
    .filter((name) => statSync(path.join(libraryRoot, name)).isDirectory())
    .sort();
}

export function buildCorpus({ libraryRoot, exclude = [], playbook }: CorpusRequest): ReferenceCorpus {
  const excluded = new Set(exclude.map((id) => id.trim()).filter(Boolean));
  const warnings: string[] = [];
  const references: ReferenceCorpus["references"] = [];
  const perMetric = new Map<string, number[]>();
  const easeCounts: Record<string, number> = {};
  const motionFamilies: Record<string, number> = {};
  const techniqueFamilies: Record<string, number> = {};
  const excludedEaseFits: NonNullable<ReferenceCorpus["excludedEaseFits"]> = [];
  const byFunction: ReferenceCorpus["techniques"]["byFunction"] = Object.fromEntries(
    [...TechniqueFunctionSchema.options, "unclassified"].map((key) => [key, []]),
  );
  const missing: { name: string; refId: string }[] = [];
  const moves: { name: string; refId: string }[] = [];
  const techniqueNames: { name: string; refId: string }[] = [];
  let unnamedMoves = 0;
  let techniqueCount = 0;

  // Private references count in the numbers like any other; their ids are marked so nobody copies them into a tracked file.
  const privateIds = new Set(privateReferenceIds(libraryRoot));
  for (const id of corpusCandidates(libraryRoot)) {
    if (excluded.has(id)) continue;
    const directory = path.join(libraryRoot, id);
    if (!existsSync(path.join(directory, "source.json"))) {
      warnings.push(`${id}: no source.json, skipped. Run ref:add.`);
      continue;
    }
    const reads = Object.fromEntries(
      (Object.keys(REFERENCE_LAYERS) as ReferenceLayerFile[]).map((file) => [file, readLayerSafely(directory, file)]),
    ) as { [File in ReferenceLayerFile]: LayerRead<z.output<(typeof REFERENCE_LAYERS)[File]>> };
    const source = reads["source.json"].value;
    if (playbook && !source?.playbooks?.includes(playbook)) continue;
    const layers: Layers = {
      source,
      shots: reads["shots.json"].value,
      speechText: reads["speech-text.json"].value,
      audio: reads["audio.json"].value,
      motion: reads["motion.json"].value,
      sync: reads["sync.json"].value,
      edit: reads["edit.json"].value,
      techniques: reads["techniques.json"].value,
    };
    const files = Object.keys(reads) as ReferenceLayerFile[];
    const invalid = files.flatMap((file) => (reads[file].issue ? [{ file, issue: reads[file].issue! }] : []));
    const unavailable = files.flatMap((file) => {
      const value = reads[file].value as
        | { status?: { available: boolean }; speech?: { available: boolean }; screenText?: { available: boolean } }
        | undefined;
      if (!value) return [];
      return [
        value.status && !value.status.available ? file : undefined,
        value.speech && !value.speech.available ? `${file}#speech` : undefined,
        value.screenText && !value.screenText.available ? `${file}#screenText` : undefined,
      ].filter((entry): entry is string => !!entry);
    });
    for (const row of invalid) warnings.push(`${id}/${row.file} is invalid and was left out: ${row.issue}`);

    const { metrics, cutsFrom, eases, fits } = referenceMetrics(layers);
    for (const [key, value] of Object.entries(metrics)) perMetric.set(key, [...(perMetric.get(key) ?? []), value]);
    for (const name of eases) {
      easeCounts[name] = (easeCounts[name] ?? 0) + 1;
      const key = easeFamilyKey(normaliseEaseName(name));
      motionFamilies[key] = (motionFamilies[key] ?? 0) + 1;
    }
    for (const fit of fits)
      if (fit.excluded) excludedEaseFits.push({ refId: id, shotId: fit.shotId, ease: fit.ease, reason: fit.excluded });

    for (const technique of layers.techniques?.techniques ?? []) {
      techniqueCount += 1;
      const families = technique.ease ? techniqueEaseFamilies(technique.ease) : [];
      for (const family of families)
        techniqueFamilies[easeFamilyKey(family)] = (techniqueFamilies[easeFamilyKey(family)] ?? 0) + 1;
      byFunction[technique.function ?? "unclassified"]!.push({
        refId: id,
        techniqueId: technique.id,
        name: technique.name,
        spans: technique.spans,
        route: technique.route,
        difficulty: technique.difficulty,
        ...(technique.timing ? { timing: technique.timing } : {}),
        ...(technique.ease
          ? { ease: technique.ease, easeFamily: families.map((family) => family.family).join("+") }
          : {}),
        ...(technique.sound ? { sound: technique.sound } : {}),
      });
      for (const primitive of technique.requiredPrimitives) {
        const parsed = primitiveKind(primitive);
        if (parsed.kind === "missing") missing.push({ name: missingName(parsed.name), refId: id });
      }
      techniqueNames.push({ name: technique.name.trim().toLowerCase().replace(/\s+/g, " "), refId: id });
    }
    for (const move of layers.edit?.signatureMoves ?? []) {
      if (move.value.name?.trim()) moves.push({ name: labelOf(move.value.name), refId: id });
      else unnamedMoves += 1;
    }

    references.push({
      id,
      ...(privateIds.has(id) ? { private: true } : {}),
      ...(source?.playbooks ? { playbooks: source.playbooks } : {}),
      ...(source ? { durationSec: source.probe.durationSec } : {}),
      ...(cutsFrom ? { cutsFrom } : {}),
      present: files.filter((file) => reads[file].present),
      missing: files.filter((file) => !reads[file].present),
      invalid,
      unavailable,
      metrics,
    });
  }

  if (playbook && !references.length)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `No reference in ${libraryRoot} is tagged for playbook ${playbook}. Tag one with ref:add --id ID --file FILE --playbooks ${playbook}, or drop --playbook.`,
    });
  if (!references.length) warnings.push(`No analysed reference in ${libraryRoot}.`);

  const metrics: ReferenceCorpus["metrics"] = {};
  for (const key of Object.keys(CORPUS_DEFINITIONS)) {
    const row = distribution(perMetric.get(key) ?? []);
    if (row) metrics[key] = row;
  }
  for (const entries of Object.values(byFunction))
    entries.sort((a, b) => a.refId.localeCompare(b.refId) || a.techniqueId.localeCompare(b.techniqueId));

  return ReferenceCorpusSchema.parse({
    schemaVersion: 1,
    libraryRoot,
    ...(playbook ? { playbook } : {}),
    excluded: [...excluded].sort(),
    referenceIds: references.map((row) => row.id),
    ...(references.some((row) => row.private)
      ? { privateReferenceIds: references.filter((row) => row.private).map((row) => row.id) }
      : {}),
    definitions: CORPUS_DEFINITIONS,
    metrics,
    easeNames: sortedCounts(easeCounts),
    easeFamilies: { motion: sortedCounts(motionFamilies), techniques: sortedCounts(techniqueFamilies) },
    excludedEaseFits,
    techniques: { count: techniqueCount, byFunction },
    gaps: {
      missingPrimitives: recurrence(missing),
      signatureMoves: recurrence(moves),
      unnamedSignatureMoves: unnamedMoves,
      techniqueNames: recurrence(techniqueNames, 2),
    },
    references,
    warnings,
  });
}
