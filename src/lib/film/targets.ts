import { correctedShots } from "../reference/corrected";
import type { ReferenceAudio, ReferenceCorpus, ReferenceEdit, ReferenceShots } from "../../types/reference";
import { FilmTargetsSchema, type AudioMap, type FilmTargets } from "../../types/film";
import type { FilmBoundary, FilmEvidence } from "./evidence";
import {
  audioAnchors,
  endCardDrop,
  gridFromMap,
  longestSilence,
  readAnchors,
  readFastSharp,
  readMotionSpread,
  readSections,
  readShots,
  readStills,
  readSync,
  softBoundaryShare,
  type AnchorReading,
  type BeatGridTimes,
} from "./readings";
import { round } from "./stats";
import { beatOffsetFrames, climaxOf } from "./tension";

// Tolerances. A reference gives a pace, not a number to copy: the bounds were set on the ten inbox films, which run from 8 to 70 cuts a minute.
const MEDIAN_LOW = 0.6;
const MEDIAN_HIGH = 1.5;
/** With few shots the median jumps from one shot to the next. */
const MEDIAN_HIGH_FEW_SHOTS = 2;
const FEW_SHOTS = 10;
const CUTS_LOW = 0.7;
const CUTS_HIGH = 1.5;
export const MIN_SHOTS_FOR_VARIETY = 5;
export const UNIFORM_VARIETY = 1.5;
const VARIETY_LOW = 0.5;
const STILL_SHARE_SLACK = 0.05;
const STILL_SHARE_HIGH = 1.5;
const STILL_LONGEST_HIGH = 1.25;
const STILL_LONGEST_SLACK = 0.3;
/** A reference that never stops still leaves a film room for one beat of hold. */
const STILL_LONGEST_FLOOR = 1;
/** Judged bursts can read 0.1 s; nobody should be told a median that short is the floor. */
const MEDIAN_FLOOR = 0.2;
/** Past this, p90/p10 is well clear of a uniform cadence. Bursty references reach 20, which is no reason to demand 10. */
const VARIETY_TARGET_CAP = 3;
const LOUDNESS_SLACK = 4;
/** Loudness is a delivery matter more than a style: these levels are acceptable whatever the reference does. */
const LOUDNESS_ALWAYS_LOW = -17;
const LOUDNESS_ALWAYS_HIGH = -11;
/** Below this, the reference is not cutting to its music: random cuts would score the same. */
export const MEANINGFUL_LIFT = 0.1;
/** Sync v2 lifts are ratio / chance: under this, a reference's cuts sit on its grid no more often than random cuts would. */
export const MEANINGFUL_SYNC_LIFT = 1.5;
/** Judged and detected cut counts further apart than this, as a share of the judged count, are reported. */
export const CUT_DISAGREEMENT = 0.25;
// Climax floors, after ReelMimic's distance.py peaks_component (MIT, © 2026 ReelMimic contributors). The curve's own JND
// floors (src/lib/film/tension.ts) keep a still film from showing a climax made of noise.
/** Below this the reference holds no breath before its hit, so none is asked. */
const BREATH_MEANINGFUL = 0.1;
const BREATH_SHARE = 0.5;
const RISE_SLACK = 1.8;
const RISE_EXTRA_FRAMES = 2;
const HOLD_MEANINGFUL_SEC = 0.3;
const HOLD_SHARE = 0.5;
const PROMINENCE_SHARE = 0.6;
const CLIMAX_PLACE_SLACK = 0.15;
const ON_BEAT_FRAMES = 1;

/** Marks targets written with sync metric v2; older targets carry only the v1 `cutsOnAudio*` keys. */
export const SYNC_METRIC_VERSION = 2;

/** Applies an analyst's judged corrections to measured shots: splits add a cut, moves shift one, merges and rejects remove one. */
export function judgedCutTimes(shots: ReferenceShots, edit: Pick<ReferenceEdit, "corrections">): number[] {
  return correctedShots(shots, edit)
    .slice(1)
    .map((shot) => shot.startSec);
}

export function boundariesFromShots(shots: ReferenceShots): FilmBoundary[] {
  return shots.shots.slice(1).map((shot) => ({
    timeSec: shot.startSec,
    startSec: shot.transitionStartSec ?? shot.startSec,
    endSec: shot.transitionEndSec ?? shot.startSec,
    kind: shot.transitionIn,
    confidence: shot.transitionConfidence,
    ...(shot.transitionMeasures ? { measures: shot.transitionMeasures } : {}),
  }));
}

export function gridFromAudioLayer(audio: ReferenceAudio | undefined): BeatGridTimes | undefined {
  const beatsSec = audio?.tempo?.beatsSec ?? [];
  return beatsSec.length ? { beatsSec, downbeatsSec: audio?.tempo?.downbeatsSec ?? [] } : undefined;
}

export function anchorsFromAudioLayer(audio: ReferenceAudio | undefined): number[] {
  const beats = audio?.tempo?.beatsSec ?? [];
  const downbeats = audio?.tempo?.downbeatsSec ?? [];
  return [...new Set([...beats, ...downbeats])].sort((a, b) => a - b);
}

export type TargetInput = {
  evidence: FilmEvidence;
  referenceId?: string;
  judgedCuts?: number[];
  /** Beat and downbeat times of the reference, merged: sync v1, kept for callers without a grid. */
  anchors?: number[];
  /** The reference's beats and downbeats, kept apart for sync v2, when no audio map was given. */
  grid?: BeatGridTimes;
  audioMap?: AudioMap;
};

export function targetsFromEvidence({
  evidence,
  referenceId,
  judgedCuts,
  anchors,
  grid,
  audioMap,
}: TargetInput): FilmTargets {
  const { durationSec } = evidence.video;
  const measured = readShots(
    evidence.boundaries.map((row) => row.timeSec),
    durationSec,
  );
  const judged = judgedCuts ? readShots(judgedCuts, durationSec) : undefined;
  // The analyst's judged cuts, when there are any, are the cut list: the detector misses flat swaps. It stays as a cross-check.
  const primary = judged ?? measured;
  // Soft boundaries are the detector's doubt; judged cuts have resolved it.
  const soft = judged ? 0 : softBoundaryShare(evidence.boundaries);
  const stills = readStills(evidence.motion, durationSec);
  const allCuts = [...new Set([...(judgedCuts ?? []), ...evidence.boundaries.map((row) => row.timeSec)])];
  const spread = readMotionSpread(evidence, allCuts);
  const fastSharp = readFastSharp(evidence, allCuts);
  const audio = evidence.audio;
  const audioLive = audio !== undefined && audio.integratedLufs !== null;

  const highMedian =
    (primary.lengths.length < FEW_SHOTS ? MEDIAN_HIGH_FEW_SHOTS : MEDIAN_HIGH) / (1 - Math.min(soft, 0.5));

  const beatGrid =
    audioMap && audioMap.tempo.gridTrust !== "none" ? gridFromMap(audioMap) : audioMap ? undefined : grid;
  const syncCuts = judgedCuts ?? evidence.boundaries.map((row) => row.timeSec);
  const sync =
    beatGrid?.beatsSec.length && syncCuts.length >= 3
      ? readSync(syncCuts, beatGrid, durationSec, evidence.video.fps)
      : undefined;
  const anchorTimes = sync ? [] : audioMap ? audioAnchors(audioMap) : (anchors ?? []);
  const cutReading: AnchorReading | undefined =
    primary.cuts >= 3 && anchorTimes.length ? readAnchors(syncCuts, anchorTimes, durationSec) : undefined;
  const sections = audio ? readSections(audio, durationSec, audioMap) : [];
  const drop = endCardDrop(sections);
  const climax = climaxOf(evidence.tension);
  const climaxOffset = climax && beatGrid ? beatOffsetFrames(climax, beatGrid.beatsSec, evidence.video.fps) : undefined;

  const measuredFrom: Record<string, number> = {
    durationSec: round(durationSec, 2),
    detectedCuts: measured.cuts,
    detectedMedianShotSec: measured.medianSec,
    detectedCutsPerMinute: measured.cutsPerMinute,
    variety: primary.variety,
    softBoundaryShare: softBoundaryShare(evidence.boundaries),
    stillShare: stills.share,
    longestStillSec: stills.longestSec,
    frozenSpans: stills.spans.length,
    ...(spread ? { motionSpreadShare: spread.share } : {}),
    ...(fastSharp && fastSharp.fast > 0 ? { fastSharpShare: fastSharp.share } : {}),
    ...(judged
      ? {
          judgedCuts: judged.cuts,
          judgedMedianShotSec: judged.medianSec,
          judgedCutsPerMinute: judged.cutsPerMinute,
          detectorCutError: judged.cuts - measured.cuts,
          cutsFromJudged: 1,
          detectorDisagreement: round(Math.abs(judged.cuts - measured.cuts) / Math.max(1, judged.cuts), 3),
        }
      : {}),
    ...(audio?.integratedLufs != null ? { integratedLufs: audio.integratedLufs } : {}),
    ...(audio?.truePeakDb != null ? { truePeakDb: audio.truePeakDb } : {}),
    ...(audio ? { longestSoundSilenceSec: longestSilence(audio) } : {}),
    ...(drop !== null ? { endCardDropDb: drop } : {}),
    ...(sync ? { syncMetric: SYNC_METRIC_VERSION, ...sync } : {}),
    ...(cutReading
      ? {
          cutsOnAudioRatio: cutReading.ratio,
          cutsOnAudioChance: cutReading.chance,
          cutsOnAudioLift: cutReading.lift,
          cutsOnAudioFullMap: audioMap ? 1 : 0,
        }
      : {}),
    ...(climax
      ? {
          climaxTimeSec: climax.timeSec,
          climaxTimeShare: round(climax.timeSec / durationSec, 3),
          climaxHeight: climax.height,
          climaxProminence: climax.prominence,
          climaxBuildSlope: climax.buildSlope,
          climaxBreathSec: climax.breathSec,
          climaxBreathDepth: climax.breathDepth,
          climaxRiseFrames: climax.riseFrames,
          climaxHoldSec: climax.holdSec,
          climaxDecaySec: climax.decaySec,
          ...(climaxOffset !== undefined ? { climaxBeatOffsetFrames: climaxOffset } : {}),
        }
      : {}),
  };

  return FilmTargetsSchema.parse({
    schemaVersion: 1,
    ...(referenceId ? { referenceId } : {}),
    source: "reference",
    measuredFrom,
    medianShotSec: {
      min: round(Math.max(primary.medianSec * MEDIAN_LOW, Math.min(MEDIAN_FLOOR, primary.medianSec * 0.9)), 2),
      max: round(primary.medianSec * highMedian, 2),
    },
    shotLengthVariety:
      primary.lengths.length >= MIN_SHOTS_FOR_VARIETY
        ? {
            min: round(
              Math.min(
                primary.variety * 0.9,
                Math.min(VARIETY_TARGET_CAP, Math.max(UNIFORM_VARIETY, primary.variety * VARIETY_LOW)),
              ),
              2,
            ),
          }
        : {},
    cutsPerMinute: {
      min: round(primary.cutsPerMinute * (1 - soft) * CUTS_LOW, 1),
      max: round(primary.cutsPerMinute * CUTS_HIGH, 1),
    },
    stillShare: { max: round(stills.share * STILL_SHARE_HIGH + STILL_SHARE_SLACK, 3) },
    longestStillSec: {
      max: round(Math.max(STILL_LONGEST_FLOOR, stills.longestSec * STILL_LONGEST_HIGH + STILL_LONGEST_SLACK), 2),
    },
    audioRequired: audioLive,
    loudnessLufs: audioLive
      ? {
          min: round(Math.min(audio.integratedLufs! - LOUDNESS_SLACK, LOUDNESS_ALWAYS_LOW), 1),
          max: round(Math.max(audio.integratedLufs! + LOUDNESS_SLACK, LOUDNESS_ALWAYS_HIGH), 1),
        }
      : {},
    cutsOnAudioRatio:
      cutReading && cutReading.lift >= MEANINGFUL_LIFT
        ? { min: round(cutReading.chance + cutReading.lift / 2, 3) }
        : {},
    ...(climax
      ? {
          climax: {
            timeShare: {
              min: round(Math.max(0, climax.timeSec / durationSec - CLIMAX_PLACE_SLACK), 3),
              max: round(Math.min(1, climax.timeSec / durationSec + CLIMAX_PLACE_SLACK), 3),
            },
            prominence: { min: round(climax.prominence * PROMINENCE_SHARE, 3) },
            breathDepth:
              climax.breathDepth >= BREATH_MEANINGFUL ? { min: round(climax.breathDepth * BREATH_SHARE, 3) } : {},
            riseFrames: { max: Math.round(climax.riseFrames * RISE_SLACK + RISE_EXTRA_FRAMES) },
            holdSec: climax.holdSec > HOLD_MEANINGFUL_SEC ? { min: round(climax.holdSec * HOLD_SHARE, 2) } : {},
            beatOffsetFrames:
              climaxOffset !== undefined && Math.abs(climaxOffset) <= ON_BEAT_FRAMES ? { max: ON_BEAT_FRAMES } : {},
          },
        }
      : {}),
  });
}

/** Under this many references a corpus range is one film's taste again. */
export const MIN_CORPUS_REFS = 3;
/**
 * Corpus pace bands are p10 / slack to p90 × slack: a gate, not an aim. The middle half (p25 to p75) failed half the professional references
 * by construction; calibrated on 20 references, 2026-11-15 (design-reference/calibration.md), leave-one-out on judged cuts: p10 to p90 alone
 * still failed 4 of 20 (the slowest and the fastest films), × 1.5 fails one of 20. The p25 and p75 stay in measuredFrom as the aim.
 */
export const CORPUS_PACE_SLACK = 1.5;
/** Variety floor: this share of the p10. Calibrated on 20 references, 2026-11-15: p10 = 2.9, so 2.2; one uniform professional film reads 1.4. */
export const CORPUS_VARIETY_SHARE = 0.75;
/** The fastest professional films hold a judged median shot of three frames at 30 fps; a gate never asks for slower than that. */
export const CORPUS_FASTEST_MEDIAN_SEC = 0.1;
/** Loudness: p10 and p90 widened by this many LU, never narrower than LOUDNESS_ALWAYS. Calibrated on 20 references, 2026-11-15: p10 = -16.8, p90 = -12.2 LUFS. */
export const CORPUS_LOUDNESS_SLACK = 2;

/**
 * Targets from many references at once: each pace metric's p10 to p90 widened by CORPUS_PACE_SLACK, the medians, p25 and p75 kept in measuredFrom.
 * Still share and longest still stay open: the corpus reads them from optical flow, film:measure from pixel change, and the
 * two are not the same unit. No climax either: that needs each film's media.
 */
export function targetsFromCorpus(corpus: ReferenceCorpus): { targets: FilmTargets; warnings: string[] } {
  const { metrics } = corpus;
  const median = metrics.medianShotSec;
  const cuts = metrics.cutsPerMinute;
  if (!median || !cuts)
    throw new Error(
      "The corpus has no reference with shots.json, so there is no pace to target. Run ref:analyze on the references first.",
    );
  const warnings: string[] = [];
  if (corpus.referenceIds.length < MIN_CORPUS_REFS)
    warnings.push(
      `Only ${corpus.referenceIds.length} reference(s) in the corpus: the ranges are one film's numbers, not a norm. Add references or use --reference.`,
    );
  const variety = metrics.shotLengthVariety;
  const lufs = metrics.integratedLufs;
  const audioLive = lufs !== undefined && lufs.n * 2 >= corpus.referenceIds.length;
  const measuredFrom: Record<string, number> = { corpusReferences: corpus.referenceIds.length };
  for (const [key, row] of Object.entries(metrics)) {
    const name = key[0]!.toUpperCase() + key.slice(1);
    measuredFrom[`corpus${name}Median`] = row.median;
    measuredFrom[`corpus${name}N`] = row.n;
    if (key === "medianShotSec" || key === "cutsPerMinute")
      Object.assign(measuredFrom, { [`corpus${name}P25`]: row.p25, [`corpus${name}P75`]: row.p75 });
  }
  // Sync v2, judged by film:measure against the corpus medians: a lift is asked only when the middle reference cuts on its grid.
  const lifts = {
    cutsOnBeatLift: metrics.cutsOnBeatLift?.median,
    cutsOnDownbeatFrameLift: metrics.cutsOnDownbeatFrameLift?.median,
    signedMedianCutToBeatSec: metrics.signedMedianCutToBeatSec?.median,
  };
  const sync = Object.fromEntries(Object.entries(lifts).filter(([, value]) => value !== undefined)) as Record<
    string,
    number
  >;
  if (Object.keys(sync).length) Object.assign(measuredFrom, { syncMetric: SYNC_METRIC_VERSION, ...sync });
  if (lufs) measuredFrom.integratedLufs = lufs.median;
  warnings.push(
    "Corpus targets carry no still-share, longest-still or climax limits: the corpus measures stillness from optical flow and has no media to draw a tension curve. Use --reference when a film's stillness matters.",
  );

  const targets = FilmTargetsSchema.parse({
    schemaVersion: 1,
    source: "corpus",
    corpus: {
      referenceIds: corpus.referenceIds,
      ...(corpus.playbook ? { playbook: corpus.playbook } : {}),
      ...(corpus.excluded.length ? { excluded: corpus.excluded } : {}),
    },
    measuredFrom,
    // No MEDIAN_FLOOR on the low side: a gate this wide only stops a film cutting faster than any professional one, and judged bursts read 0.1 s.
    medianShotSec: {
      min: round(Math.min(median.p10 / CORPUS_PACE_SLACK, CORPUS_FASTEST_MEDIAN_SEC), 2),
      max: round(Math.max(median.p90 * CORPUS_PACE_SLACK, MEDIAN_FLOOR), 2),
    },
    shotLengthVariety: variety
      ? { min: round(Math.min(Math.max(variety.p10 * CORPUS_VARIETY_SHARE, UNIFORM_VARIETY), VARIETY_TARGET_CAP), 2) }
      : {},
    cutsPerMinute: { min: round(cuts.p10 / CORPUS_PACE_SLACK, 1), max: round(cuts.p90 * CORPUS_PACE_SLACK, 1) },
    stillShare: {},
    longestStillSec: {},
    audioRequired: audioLive,
    loudnessLufs: audioLive
      ? {
          min: round(Math.min(lufs.p10 - CORPUS_LOUDNESS_SLACK, LOUDNESS_ALWAYS_LOW), 1),
          max: round(Math.max(lufs.p90 + CORPUS_LOUDNESS_SLACK, LOUDNESS_ALWAYS_HIGH), 1),
        }
      : {},
    cutsOnAudioRatio: {},
  });
  return { targets, warnings };
}

/** The detector's count against the judged one, and a note when they differ by more than CUT_DISAGREEMENT. */
export function cutCrossCheck(
  targets: FilmTargets,
): { detectedCuts: number; judgedCuts: number; disagreement: number; note?: string } | undefined {
  const { detectedCuts, judgedCuts, detectorDisagreement } = targets.measuredFrom;
  if (judgedCuts === undefined || detectedCuts === undefined || detectorDisagreement === undefined) return undefined;
  return {
    detectedCuts,
    judgedCuts,
    disagreement: detectorDisagreement,
    ...(detectorDisagreement > CUT_DISAGREEMENT
      ? {
          note: `The detector found ${detectedCuts} cuts, the analyst's edit ${judgedCuts} (${Math.round(detectorDisagreement * 100)}% apart). The targets follow the judged cuts; check edit.json if that surprises you.`,
        }
      : {}),
  };
}

/** "a:b", ":b" or "a:". */
export function parseRange(value: string | undefined): { min?: number; max?: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^(-?[\d.]+)?:(-?[\d.]+)?$/.exec(value.trim());
  if (!match || (match[1] === undefined && match[2] === undefined))
    throw new Error(`A range is "min:max", "min:" or ":max", got "${value}".`);
  return {
    ...(match[1] !== undefined ? { min: Number(match[1]) } : {}),
    ...(match[2] !== undefined ? { max: Number(match[2]) } : {}),
  };
}
