import {
  FilmMeasureSchema,
  type AudioMap,
  type CueSheet,
  type FilmMeasure,
  type FilmTargets,
  type MusicDecision,
} from "../../types/film";
import type { FilmEvidence } from "./evidence";
import {
  audioAnchors,
  beatAnchors,
  endCardDrop,
  FAST_CHANGE_SHARE,
  gridFromMap,
  longestSilence,
  readAnchors,
  readCues,
  readFastSharp,
  readMotionSpread,
  readSections,
  readShots,
  readStills,
  readSync,
  SPREAD_FRAME_SHARE,
  type CueReading,
  type SyncReading,
} from "./readings";
import { MEANINGFUL_LIFT, MEANINGFUL_SYNC_LIFT, UNIFORM_VARIETY } from "./targets";
import { describeRange, hasLimit, inRange, median, round, type Range } from "./stats";
import { FLASH_FIX, flashLines } from "../sensors/flash";
import { beatOffsetFrames, climaxOf } from "./tension";
import { cutSoundCoverageLeg, readRenderOnsets, type PlacedSounds } from "./cut-sound";
import { sfxEvidenceLeg } from "./sfx-evidence";
import type { SoundReview } from "../audio/review-evidence";

type Leg = FilmMeasure["legs"][number];

const MIN_SHOTS_FOR_VARIETY = 5;
const TRUE_PEAK_LIMIT_DB = -1;
const END_CARD_FAIL_DB = 15;
const END_CARD_WARN_DB = 10;
const SILENCE_LIMIT_SEC = 2.5;
const DRIFT_LIMIT_FRAMES = 2;
const MISSING_CUE_SHARE = 0.1;
const DELIBERATE_SILENCE_SLACK_SEC = 0.5;
/** Picture may lead the beat (a cut one frame early is the default lead), never trail it: sound before picture is noticed at ~45 ms. */
const LATE_CUT_FRAMES = 1;
const EARLY_CUT_FRAMES = 3;

export type MeasureInput = {
  evidence: FilmEvidence;
  targets?: FilmTargets;
  targetsPath?: string;
  audioMap?: AudioMap;
  cueSheet?: CueSheet;
  decision?: MusicDecision;
  /** Attack starts of the render's sound (readRenderOnsets), for cut-sound-coverage. */
  onsetsSec?: number[];
  /** sfx:cues' placed sounds: cut-sound-coverage measures each cue's lead from them. */
  soundCues?: PlacedSounds;
  /** Saved Earshot audits of the placed SFX files (readSoundReviews), for the advisory sfx-evidence leg. */
  sfxReviews?: SoundReview[];
};

const skipped = (id: string, message: string, fix?: string): Leg => ({
  id,
  status: "skipped",
  value: null,
  message,
  ...(fix ? { fix } : {}),
  evidence: [],
});

function rangeLeg(
  id: string,
  value: number,
  target: Range | undefined,
  what: string,
  unit: string,
  fixes: { low: string; high: string },
  evidence: string[] = [],
): Leg {
  if (!target || !hasLimit(target))
    return {
      id,
      status: "skipped",
      value,
      message: `${what} reads ${value}${unit}. No target, so it was not judged.`,
      fix: "Pass --targets from film:targets.",
      evidence,
    };
  if (inRange(value, target))
    return {
      id,
      status: "pass",
      value,
      target,
      message: `${what} reads ${value}${unit}, within ${describeRange(target, unit)}.`,
      evidence,
    };
  const low = target.min !== undefined && value < target.min;
  return {
    id,
    status: "fail",
    value,
    target,
    message: `${what} reads ${value}${unit}; the target is ${describeRange(target, unit)}.`,
    fix: low ? fixes.low : fixes.high,
    evidence,
  };
}

function audioLegs({ evidence, targets, audioMap, cueSheet, decision }: MeasureInput): Leg[] {
  const audio = evidence.audio;
  const silenceChosen =
    decision !== undefined &&
    (decision.route === "silence" || decision.delivery === "none" || decision.delivery === "native-on-platform");
  const required = !silenceChosen && (targets?.audioRequired ?? true);
  const legs: Leg[] = [];

  if (!audio) {
    legs.push(
      required
        ? {
            id: "audio-present",
            status: "fail",
            value: 0,
            message: "The render has no audio stream. A film is sound and picture.",
            fix: "Mux the audio master with film:render --audio. If silence really is the decision, record it in music-decision.json with route silence and pass --decision.",
            evidence: [],
          }
        : {
            id: "audio-present",
            status: "pass",
            value: 0,
            message: silenceChosen
              ? `No audio stream, as decided: route ${decision!.route}, delivery ${decision!.delivery}.`
              : "No audio stream, and the targets do not require one.",
            evidence: [],
          },
    );
    return legs;
  }
  legs.push({
    id: "audio-present",
    status: "pass",
    value: 1,
    message: "The render has an audio stream.",
    evidence: [],
  });

  const silent = audio.integratedLufs === null;
  if (silent) {
    legs.push({
      id: "audio-not-silent-throughout",
      status: required ? "fail" : "warn",
      value: null,
      message: "The audio stream is there but silent all the way through.",
      fix: "The mix is empty or muted. Check the master with audio:analyze and mux it again.",
      evidence: [],
    });
    return legs;
  }
  legs.push({
    id: "audio-not-silent-throughout",
    status: "pass",
    value: audio.integratedLufs,
    message: `The soundtrack measures ${audio.integratedLufs} LUFS.`,
    evidence: [],
  });

  legs.push(
    rangeLeg("loudness-integrated", audio.integratedLufs!, targets?.loudnessLufs, "Integrated loudness", " LUFS", {
      low: "Raise the master's gain, checking true peak.",
      high: "Lower the master's gain; keep the dynamics.",
    }),
  );

  // A reference that clips earns a warning for the same overs, not a pass and not a block.
  const peakLimit = Math.max(TRUE_PEAK_LIMIT_DB, (targets?.measuredFrom.truePeakDb ?? -Infinity) + 0.5);
  const peak = audio.truePeakDb;
  legs.push(
    peak === null
      ? skipped("true-peak", "True peak could not be read.")
      : peak > peakLimit
        ? {
            id: "true-peak",
            status: "fail",
            value: peak,
            target: { max: peakLimit },
            message: `True peak is ${peak} dBFS, over the ${peakLimit} dBFS limit, so it clips after encoding.`,
            fix: "Limit the master to -1 dBTP and mux again.",
            evidence: [],
          }
        : peak > TRUE_PEAK_LIMIT_DB
          ? {
              id: "true-peak",
              status: "warn",
              value: peak,
              target: { max: TRUE_PEAK_LIMIT_DB },
              message: `True peak is ${peak} dBFS, over ${TRUE_PEAK_LIMIT_DB} dBFS, though no hotter than the reference.`,
              fix: "Limit the master to -1 dBTP before delivery.",
              evidence: [],
            }
          : {
              id: "true-peak",
              status: "pass",
              value: peak,
              target: { max: TRUE_PEAK_LIMIT_DB },
              message: `True peak is ${peak} dBFS.`,
              evidence: [],
            },
  );

  const offset = cueSheet?.musicOffsetSec ?? 0;
  const sections = readSections(audio, evidence.video.durationSec, audioMap, offset);
  const drop = endCardDrop(sections);
  const table = sections.map((section) => `${section.startSec}-${section.endSec} s: ${section.lufs ?? "silent"} LUFS`);
  if (drop === null)
    legs.push(skipped("loudness-sections", "The film is too short to compare its end card with the rest."));
  else {
    const failAt = Math.max(END_CARD_FAIL_DB, (targets?.measuredFrom.endCardDropDb ?? -Infinity) + 3);
    const warnAt = Math.max(END_CARD_WARN_DB, (targets?.measuredFrom.endCardDropDb ?? -Infinity) + 1);
    const status = drop >= failAt ? "fail" : drop >= warnAt ? "warn" : "pass";
    legs.push({
      id: "loudness-sections",
      status,
      value: drop,
      target: { max: failAt },
      message: `The end card sits ${drop} dB under the rest of the film.`,
      ...(status === "pass"
        ? {}
        : {
            fix: "The ending has fallen away. Keep the music under the end card, or land a final hit on it, then fade only in the last second.",
          }),
      evidence: table,
    });
  }

  const longest = longestSilence(audio);
  const deliberate = (span: { startSec: number; endSec: number }) =>
    audioMap?.silences.some(
      (named) => Math.abs(named.startSec - offset - span.startSec) <= DELIBERATE_SILENCE_SLACK_SEC,
    ) ?? false;
  const unplanned = audio.silences.filter((span) => !deliberate(span));
  const unplannedLongest = round(Math.max(0, ...unplanned.map((span) => span.endSec - span.startSec)), 2);
  const silenceLimit = Math.max(SILENCE_LIMIT_SEC, (targets?.measuredFrom.longestSoundSilenceSec ?? -Infinity) + 1);
  legs.push({
    id: "sound-silence",
    status: unplannedLongest > silenceLimit ? "fail" : "pass",
    value: longest,
    target: { max: silenceLimit },
    message: `Longest silence is ${longest} s; the longest not named on the audio map is ${unplannedLongest} s.`,
    ...(unplannedLongest > silenceLimit
      ? {
          fix: "Fill the gap with music or room tone. A silence is a decision: write it into the audio map and the cue sheet, and keep it under the limit.",
        }
      : {}),
    evidence: audio.silences.map(
      (span) => `${span.startSec}-${span.endSec} s${deliberate(span) ? " (on the audio map)" : ""}`,
    ),
  });
  return legs;
}

const syncText = (reading: SyncReading) =>
  `On beats ${Math.round((reading.cutsOnBeatRatio ?? 0) * 100)}% of cuts, ${reading.cutsOnBeatLift ?? "n/a"}× chance; on downbeats within a frame ${Math.round((reading.cutsOnDownbeatFrameRatio ?? 0) * 100)}%, ${reading.cutsOnDownbeatFrameLift ?? "n/a"}× chance; signed median cut to beat ${reading.signedMedianCutToBeatSec ?? "n/a"} s.`;

/** Sync metric v2 against targets that carry it: lifts over chance (ratio / chance), beats and downbeats apart. */
function syncLegV2(
  cuts: number[],
  { evidence, targets, audioMap, cueSheet }: MeasureInput & { audioMap: AudioMap; targets: FilmTargets },
): Leg {
  const id = "cuts-on-audio";
  const reading = readSync(
    cuts,
    gridFromMap(audioMap, cueSheet?.musicOffsetSec ?? 0),
    evidence.video.durationSec,
    evidence.video.fps,
  );
  if (reading.cutsOnBeatLift === undefined)
    return skipped(id, "The audio map has no beats in the film's time, or chance is zero.");
  const reference = targets.measuredFrom;
  const text = `${syncText(reading)} Reference: beats ${reference.cutsOnBeatLift ?? "n/a"}×, downbeats ${reference.cutsOnDownbeatFrameLift ?? "n/a"}×.`;
  const fix =
    "Lock structural cuts to downbeats and surges from beatGridFromMap, with the cut's lead (one frame early), then rerun edit:snap.";
  const dimensions = [
    { name: "beats", ref: reference.cutsOnBeatLift, ours: reading.cutsOnBeatLift },
    { name: "downbeats", ref: reference.cutsOnDownbeatFrameLift, ours: reading.cutsOnDownbeatFrameLift },
  ].filter(
    (row): row is { name: string; ref: number; ours: number | undefined } =>
      row.ref !== undefined && row.ref >= MEANINGFUL_SYNC_LIFT,
  );
  // Beat sync is a choice, not a norm: the corpus's median lift is 1.0 (design-reference/calibration.md), so cuts off the grid are not
  // flagged unless the targets cut on theirs.
  if (!dimensions.length)
    return {
      id,
      status: "pass",
      value: reading.cutsOnBeatRatio ?? null,
      message: `${text} The ${targets.source === "corpus" ? "corpus does" : "reference does"} not cut to its grid, so no lift is asked.`,
      evidence: [],
    };
  const needs = dimensions.map((row) => ({ ...row, needed: round(1 + (row.ref - 1) / 2, 2) }));
  const met = needs.filter((row) => row.ours !== undefined && row.ours >= row.needed);
  const evidenceLines = needs.map(
    (row) => `${row.name}: ${row.ours ?? "n/a"}× against ${row.needed}× needed (reference ${row.ref}×)`,
  );
  return met.length
    ? { id, status: "pass", value: reading.cutsOnBeatRatio ?? null, message: text, evidence: evidenceLines }
    : {
        id,
        status: "fail",
        value: reading.cutsOnBeatRatio ?? null,
        message: `${text} The reference cuts on its grid and this film does not, at half its lift or better.`,
        fix,
        evidence: evidenceLines,
      };
}

/** Where cuts sit against the beat: the picture may lead by a frame or two, never trail. Advisory. */
function cutOffsetLeg(cuts: number[], { evidence, targets, audioMap, cueSheet }: MeasureInput): Leg {
  const id = "cut-to-beat-offset";
  if (!audioMap || audioMap.tempo.gridTrust === "none")
    return skipped(id, "No trusted beat grid, so where cuts sit against the beat was not read.");
  if (cuts.length < 3) return skipped(id, `Only ${cuts.length} cuts.`);
  const reading = readSync(
    cuts,
    gridFromMap(audioMap, cueSheet?.musicOffsetSec ?? 0),
    evidence.video.durationSec,
    evidence.video.fps,
  );
  const offset = reading.signedMedianCutToBeatSec;
  if (offset === undefined) return skipped(id, "The audio map has no beats in the film's time.");
  // Where cuts sit against the beat means something only when cuts are meant to be on it: the targets cut on their grid, or this film does.
  // Off the grid the median offset is noise (professional references: median lift 1.0, design-reference/calibration.md).
  const onGrid = (value: number | undefined) => (value ?? 0) >= MEANINGFUL_SYNC_LIFT;
  const meant =
    onGrid(targets?.measuredFrom.cutsOnBeatLift) ||
    onGrid(targets?.measuredFrom.cutsOnDownbeatFrameLift) ||
    onGrid(reading.cutsOnBeatLift) ||
    onGrid(reading.cutsOnDownbeatFrameLift);
  if (!meant)
    return {
      ...skipped(
        id,
        `Neither the targets nor these cuts sit on the beat (lift ${reading.cutsOnBeatLift ?? "n/a"}×, downbeats ${reading.cutsOnDownbeatFrameLift ?? "n/a"}×, under ${MEANINGFUL_SYNC_LIFT}×), so the offset from it says nothing.`,
      ),
      value: offset,
    };
  const frame = 1 / evidence.video.fps;
  const target = { min: round(-EARLY_CUT_FRAMES * frame - 0.0015, 3), max: round(LATE_CUT_FRAMES * frame + 0.0015, 3) };
  const referenceOffset = targets?.measuredFrom.signedMedianCutToBeatSec;
  const message = `Median cut sits ${offset} s from its nearest beat (negative is early)${referenceOffset !== undefined ? `; the reference's sits ${referenceOffset} s` : ""}.`;
  if (inRange(offset, target)) return { id, status: "pass", value: offset, target, message, evidence: [] };
  return {
    id,
    status: "warn",
    value: offset,
    target,
    message,
    fix:
      offset > 0
        ? 'Cuts trail the beat, so the sound arrives first and the edit feels late. Land each cut on leadFrame(anchor, "cut").'
        : "Cuts run well ahead of the beat. Use the per-kind lead from leadFrame, not a hand offset.",
    evidence: [],
  };
}

function cutsOnAudioLeg(cuts: number[], input: MeasureInput): Leg {
  const { evidence, targets, audioMap, cueSheet } = input;
  const id = "cuts-on-audio";
  if (!audioMap)
    return skipped(
      id,
      "No audio map, so cuts were not compared with the music.",
      "Run audio:map on the track and pass --audio-map.",
    );
  if (cuts.length < 3) return skipped(id, `Only ${cuts.length} cuts, too few to compare with chance.`);
  // Targets written with sync v2 are judged by v2 while the track has a grid; older targets keep the v1 reading below.
  if (targets?.measuredFrom.syncMetric !== undefined && audioMap.tempo.gridTrust !== "none")
    return syncLegV2(cuts, { ...input, audioMap, targets });
  // Compare like with like: a reference measured on beats alone is compared on beats alone, unless this track has no grid to trust.
  const sameClass = targets?.measuredFrom.cutsOnAudioFullMap === 0 && audioMap.tempo.gridTrust !== "none";
  const offset = cueSheet?.musicOffsetSec ?? 0;
  const reading = readAnchors(
    cuts,
    sameClass ? beatAnchors(audioMap, offset) : audioAnchors(audioMap, offset),
    evidence.video.durationSec,
  );
  if (!reading) return skipped(id, "The audio map has no anchors in the film's time.");
  const text = `${Math.round(reading.ratio * 100)}% of cuts land on an audio anchor; chance is ${Math.round(reading.chance * 100)}%, so the lift is ${reading.lift}.`;
  const fix = "Snap the cuts to the map with edit:snap, and move the ones that miss to a phrase or a key moment.";
  const referenceLift = targets?.measuredFrom.cutsOnAudioLift;
  if (referenceLift !== undefined && referenceLift >= MEANINGFUL_LIFT) {
    const needed = round(referenceLift / 2);
    return reading.lift >= needed
      ? {
          id,
          status: "pass",
          value: reading.ratio,
          message: `${text} The reference's lift is ${referenceLift}.`,
          evidence: [],
        }
      : {
          id,
          status: "fail",
          value: reading.ratio,
          message: `${text} The reference's lift is ${referenceLift}, so this needs at least ${needed}.`,
          fix,
          evidence: [],
        };
  }
  if (targets && hasLimit(targets.cutsOnAudioRatio))
    return {
      ...rangeLeg(id, reading.ratio, targets.cutsOnAudioRatio, "Cuts on audio anchors", "", {
        low: fix,
        high: "Too many cuts sit on the grid. Let some breathe off it.",
      }),
      message: text,
    };
  return reading.lift > 0
    ? { id, status: "pass", value: reading.ratio, message: `${text} The target asks for no lift.`, evidence: [] }
    : { id, status: "warn", value: reading.ratio, message: `${text} These cuts ignore the music.`, fix, evidence: [] };
}

function cueLeg(reading: CueReading | undefined): Leg {
  const id = "cue-sheet-drift";
  if (!reading)
    return skipped(
      id,
      "No cue sheet, so cuts are the detector's reading and may include motion inside a shot.",
      "Pass --cue-sheet: it says which boundaries are cuts, and checks they landed.",
    );
  if (!reading.rows.length) return skipped(id, "The cue sheet has no cut or transition cues.");
  const matched = reading.rows.filter((row) => row.state === "matched");
  const missing = reading.rows.filter((row) => row.state === "no-change");
  const drifts = matched.filter((row) => row.kind === "cut").map((row) => row.driftFrames!);
  const medianDrift = round(median(drifts), 1);
  const worst = round(Math.max(0, ...drifts), 1);
  const missingShare = missing.length / reading.rows.length;
  const failing = medianDrift > DRIFT_LIMIT_FRAMES || missingShare > MISSING_CUE_SHARE;
  return {
    id,
    status: failing ? "fail" : missing.length || worst > DRIFT_LIMIT_FRAMES ? "warn" : "pass",
    value: medianDrift,
    target: { max: DRIFT_LIMIT_FRAMES },
    message: `Median drift of hard cuts ${medianDrift} frames, worst ${worst}. ${matched.length} of ${reading.rows.length} cues match a detected cut, ${reading.rows.length - matched.length - missing.length} are flat changes the detector cannot see, ${missing.length} show no change at all. ${reading.unclaimedBoundaries.length} detected boundaries have no cue: read them as motion inside a shot.`,
    ...(failing || missing.length
      ? {
          fix: "Move each scene start to its cue frame, or rerun edit:snap if the plan changed. A cue with no change on screen means the scene is not where the sheet says.",
        }
      : {}),
    evidence: [
      ...reading.rows
        .filter((row) => row.state !== "matched" || (row.kind === "cut" && (row.driftFrames ?? 0) > DRIFT_LIMIT_FRAMES))
        .map(
          (row) =>
            `${row.id}: cue frame ${row.cueFrame}, ${row.state === "matched" ? `cut at ${row.actualFrame}, ${row.driftFrames} off` : row.state}`,
        ),
      ...(reading.unclaimedBoundaries.length ? [`no cue: ${reading.unclaimedBoundaries.join(", ")} s`] : []),
    ],
  };
}

/** The climax's shape against the reference's: advisory, so it warns and never fails. */
/** WCAG 2.3.1: a photosensitivity risk fails whatever the targets say. */
function flashLeg({ flash }: FilmEvidence): Leg {
  const id = "flash-risk";
  if (!flash)
    return skipped(
      id,
      "Flashes were not measured for this render.",
      "Run film:measure again without a stale --evidence file; read the progress line saying why the flash sensor did not run.",
    );
  if (!flash.ranges.length)
    return {
      id,
      status: "pass",
      value: 0,
      message: `No flash risk: at most three flashes a second over ${Math.round(flash.areaLimit * 1000) / 10}% of the frame or less (worst area over the count: ${Math.round(flash.worstArea.general * 100)}% general, ${Math.round(flash.worstArea.red * 100)}% red).`,
      evidence: [],
    };
  return {
    id,
    status: "fail",
    value: flash.ranges.length,
    message: `FLASH_RISK: ${flash.ranges.length} stretch(es) flash more than three times a second over more than ${Math.round(flash.areaLimit * 1000) / 10}% of the frame (WCAG 2.3.1).`,
    fix: FLASH_FIX,
    evidence: flashLines(flash),
  };
}

function climaxLeg({ evidence, targets, audioMap, cueSheet }: MeasureInput): Leg {
  const id = "climax-shape";
  const wanted = targets?.climax;
  if (!wanted)
    return skipped(
      id,
      "The targets carry no climax shape.",
      "Rerun film:targets from the reference to measure its climax.",
    );
  if (!evidence.tension)
    return skipped(
      id,
      "The render's tension curve was not measured.",
      "Rerun film:measure without a stale --evidence file.",
    );
  const climax = climaxOf(evidence.tension);
  if (!climax)
    return {
      id,
      status: "warn",
      value: null,
      message: `This film has no peak in its tension curve; the reference's climax sits at ${targets.measuredFrom.climaxTimeSec ?? "?"} s.`,
      fix: "Build to one hit: rising motion, cuts and sound, then a sudden peak.",
      evidence: [],
    };
  const beats =
    audioMap && audioMap.tempo.gridTrust !== "none"
      ? gridFromMap(audioMap, cueSheet?.musicOffsetSec ?? 0).beatsSec
      : [];
  const offset = beatOffsetFrames(climax, beats, evidence.video.fps);
  const reference = targets.measuredFrom;
  const checks = [
    {
      name: "place",
      value: round(climax.timeSec / evidence.video.durationSec, 3),
      range: wanted.timeShare,
      fix: `Move the hit to about ${Math.round((reference.climaxTimeShare ?? 0) * 100)}% of the film.`,
      text: (value: number) =>
        `at ${Math.round(value * 100)}% of the film (reference ${Math.round((reference.climaxTimeShare ?? 0) * 100)}%)`,
    },
    {
      name: "prominence",
      value: climax.prominence,
      range: wanted.prominence,
      fix: "Make the hit stand out more: quieter, stiller around it.",
      text: (value: number) => `prominence ${value} (reference ${reference.climaxProminence ?? "?"})`,
    },
    {
      name: "breath",
      value: climax.breathDepth,
      range: wanted.breathDepth,
      fix: "Hold a breath before the hit: pull energy down right before it.",
      text: (value: number) =>
        `breath depth ${value} over ${climax.breathSec} s (reference ${reference.climaxBreathDepth ?? "?"} over ${reference.climaxBreathSec ?? "?"} s)`,
    },
    {
      name: "landing",
      value: climax.riseFrames,
      range: wanted.riseFrames,
      fix: "Make the hit land faster, on one or two frames.",
      text: (value: number) => `${value} frames to land (reference ${reference.climaxRiseFrames ?? "?"})`,
    },
    {
      name: "hold",
      value: climax.holdSec,
      range: wanted.holdSec,
      fix: "Let the hit hold before it lets go.",
      text: (value: number) => `holds ${value} s (reference ${reference.climaxHoldSec ?? "?"} s)`,
    },
    ...(offset !== undefined
      ? [
          {
            name: "beat",
            value: Math.abs(offset),
            range: wanted.beatOffsetFrames,
            fix: "Put the hit on the beat (leadFrame for its kind).",
            text: () => `${offset} frames from the beat (reference ${reference.climaxBeatOffsetFrames ?? "?"})`,
          },
        ]
      : []),
  ];
  const misses = checks.filter((check) => hasLimit(check.range) && !inRange(check.value, check.range));
  const lines = checks.map(
    (check) =>
      `${check.name}: ${check.text(check.value)}${hasLimit(check.range) ? `, target ${describeRange(check.range, "")}` : ", no target"}`,
  );
  const message = `Climax at ${climax.timeSec} s: ${lines.map((line) => line.split(": ").slice(1).join(": ")).join("; ")}.`;
  return misses.length
    ? {
        id,
        status: "warn",
        value: climax.timeSec,
        message,
        fix: misses.map((check) => check.fix).join(" "),
        evidence: lines,
      }
    : { id, status: "pass", value: climax.timeSec, message, evidence: lines };
}

// calibrated on 20 references, 2026-11-15: p90 = 0.29, max 0.39 (design-reference/calibration.md); the ceiling is p90 plus REFERENCE_SLACK.
export const MOTION_SPREAD_MAX = 0.4;
// calibrated on 20 references, 2026-11-15: p90 = 1.0, so no ceiling separates professional films; the leg warns and never blocks.
export const FAST_SHARP_MAX = 0.5;
/** Fewer fast frames than this say nothing about blur. */
const MIN_FAST_SAMPLES = 3;
/** A reference that does this itself raises the ceiling to its own reading plus this. */
const REFERENCE_SLACK = 0.1;

const ceiling = (provisional: number, reference: number | undefined) =>
  round(Math.max(provisional, (reference ?? -Infinity) + REFERENCE_SLACK), 3);

/**
 * Slop: the whole frame moving at once, cut after cut. Advisory until judge:calibrate finds it eligible (design-reference/calibration.md): no false
 * positive on 20 references, but the stutter degradation does not move it, so it has no gate evidence yet.
 */
function motionSpreadLeg(evidence: FilmEvidence, cuts: number[], targets: FilmTargets | undefined): Leg {
  const id = "motion-spread";
  const reading = readMotionSpread(evidence, cuts);
  if (!reading)
    return skipped(
      id,
      "The grid of the motion was not measured for this render.",
      "Run film:measure again without a stale --evidence file.",
    );
  const max = ceiling(MOTION_SPREAD_MAX, targets?.measuredFrom.motionSpreadShare);
  const reference = targets?.measuredFrom.motionSpreadShare;
  const message = `Over ${Math.round(SPREAD_FRAME_SHARE * 100)}% of the frame moves at once in ${Math.round(reading.share * 100)}% of ${reading.samples} samples away from cuts${reference !== undefined ? `; the reference reads ${Math.round(reference * 100)}%` : ""}.`;
  const evidenceLines = reading.spans.slice(0, 8).map((span) => `${span.startSec}-${span.endSec} s`);
  if (reading.share <= max)
    return { id, status: "pass", value: reading.share, target: { max }, message, evidence: evidenceLines };
  return {
    id,
    status: "warn",
    value: reading.share,
    target: { max },
    message: `${message} When everything drifts together nothing leads the eye.`,
    fix: "Hold the ground still and move one thing: the subject, the word, the number. Keep whole-frame moves (camera push, whip) for the beats that need them.",
    evidence: evidenceLines,
  };
}

/**
 * Slop: fast motion with no motion blur. Advisory (design-reference/calibration.md): over the max on 5 of 20 professional references, half of
 * them reading 1.0, and blind to a shot that never settles, since only a settled frame gives a sharpness to compare with.
 */
function fastSharpLeg(evidence: FilmEvidence, cuts: number[], targets: FilmTargets | undefined): Leg {
  const id = "fast-motion-sharp";
  const reading = readFastSharp(evidence, cuts);
  if (!reading)
    return skipped(
      id,
      "Sharpness was not measured for this render.",
      "Run film:measure again without a stale --evidence file.",
    );
  if (reading.fast < MIN_FAST_SAMPLES)
    return {
      id,
      status: "pass",
      value: reading.share,
      message: `${reading.fast} fast frame(s) with a settled frame in the same shot to compare: too few to judge blur.`,
      evidence: [],
    };
  const max = ceiling(FAST_SHARP_MAX, targets?.measuredFrom.fastSharpShare);
  const message = `${reading.sharp} of ${reading.fast} fast frames (over ${Math.round(FAST_CHANGE_SHARE * 100)}% of the picture moving in one frame) stay as sharp as their shot's settled frames.`;
  const evidenceLines = reading.times.slice(0, 8).map((time) => `${time} s`);
  if (reading.share <= max)
    return { id, status: "pass", value: reading.share, target: { max }, message, evidence: evidenceLines };
  return {
    id,
    status: "warn",
    value: reading.share,
    target: { max },
    message: `${message} Fast motion without blur strobes and reads as rendered.`,
    fix: "Add motion blur to fast moves (@remotion/motion-blur <CameraMotionBlur> or <Trail>, or a directional blur scaled by speed), or slow the move so it does not need it.",
    evidence: evidenceLines,
  };
}

export function measureFilm(input: MeasureInput): FilmMeasure {
  const { evidence, targets, targetsPath, cueSheet } = input;
  const { durationSec } = evidence.video;
  const cueReading = cueSheet ? readCues(evidence, cueSheet) : undefined;
  const useCues = cueReading !== undefined && cueReading.rows.length > 0;
  const detected = readShots(
    evidence.boundaries.map((row) => row.timeSec),
    durationSec,
  );
  const shots = useCues ? readShots(cueReading.confirmedTimes, durationSec) : detected;
  const cuts = useCues ? cueReading.confirmedTimes : evidence.boundaries.map((row) => row.timeSec);
  const basis = useCues
    ? `Cue sheet: ${shots.cuts} cuts. The detector alone reads ${detected.cuts} cuts, median ${detected.medianSec} s.`
    : `Detector: ${detected.cuts} cuts. It can count motion inside a shot as a cut, and misses flat text swaps, so pass --cue-sheet for the truth.`;
  const stills = readStills(evidence.motion, durationSec);

  const legs: Leg[] = [
    targets
      ? {
          id: "targets-present",
          status: "pass",
          value: 1,
          message:
            targets.source === "manual"
              ? `Manual targets: ${targets.reason ?? "no reason given"}.`
              : targets.source === "corpus"
                ? `Targets from the reference corpus (${targets.corpus?.referenceIds.length ?? 0} references${targets.corpus?.playbook ? `, playbook ${targets.corpus.playbook}` : ""}).`
                : `Targets from reference ${targets.referenceId ?? "unnamed"}.`,
          evidence: [],
        }
      : {
          id: "targets-present",
          status: "fail",
          value: 0,
          message:
            "No film targets, so the pace of this film was not judged. Without them a slideshow with sound would pass.",
          fix: "Run film:targets from the chosen reference, or film:targets --manual with --reason, then pass --targets.",
          evidence: [],
        },
    ...audioLegs(input),
  ];

  legs.push(
    rangeLeg(
      "shot-length-median",
      shots.medianSec,
      targets?.medianShotSec,
      "Median shot",
      " s",
      {
        low: "Shots run shorter than the reference. Merge the shortest and let them land.",
        high: `Shots run longer than the reference. Split the longest (${[...shots.lengths]
          .sort((a, b) => b - a)
          .slice(0, 3)
          .map((length) => `${round(length, 1)} s`)
          .join(", ")}) at a change of subject, scale or state.`,
      },
      [basis],
    ),
  );

  if (shots.lengths.length < MIN_SHOTS_FOR_VARIETY) {
    legs.push(
      skipped(
        "shot-length-variety",
        `${shots.lengths.length} shot(s) cannot show a cadence: this is ${shots.lengths.length === 1 ? "one continuous take" : "too few cuts"} as far as the reading goes.`,
      ),
    );
  } else {
    const floor = { ...targets?.shotLengthVariety, min: targets?.shotLengthVariety.min ?? UNIFORM_VARIETY };
    legs.push(
      rangeLeg("shot-length-variety", shots.variety, floor, "Shot length p90/p10", "", {
        low: "The cadence is uniform: same length, cut after cut. Mix short bursts with longer beats, placed on the music's sections.",
        high: "The lengths swing wider than the reference.",
      }),
    );
  }

  legs.push(
    rangeLeg(
      "cuts-per-minute",
      shots.cutsPerMinute,
      targets?.cutsPerMinute,
      "Cuts per minute",
      "",
      {
        low: "Too few cuts for this reference. Add boundaries on the audio map's phrases and hits.",
        high: "More cuts than the reference. Merge the shots that do not land an idea.",
      },
      [basis],
    ),
  );

  const stillFixes = {
    low: "",
    high: `The picture stops. Keep something moving through each hold: a drift, a second layer, a counter. Worst spans: ${[
      ...stills.spans,
    ]
      .sort((a, b) => b.endSec - b.startSec - (a.endSec - a.startSec))
      .slice(0, 3)
      .map((span) => `${span.startSec}-${span.endSec} s`)
      .join(", ")}.`,
  };
  legs.push(rangeLeg("still-share", stills.share, targets?.stillShare, "Frozen share of the film", "", stillFixes));
  legs.push(
    rangeLeg("longest-still", stills.longestSec, targets?.longestStillSec, "Longest frozen stretch", " s", stillFixes),
  );
  const referenceSpans = targets?.measuredFrom.frozenSpans;
  const tooMany = referenceSpans !== undefined && stills.spans.length > referenceSpans + 2;
  legs.push({
    id: "frozen-spans",
    status: tooMany ? "warn" : "pass",
    value: stills.spans.length,
    message: `${stills.spans.length} frozen stretch(es) of 0.5 s or more${referenceSpans !== undefined ? `; the reference has ${referenceSpans}` : ""}.`,
    ...(tooMany ? { fix: "Holds this frequent read as a slideshow. Look at each span below with motion:strip." } : {}),
    evidence: stills.spans.map((span) => `${span.startSec}-${span.endSec} s`),
  });

  legs.push(cutsOnAudioLeg(cuts, input));
  legs.push(cutOffsetLeg(cuts, input));
  legs.push(cueLeg(cueReading));
  legs.push(climaxLeg(input));
  legs.push(flashLeg(evidence));
  const pixelCuts = [...new Set([...cuts, ...evidence.boundaries.map((row) => row.timeSec)])];
  legs.push(motionSpreadLeg(evidence, pixelCuts, targets));
  legs.push(fastSharpLeg(evidence, pixelCuts, targets));
  legs.push(
    cutSoundCoverageLeg({
      cueSheet,
      onsetsSec: input.onsetsSec,
      fps: evidence.video.fps,
      ...(input.soundCues ? { soundCues: input.soundCues } : {}),
    }),
  );
  legs.push(sfxEvidenceLeg(input.sfxReviews));

  return FilmMeasureSchema.parse({
    schemaVersion: 1,
    renderSha256: evidence.sha256,
    ...(targetsPath ? { targetsPath } : {}),
    verdict: legs.some((leg) => leg.status === "fail") ? "fail" : "pass",
    legs,
    frozenSpans: stills.spans,
  });
}

/**
 * film:render and film:measure measure a render file through this one call, so both read the same legs:
 * the render's onsets are read when it has audio and a cue sheet asks for decided sounds.
 */
export function measureRender(media: string, input: MeasureInput): FilmMeasure {
  const onsetsSec =
    input.onsetsSec ?? (input.evidence.video.hasAudio && input.cueSheet ? readRenderOnsets(media) : undefined);
  return measureFilm({ ...input, ...(onsetsSec ? { onsetsSec } : {}) });
}
