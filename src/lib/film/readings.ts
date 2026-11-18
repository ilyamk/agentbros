import { chanceRatio, hitRatio, lift, signedMedianOffset, SYNC_TOLERANCE_SEC } from "../reference/sync";
import type { AudioMap, CueSheet } from "../../types/film";
import type { FilmAudio, FilmBoundary, FilmEvidence } from "./evidence";
import { MOTION_SAMPLE_FPS } from "./evidence";
import { median, round, varietyRatio } from "./stats";

// One set of readings, used on both sides of a comparison: what a reference measured and what a render measures.

/** Under this share of pixels changing beyond noise, the picture has stopped: 29 pixels of 14,400. */
export const STILL_CHANGED_SHARE = 0.002;
const MIN_FROZEN_SEC = 0.5;
const CUE_MATCH_SEC = 0.12;
/** A transition cue marks where the move starts; the detector reads its middle. */
const TRANSITION_MATCH_SEC = 0.5;
const CUE_PEAK_WINDOW_SEC = 0.15;
const CUE_BASELINE_WINDOW_SEC = 0.5;
/** A flat swap stands out against what the frame was doing around it, however busy that is. */
const CUE_SPIKE_RATIO = 3;
const CUE_SPIKE_FLOOR = 0.003;
export const CUT_ANCHOR_TOLERANCE_SEC = 0.08;
const STRONG_EVENT = 0.6;
/** The last seconds of a film. Longer windows let the loud tail before a card hide how far the card drops. */
export const END_CARD_SEC = 3;

export type ShotReading = {
  cuts: number;
  lengths: number[];
  medianSec: number;
  variety: number;
  cutsPerMinute: number;
};

export function readShots(cutTimes: number[], durationSec: number): ShotReading {
  const inside = [...new Set(cutTimes.filter((time) => time > 0.001 && time < durationSec - 0.001))].sort(
    (a, b) => a - b,
  );
  const edges = [0, ...inside, durationSec];
  const lengths = edges.slice(1).map((edge, index) => edge - edges[index]!);
  return {
    cuts: inside.length,
    lengths,
    medianSec: round(median(lengths)),
    variety: round(varietyRatio(lengths), 2),
    cutsPerMinute: round((inside.length / durationSec) * 60, 1),
  };
}

/**
 * Boundaries the detector is least sure of. On cashfree and palmier, looked at pair by pair, a single-engine cut that moved under 55% of
 * the frame was mostly an element landing on a held collage (cashfree 7 of 9) though less often on palmier (1 of 4). So this widens a
 * tolerance; it does not delete anything.
 */
export function softBoundaryShare(boundaries: FilmBoundary[]): number {
  if (!boundaries.length) return 0;
  const soft = boundaries.filter(
    (row) =>
      ["match", "continuous", "unknown"].includes(row.kind) ||
      (row.measures?.engines === 1 && (row.measures?.changedFraction ?? 1) < 0.55),
  );
  return round(soft.length / boundaries.length);
}

export function frozenSpans(motion: FilmEvidence["motion"]): { startSec: number; endSec: number }[] {
  const spans: { startSec: number; endSec: number }[] = [];
  let start: number | undefined;
  let last = 0;
  const close = () => {
    if (start !== undefined && last - start >= MIN_FROZEN_SEC)
      spans.push({ startSec: round(start, 2), endSec: round(last, 2) });
    start = undefined;
  };
  for (const row of motion) {
    if (row.changed < STILL_CHANGED_SHARE) {
      start ??= row.timeSec - 1 / MOTION_SAMPLE_FPS;
      last = row.timeSec;
    } else close();
  }
  close();
  return spans;
}

export function readStills(motion: FilmEvidence["motion"], durationSec: number) {
  const spans = frozenSpans(motion);
  const total = spans.reduce((sum, span) => sum + span.endSec - span.startSec, 0);
  return {
    spans,
    share: round(total / durationSec),
    longestSec: round(Math.max(0, ...spans.map((span) => span.endSec - span.startSec)), 2),
  };
}

export type CueRow = {
  id: string;
  kind: "cut" | "transition";
  cueFrame: number;
  cueSec: number;
  actualFrame?: number;
  driftFrames?: number;
  state: "matched" | "flat-change" | "no-change";
};
export type CueReading = { rows: CueRow[]; confirmedTimes: number[]; unclaimedBoundaries: number[]; precision: number };

/** True when the picture jumps at this moment, rather than just being in motion, as it is in any busy film. */
export function changeSpikesAt(motion: FilmEvidence["motion"], timeSec: number): boolean {
  const peak = Math.max(
    0,
    ...motion.filter((row) => Math.abs(row.timeSec - timeSec) <= CUE_PEAK_WINDOW_SEC).map((row) => row.changed),
  );
  const around = motion.filter((row) => {
    const distance = Math.abs(row.timeSec - timeSec);
    return distance > CUE_PEAK_WINDOW_SEC && distance <= CUE_BASELINE_WINDOW_SEC;
  });
  return peak >= CUE_SPIKE_FLOOR && peak >= CUE_SPIKE_RATIO * median(around.map((row) => row.changed));
}

const boundaryDistance = (row: FilmBoundary, time: number) =>
  time >= row.startSec && time <= row.endSec ? 0 : Math.abs(row.timeSec - time);

/** A cue sheet says which boundaries are real. A cue only counts if the picture really changes there, so it cannot be claimed into existence. */
export function readCues(evidence: FilmEvidence, cueSheet: CueSheet): CueReading {
  const fps = evidence.video.fps;
  const cues = cueSheet.cues.flatMap((cue) =>
    cue.kind === "cut" || cue.kind === "transition" ? [{ ...cue, kind: cue.kind }] : [],
  );
  const claimed = new Set<FilmBoundary>();
  const rows: CueRow[] = cues.map((cue) => {
    const cueSec = cue.frame / cueSheet.fps;
    const nearest = [...evidence.boundaries].sort(
      (a, b) => boundaryDistance(a, cueSec) - boundaryDistance(b, cueSec),
    )[0];
    if (
      nearest &&
      boundaryDistance(nearest, cueSec) <= (cue.kind === "transition" ? TRANSITION_MATCH_SEC : CUE_MATCH_SEC)
    ) {
      claimed.add(nearest);
      const drift = boundaryDistance(nearest, cueSec) * fps;
      return {
        id: cue.id,
        kind: cue.kind,
        cueFrame: cue.frame,
        cueSec: round(cueSec),
        actualFrame: Math.round(nearest.timeSec * fps),
        driftFrames: round(drift, 1),
        state: "matched",
      };
    }
    return {
      id: cue.id,
      kind: cue.kind,
      cueFrame: cue.frame,
      cueSec: round(cueSec),
      state: changeSpikesAt(evidence.motion, cueSec) ? "flat-change" : "no-change",
    };
  });
  return {
    rows,
    confirmedTimes: rows.filter((row) => row.state !== "no-change").map((row) => row.cueSec),
    unclaimedBoundaries: evidence.boundaries.filter((row) => !claimed.has(row)).map((row) => round(row.timeSec, 2)),
    precision: evidence.boundaries.length ? round(claimed.size / evidence.boundaries.length, 2) : 1,
  };
}

/** Film time: the map is in track time, and the film may start part way into the track. */
export function audioAnchors(map: AudioMap, musicOffsetSec = 0): number[] {
  const useBeats = map.tempo.gridTrust !== "none";
  const times = [
    ...(useBeats ? map.beatsSec : []),
    ...(useBeats ? map.downbeatsSec : []),
    ...map.events.filter((event) => event.strength >= STRONG_EVENT).map((event) => event.timeSec),
    ...map.keyMoments.map((moment) => moment.timeSec),
    ...map.phrases.map((phrase) => phrase.startSec),
    ...map.sections.map((section) => section.startSec),
  ];
  return [...new Set(times.map((time) => round(time - musicOffsetSec)))]
    .filter((time) => time >= 0)
    .sort((a, b) => a - b);
}

/** Beats and downbeats alone: what a reference was measured on when it had no audio map. */
export function beatAnchors(map: AudioMap, musicOffsetSec = 0): number[] {
  return [...new Set([...map.beatsSec, ...map.downbeatsSec].map((time) => round(time - musicOffsetSec)))]
    .filter((time) => time >= 0)
    .sort((a, b) => a - b);
}

export type AnchorReading = { ratio: number; chance: number; lift: number };

export function readAnchors(cuts: number[], anchors: number[], durationSec: number): AnchorReading | undefined {
  const ratio = hitRatio(cuts, anchors, CUT_ANCHOR_TOLERANCE_SEC);
  const chance = chanceRatio(anchors, CUT_ANCHOR_TOLERANCE_SEC, durationSec);
  if (ratio === undefined || chance === undefined) return undefined;
  return { ratio, chance, lift: round(ratio - chance) };
}

/** Beats and downbeats in film time. */
export type BeatGridTimes = { beatsSec: number[]; downbeatsSec: number[] };

export function gridFromMap(map: AudioMap, musicOffsetSec = 0): BeatGridTimes {
  const shift = (times: number[]) => times.map((time) => round(time - musicOffsetSec)).filter((time) => time >= 0);
  return { beatsSec: shift(map.beatsSec), downbeatsSec: shift(map.downbeatsSec) };
}

/**
 * Sync metric v2 (src/lib/reference/sync.ts): lifts are ratio / chance, so 1 is chance and 2 is twice it. Downbeats are
 * judged within one frame, beats within the reference tolerance; the signed median is negative when cuts lead the beat.
 */
export type SyncReading = {
  cutsOnBeatRatio?: number;
  cutsOnBeatChance?: number;
  cutsOnBeatLift?: number;
  cutsOnDownbeatFrameRatio?: number;
  cutsOnDownbeatFrameChance?: number;
  cutsOnDownbeatFrameLift?: number;
  signedMedianCutToBeatSec?: number;
};

export function readSync(cuts: number[], grid: BeatGridTimes, durationSec: number, fps: number): SyncReading {
  if (!cuts.length) return {};
  const frameReach = 1 / (fps > 0 ? fps : 30) + 0.0015;
  const beatRatio = hitRatio(cuts, grid.beatsSec, SYNC_TOLERANCE_SEC);
  const beatChance = chanceRatio(grid.beatsSec, SYNC_TOLERANCE_SEC, durationSec);
  const downRatio = hitRatio(cuts, grid.downbeatsSec, frameReach);
  const downChance = chanceRatio(grid.downbeatsSec, frameReach, durationSec);
  const reading: SyncReading = {
    cutsOnBeatRatio: beatRatio,
    cutsOnBeatChance: beatChance,
    cutsOnBeatLift: lift(beatRatio, beatChance),
    cutsOnDownbeatFrameRatio: downRatio,
    cutsOnDownbeatFrameChance: downChance,
    cutsOnDownbeatFrameLift: lift(downRatio, downChance),
    signedMedianCutToBeatSec: signedMedianOffset(cuts, grid.beatsSec),
  };
  return Object.fromEntries(Object.entries(reading).filter(([, value]) => value !== undefined)) as SyncReading;
}

const energyMean = (values: number[]) =>
  10 * Math.log10(values.reduce((sum, value) => sum + 10 ** (value / 10), 0) / values.length);

export type LoudnessSection = { startSec: number; endSec: number; lufs: number | null };

/** Loudness per section, with the last section being the end card. */
export function readSections(
  audio: FilmAudio,
  durationSec: number,
  map?: AudioMap,
  musicOffsetSec = 0,
): LoudnessSection[] {
  const endCard = Math.max(0, durationSec - END_CARD_SEC);
  const inner = map?.sections.length
    ? map.sections.map((section) => section.startSec - musicOffsetSec).filter((time) => time > 0 && time < endCard)
    : [endCard / 3, (2 * endCard) / 3];
  const edges = [0, ...inner, endCard, durationSec];
  return edges
    .slice(1)
    .map((edge, index) => {
      const start = edges[index]!;
      const readings = audio.perSecond
        .filter((row) => row.timeSec + 0.5 >= start && row.timeSec + 0.5 < edge)
        .map((row) => row.lufs ?? -70);
      return {
        startSec: round(start, 2),
        endSec: round(edge, 2),
        lufs: readings.length ? round(energyMean(readings), 1) : null,
      };
    })
    .filter((section) => section.endSec > section.startSec);
}

/** How far the end card sits under the rest of the film, in dB. Positive is quieter. */
export function endCardDrop(sections: LoudnessSection[]): number | null {
  const card = sections.at(-1);
  const rest = sections
    .slice(0, -1)
    .map((section) => section.lufs)
    .filter((lufs): lufs is number => lufs !== null);
  if (!card || !rest.length) return null;
  return round(energyMean(rest) - (card.lufs ?? -70), 1);
}

export const longestSilence = (audio: FilmAudio) =>
  round(Math.max(0, ...audio.silences.map((span) => span.endSec - span.startSec)), 2);

// --- Slop signatures in pixels (design-reference/slop-catalogue.md) ---

/** A sample this close to a cut is the cut, which changes everything and stays sharp. */
const CUT_EXCLUSION_SEC = 0.15;
/** Above this share of grid cells changing at once, the whole frame is moving. */
// provisional: recalibrated from ref:corpus
export const SPREAD_FRAME_SHARE = 0.7;
/** One frame moving at least this share of the picture is fast motion. */
// provisional: recalibrated from ref:corpus
export const FAST_CHANGE_SHARE = 0.15;
/** Under this share a frame is settled enough to be the sharpness reference. */
const SETTLED_CHANGE_SHARE = 0.02;
/** A fast frame at least this crisp, relative to the settled frames of its own shot, has no motion blur. */
// provisional: recalibrated from ref:corpus
export const SHARP_RATIO = 0.8;

const nearCut = (timeSec: number, cuts: number[]) => cuts.some((cut) => Math.abs(cut - timeSec) <= CUT_EXCLUSION_SEC);

/** Share of motion samples, away from cuts, in which over SPREAD_FRAME_SHARE of the grid moved: everything moving at once. */
export function readMotionSpread(
  evidence: Pick<FilmEvidence, "motion" | "spread">,
  cuts: number[],
): { share: number; samples: number; spans: { startSec: number; endSec: number }[] } | undefined {
  if (!evidence.spread || evidence.spread.length !== evidence.motion.length) return undefined;
  const rows = evidence.motion
    .map((row, index) => ({ timeSec: row.timeSec, spread: evidence.spread![index]! }))
    .filter((row) => !nearCut(row.timeSec, cuts));
  const spans: { startSec: number; endSec: number }[] = [];
  let hits = 0;
  for (const row of rows) {
    if (row.spread <= SPREAD_FRAME_SHARE) continue;
    hits++;
    const last = spans.at(-1);
    if (last && row.timeSec - last.endSec <= 1.5 / MOTION_SAMPLE_FPS) last.endSec = row.timeSec;
    else spans.push({ startSec: round(row.timeSec - 1 / MOTION_SAMPLE_FPS, 2), endSec: row.timeSec });
  }
  return { share: rows.length ? round(hits / rows.length) : 0, samples: rows.length, spans };
}

/**
 * Fast frames, away from cuts, as crisp as the settled frames of their own shot: motion with no blur, the rendered look. Shots without a
 * settled frame give no reference and are not judged.
 */
export function readFastSharp(
  evidence: Pick<FilmEvidence, "sharpness" | "video">,
  cuts: number[],
): { share: number; fast: number; sharp: number; times: number[] } | undefined {
  const samples = evidence.sharpness?.samples;
  if (!samples) return undefined;
  const edges = [0, ...[...cuts].sort((a, b) => a - b), Infinity];
  const shotOf = (timeSec: number) => edges.findIndex((edge, index) => timeSec >= edge && timeSec < edges[index + 1]!);
  const usable = samples.filter((row) => !nearCut(row.timeSec, cuts));
  const settledByShot = new Map<number, number[]>();
  for (const row of usable)
    if (row.change < SETTLED_CHANGE_SHARE)
      settledByShot.set(shotOf(row.timeSec), [...(settledByShot.get(shotOf(row.timeSec)) ?? []), row.sharpness]);
  let fast = 0;
  const times: number[] = [];
  for (const row of usable) {
    if (row.change < FAST_CHANGE_SHARE) continue;
    const settled = settledByShot.get(shotOf(row.timeSec));
    if (!settled?.length) continue;
    fast++;
    const reference = median(settled);
    if (reference > 0 && row.sharpness >= SHARP_RATIO * reference) times.push(row.timeSec);
  }
  return { share: fast ? round(times.length / fast) : 0, fast, sharp: times.length, times };
}
