import type { MotionPlan } from "../../types/creative";
import type { AudioMap, CueSheet, FilmTargets } from "../../types/film";
import { stopSec } from "../audio-map/edit-plan";
import { MAX_LEAD_FRAMES } from "../audio-map/leads";
import { decideFilmEvents, describeUndecided, DECISION_FIX, isDecided } from "../audio/cut-decisions";
import { describeRange, hasLimit, inRange, median, round, varietyRatio } from "./stats";
import type { LibraryUsage, UsageBlock } from "../../types/tournament";

// Reads a plan before anything is built and blocks a slideshow. Scores run 0 (no risk) to 5.

export type PlanFinding = {
  dimension: string;
  status: "pass" | "warn" | "fail";
  score: number;
  value: number | null;
  target?: { min?: number; max?: number };
  message: string;
  fix?: string;
  shotIds: string[];
};

export type PlanCheck = {
  schemaVersion: 1;
  planProjectId: string;
  verdict: "pass" | "fail";
  /** Mean of the dimension scores. */
  riskScore: number;
  stats: { shots: number; durationSec: number; medianShotSec: number; variety: number; shotsPer30Sec: number };
  findings: PlanFinding[];
  /** Reported, never part of the verdict or the risk score. */
  advisory?: PlanFinding[];
};

type Shot = MotionPlan["shots"][number];

const BLOCKING_RISK = 2.5;
/** Below this many shots, a percentile says nothing. */
const MIN_SHOTS_FOR_VARIETY = 5;
const UNIFORM_VARIETY = 1.5;
const MAX_DOMINANT_SHARE = 0.6;
const DEFAULT_LONGEST_HOLD_SEC = 1.5;
const LOW_SUBJECT_FILL = 0.4;

const SHORT_LABEL_WORDS = 2;
// Readability rule, not a style one: ask 0.8 s settled for a short label even though the reference corpus's median
// screen-text dwell is about 0.5 s. Do not move it towards the corpus without calibration evidence (judge:calibrate on
// degraded copies, design-reference/calibration.md) that 0.5 s still reads at playback size.
const SHORT_LABEL_HOLD_SEC = 0.8;
const SECONDS_PER_WORD = 0.3;
/** Cyrillic words run longer, and in a second alphabet they read slower. */
const CYRILLIC_FACTOR = 1.25;
/** When a plan gives no readingHoldSec, this much of the shot goes on the entrance. */
const ASSUMED_ENTRANCE_SEC = 0.3;

const STILL_CAMERA = /^(none|static|still|locked( off)?|lock(ed)?[- ]off|fixed|hold|tripod)\b/i;
const NO_MOTION = /^(none|static|still|hold|no motion|-)?$/i;
const HARD_CUT = /^(deliberate\s+)?hard[- ]cut\b/i;
/** A transition's name says how the frame changes, not what the eye follows through it. */
const BARE_TRANSITION =
  /^(none|cut|hard[- ]cut|jump[- ]cut|smash[- ]cut|fade|fade[- ](in|out|up|down|to[- ]black)|cross[- ]?fade|cross[- ]?dissolve|dissolve|dip( to (black|white))?|whip|whip[- ]pan|wipe|slide|push|zoom|morph|transition)$/i;

const framesToSec = (plan: MotionPlan, frames: number) => frames / plan.fps;

/** Slop signatures (design-reference/slop-catalogue.md): they block by failing, and stay out of the risk mean so they never dilute it. */
export const SLOP_PLAN_DIMENSIONS = ["curve-linear", "text-hold-long", "entry-hierarchy"] as const;
// provisional: recalibrated from ref:corpus
const TEXT_HOLD_FLOOR_SEC = 2.5;
// provisional: recalibrated from ref:corpus
const TEXT_HOLD_READING_FACTOR = 3;
/** An inferred hold (no readingHoldSec) fails only past this multiple of the bound; under it, it warns. */
const INFERRED_HOLD_SLACK = 2;
// provisional: recalibrated from ref:corpus
const HIERARCHY_MIN_LAYERS = 3;
const LINEAR = /\blinear\b/i;
/** Film-level gates: they block by failing and, like the slop signatures, stay out of the risk mean. */
export const FILM_GATE_DIMENSIONS = ["cross-film-repetition", "signature-element"] as const;
/** Dimensions kept out of the risk mean. */
export const UNSCORED_PLAN_DIMENSIONS: readonly string[] = [...SLOP_PLAN_DIMENSIONS, ...FILM_GATE_DIMENSIONS];
/** An entrance that does not move: nothing for a curve to shape. */
const STILL_ENTRANCE =
  /^(none|static|still|hold|no motion|-|)$|\b(hard|jump|smash)[- ]?(cut|swap)\b|^(cut|swap)\b|\bcut in\b/i;
/** Words that say the parts of a shot arrive in an order. */
const ORDERING =
  /\b(stagger(ed|s)?|then|after|before|first|second|third|last|next|cascade[sd]?|one by one|one after|word by word|letter by letter|line by line|in turn|in order|sequence[ds]?|lead(s|ing)?|follow(s|ed|ing)?|offset|delay(ed)?|trail(s|ing)?|builds?|stream(s|ed|ing)?)\b|→|->|\d+\s*f(rames?)?\s+(apart|later|after)/i;

/** "fade up 12f, ease-out" and "Fade up 20f" are the same treatment. */
export function normaliseTreatment(value: string): string {
  const words = value
    .toLowerCase()
    .replace(/\d+(\.\d+)?\s*(f|fr|frames?|s|sec|ms|%|px)?\b/g, " ")
    .split(/[,;:()]/)[0]!
    .replace(/[^\p{L}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, 2).join(" ");
}

export function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Fast in, then hold: the settled time a viewer needs to read this. */
export function requiredReadingSec(text: string): number {
  const words = wordCount(text);
  const base =
    words <= SHORT_LABEL_WORDS ? SHORT_LABEL_HOLD_SEC : Math.max(SHORT_LABEL_HOLD_SEC, words * SECONDS_PER_WORD);
  return round(/\p{Script=Cyrillic}/u.test(text) ? base * CYRILLIC_FACTOR : base, 2);
}

export type BoundaryCarry = "carry" | "hard-cut" | "unnamed";

export function classifyBoundary(shot: Pick<Shot, "carry" | "transitionToNext">): BoundaryCarry {
  const carry = shot.carry?.trim();
  if (carry) return HARD_CUT.test(carry) ? "hard-cut" : "carry";
  const transition = shot.transitionToNext?.trim();
  if (!transition) return "unnamed";
  if (HARD_CUT.test(transition)) return "hard-cut";
  return BARE_TRANSITION.test(transition) || wordCount(transition) < 3 ? "unnamed" : "carry";
}

const dominant = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const [name, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return { name, count, share: values.length ? count / values.length : 0, distinct: counts.size };
};

function rangeFinding(
  dimension: string,
  value: number,
  target: { min?: number; max?: number },
  what: string,
  unit: string,
  fixLow: string,
  fixHigh: string,
): PlanFinding {
  if (!hasLimit(target))
    return {
      dimension,
      status: "warn",
      score: 1,
      value: round(value, 2),
      message: `${what} is ${round(value, 2)}${unit}, and the targets set no limit.`,
      fix: "Set this limit in film-targets, by hand with a reason if the reference does not supply one.",
      shotIds: [],
    };
  if (inRange(value, target))
    return {
      dimension,
      status: "pass",
      score: 0,
      value: round(value, 2),
      target,
      message: `${what} is ${round(value, 2)}${unit}, within ${describeRange(target, unit)}.`,
      shotIds: [],
    };
  const low = target.min !== undefined && value < target.min;
  const bound = low ? target.min! : target.max!;
  const miss = Math.abs(value - bound) / Math.max(Math.abs(bound), 0.001);
  return {
    dimension,
    status: "fail",
    score: Math.min(5, round(2.5 + miss * 3, 1)),
    value: round(value, 2),
    target,
    message: `${what} is ${round(value, 2)}${unit}; the target is ${describeRange(target, unit)}.`,
    fix: low ? fixLow : fixHigh,
    shotIds: [],
  };
}

function checkPace(plan: MotionPlan, targets: FilmTargets, lengths: number[]): PlanFinding[] {
  const shotsPer30 = (plan.shots.length / lengths.reduce((sum, length) => sum + length, 0)) * 30;
  const longest = [...plan.shots]
    .sort((a, b) => b.durationFrames - a.durationFrames)
    .slice(0, 3)
    .map((shot) => `${shot.id} ${round(framesToSec(plan, shot.durationFrames), 1)} s`);
  const medianFinding = rangeFinding(
    "shot-length",
    median(lengths),
    targets.medianShotSec,
    "Median planned shot",
    " s",
    "Merge the shortest shots so each one lands an idea.",
    `Split the longest shots (${longest.join(", ")}) at their internal beats: a change of subject, scale or state.`,
  );
  const floor = targets.cutsPerMinute.min === undefined ? {} : { min: round(targets.cutsPerMinute.min / 2, 1) };
  const countFinding = rangeFinding(
    "shot-count",
    shotsPer30,
    floor,
    "Shots per 30 s",
    "",
    `Plan more boundaries. The targets ask for at least ${targets.cutsPerMinute.min} cuts a minute; list the beats in each long shot and give each its own shot.`,
    "",
  );
  return [medianFinding, countFinding];
}

function checkVariety(lengths: number[], targets: FilmTargets): PlanFinding {
  const dimension = "shot-variety";
  if (lengths.length < MIN_SHOTS_FOR_VARIETY)
    return {
      dimension,
      status: "warn",
      score: 1,
      value: null,
      message: `Only ${lengths.length} shots, too few to judge cadence.`,
      shotIds: [],
    };
  const variety = varietyRatio(lengths);
  const floor = Math.max(UNIFORM_VARIETY, targets.shotLengthVariety.min ?? 0);
  const target = { ...targets.shotLengthVariety, min: floor };
  const finding = rangeFinding(
    dimension,
    variety,
    target,
    "Shot length p90/p10",
    "",
    "The cadence is too even. Mix short bursts with one or two longer beats, placed on the music's sections.",
    "The lengths swing wider than the target. Bring the longest shots down.",
  );
  return finding;
}

function checkHolds(plan: MotionPlan, targets: FilmTargets): PlanFinding {
  const dimension = "holds-without-motion";
  const limit = targets.longestStillSec.max ?? DEFAULT_LONGEST_HOLD_SEC;
  const holds = plan.shots.filter((shot) => {
    const seconds = framesToSec(plan, shot.durationFrames);
    const stillCamera = STILL_CAMERA.test(shot.camera.trim()) || NO_MOTION.test(shot.camera.trim());
    const layered = (shot.layers?.length ?? 0) >= 2;
    return stillCamera && !layered && seconds - (shot.readingHoldSec ?? 0) > limit;
  });
  if (!holds.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: 0,
      target: { max: 0 },
      message: `No shot stands still for longer than ${limit} s beyond its reading hold.`,
      shotIds: [],
    };
  return {
    dimension,
    status: "fail",
    score: Math.min(5, 2.5 + holds.length * 0.5),
    value: holds.length,
    target: { max: 0 },
    message: `${holds.length} shot(s) stay on a still camera with under two moving layers for over ${limit} s: ${holds.map((shot) => `${shot.id} (${round(framesToSec(plan, shot.durationFrames), 1)} s)`).join(", ")}.`,
    fix: "Give each a camera move or a second independent layer in `layers`, or cut it down to the reading hold.",
    shotIds: holds.map((shot) => shot.id),
  };
}

function checkEntrances(plan: MotionPlan): PlanFinding {
  const dimension = "entrance-variety";
  const treatments = plan.shots.map((shot) => normaliseTreatment(shot.entrance));
  const { name, share, distinct } = dominant(treatments);
  const need = Math.min(3, Math.ceil(plan.shots.length / 3));
  const tooFew = distinct < need;
  const tooDominant = plan.shots.length >= 4 && share > MAX_DOMINANT_SHARE;
  if (!tooFew && !tooDominant)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: distinct,
      target: { min: need },
      message: `${distinct} distinct entrances; the commonest, "${name}", is on ${Math.round(share * 100)}% of shots.`,
      shotIds: [],
    };
  return {
    dimension,
    status: "fail",
    score: Math.min(5, 2.5 + share * 2.5),
    value: distinct,
    target: { min: need },
    message: `${distinct} distinct entrance(s); "${name}" is on ${Math.round(share * 100)}% of shots. One motion across everything reads as a template.`,
    fix: "Give the entrance to what the shot says: type that lands, a number that rolls, a shape that becomes the next thing. Keep any one treatment to 60% of shots.",
    shotIds: plan.shots.filter((shot) => normaliseTreatment(shot.entrance) === name).map((shot) => shot.id),
  };
}

function checkBoundaries(plan: MotionPlan): PlanFinding {
  const dimension = "shot-boundaries";
  const boundaries = plan.shots.slice(0, -1);
  const unnamed = boundaries.filter((shot) => classifyBoundary(shot) === "unnamed");
  if (!unnamed.length) {
    const hard = boundaries.filter((shot) => classifyBoundary(shot) === "hard-cut").length;
    return {
      dimension,
      status: "pass",
      score: 0,
      value: 0,
      target: { max: 0 },
      message: `Every boundary is named: ${boundaries.length - hard} carried, ${hard} deliberate hard cuts.`,
      shotIds: [],
    };
  }
  const share = unnamed.length / Math.max(1, boundaries.length);
  return {
    dimension,
    status: "fail",
    score: Math.min(5, round(2.5 + share * 2.5, 1)),
    value: unnamed.length,
    target: { max: 0 },
    message: `${unnamed.length} of ${boundaries.length} boundaries do not say what crosses them: ${unnamed.map((shot) => shot.id).join(", ")}. A transition's name ("cut", "whip") does not count.`,
    fix: 'Set `carry` on each: what the eye follows into the next shot (a shape, a colour, a line of motion, a word), or "hard-cut: <why>" for a deliberate one.',
    shotIds: unnamed.map((shot) => shot.id),
  };
}

function checkLayers(plan: MotionPlan): PlanFinding {
  const dimension = "layers";
  const declared = plan.shots.filter((shot) => shot.layers !== undefined);
  if (!declared.length)
    return {
      dimension,
      status: "warn",
      score: 2,
      value: null,
      target: { min: 2 },
      message: "The plan does not state moving layers for any shot.",
      fix: "Add `layers` to each shot: what moves independently, such as background, subject, type, particles.",
      shotIds: [],
    };
  const flat = declared.filter((shot) => shot.layers!.length < 2);
  const mean = declared.reduce((sum, shot) => sum + shot.layers!.length, 0) / declared.length;
  const failing = flat.length / declared.length > 0.5;
  return {
    dimension,
    status: failing ? "fail" : flat.length ? "warn" : "pass",
    score: failing ? 3 : flat.length ? 1 : 0,
    value: round(mean, 2),
    target: { min: 2 },
    message: `${round(mean, 1)} moving layers a shot on average; ${flat.length} of ${declared.length} declared shots have fewer than two.`,
    ...(flat.length
      ? {
          fix: "One moving thing on a still ground is a slide. Add a drifting background, a parallax plane or a second timed element.",
        }
      : {}),
    shotIds: flat.map((shot) => shot.id),
  };
}

function checkSubjectFill(plan: MotionPlan): PlanFinding {
  const dimension = "subject-fill";
  const declared = plan.shots.filter((shot) => shot.subjectFill !== undefined);
  if (!declared.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: null,
      message: "subjectFill is not stated, so it was not checked.",
      shotIds: [],
    };
  const small = declared.filter((shot) => shot.subjectFill! < LOW_SUBJECT_FILL);
  const mean = declared.reduce((sum, shot) => sum + shot.subjectFill!, 0) / declared.length;
  const mostly = small.length / declared.length > 0.5;
  return {
    dimension,
    status: small.length ? "warn" : "pass",
    score: mostly ? 2 : small.length ? 1 : 0,
    value: round(mean, 2),
    target: { min: LOW_SUBJECT_FILL },
    message: `Subject fills ${Math.round(mean * 100)}% of the frame on average; ${small.length} shot(s) under ${LOW_SUBJECT_FILL * 100}%.`,
    ...(small.length
      ? { fix: "Bring the subject up to 60-85% of the frame unless the empty space is the point of the shot." }
      : {}),
    shotIds: small.map((shot) => shot.id),
  };
}

function checkReading(plan: MotionPlan): PlanFinding {
  const dimension = "reading-time";
  const copy = new Map<string, { text: string; required: boolean }>();
  for (const line of plan.onScreenCopy) {
    const held = copy.get(line.shotId);
    copy.set(line.shotId, {
      text: held ? `${held.text} ${line.text}` : line.text,
      required: (held?.required ?? false) || line.required,
    });
  }
  if (!copy.size)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: null,
      message: "The plan has no on-screen copy to time.",
      shotIds: [],
    };
  const short: { id: string; severe: boolean; note: string }[] = [];
  for (const shot of plan.shots) {
    const line = copy.get(shot.id);
    if (!line) continue;
    const needed = requiredReadingSec(line.text);
    const available = shot.readingHoldSec ?? Math.max(0, framesToSec(plan, shot.durationFrames) - ASSUMED_ENTRANCE_SEC);
    if (available + 1e-6 >= needed) continue;
    short.push({
      id: shot.id,
      severe: line.required || available < needed / 2,
      note: `${shot.id}: ${wordCount(line.text)} word(s) need ${needed} s settled, it has ${round(available, 2)} s`,
    });
  }
  if (!short.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: 0,
      target: { max: 0 },
      message: `All ${copy.size} shots with copy hold long enough to read.`,
      shotIds: [],
    };
  const failing = short.some((row) => row.severe);
  return {
    dimension,
    status: failing ? "fail" : "warn",
    score: failing ? Math.min(5, 2.5 + short.length * 0.5) : 1,
    value: short.length,
    target: { max: 0 },
    message: short.map((row) => row.note).join("; "),
    fix: `Fast in, then hold: a short label about ${SHORT_LABEL_HOLD_SEC} s settled, about ${SECONDS_PER_WORD} s a word beyond that, ${CYRILLIC_FACTOR}x for Cyrillic. Shorten the copy or extend the shot, and state readingHoldSec.`,
    shotIds: short.map((row) => row.id),
  };
}

function checkRepetition(plan: MotionPlan): PlanFinding {
  const dimension = "composition-repetition";
  if (plan.shots.length < 4)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: null,
      message: "Too few shots to judge repetition.",
      shotIds: [],
    };
  const { name, share } = dominant(plan.shots.map((shot) => shot.composition.trim().toLowerCase()));
  const failing = share > MAX_DOMINANT_SHARE;
  return {
    dimension,
    status: failing ? "fail" : "pass",
    score: failing ? 3 : 0,
    value: round(share, 2),
    target: { max: MAX_DOMINANT_SHARE },
    message: `The commonest composition, "${name}", is on ${Math.round(share * 100)}% of shots.`,
    ...(failing
      ? { fix: "Change scale, axis or density between neighbouring shots, so the same layout does not return." }
      : {}),
    shotIds: [],
  };
}

function checkLinearCurves(plan: MotionPlan): PlanFinding {
  const dimension = "curve-linear";
  const linear = plan.shots.filter((shot) => LINEAR.test(shot.curve) && !STILL_ENTRANCE.test(shot.entrance.trim()));
  if (!linear.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: 0,
      target: { max: 0 },
      message: "No moving entrance runs on a linear curve.",
      shotIds: [],
    };
  return {
    dimension,
    status: "fail",
    score: 3,
    value: linear.length,
    target: { max: 0 },
    message: `${linear.length} shot(s) move their entrance on a linear curve: ${linear.map((shot) => `${shot.id} ("${shot.entrance}", ${shot.curve})`).join(", ")}. Constant speed in and a dead stop reads as a default, not a decision.`,
    fix: "Name the curve for the feeling: expo-out to land, ease-in to leave, a spring for physical overshoot, ease-in-out for a camera move. Keep linear only for continuous drift, tickers and marquees, and say so in `curve`.",
    shotIds: linear.map((shot) => shot.id),
  };
}

function checkTextHolds(plan: MotionPlan): PlanFinding {
  const dimension = "text-hold-long";
  const copy = new Map<string, string>();
  for (const line of plan.onScreenCopy)
    copy.set(line.shotId, copy.has(line.shotId) ? `${copy.get(line.shotId)} ${line.text}` : line.text);
  const last = plan.shots.at(-1)!;
  const long: { id: string; severe: boolean; note: string }[] = [];
  for (const shot of plan.shots) {
    const text = copy.get(shot.id);
    // The end card is the thumbnail and the loop frame: it may hold.
    if (!text || shot === last) continue;
    const bound = Math.max(TEXT_HOLD_FLOOR_SEC, TEXT_HOLD_READING_FACTOR * requiredReadingSec(text));
    const stated = shot.readingHoldSec !== undefined;
    const hold = shot.readingHoldSec ?? Math.max(0, framesToSec(plan, shot.durationFrames) - ASSUMED_ENTRANCE_SEC);
    if (hold <= bound + 1e-6) continue;
    long.push({
      id: shot.id,
      severe: stated || hold > bound * INFERRED_HOLD_SLACK,
      note: `${shot.id}: ${round(hold, 2)} s ${stated ? "stated" : "inferred"} against ${round(bound, 2)} s`,
    });
  }
  if (!long.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: 0,
      target: { max: 0 },
      message: "No copy holds past three times its reading time (2.5 s at least), apart from the end card.",
      shotIds: [],
    };
  const failing = long.some((row) => row.severe);
  return {
    dimension,
    status: failing ? "fail" : "warn",
    score: failing ? 3 : 1,
    value: long.length,
    target: { max: 0 },
    message: `Copy sits on screen well past reading it: ${long.map((row) => row.note).join("; ")}. A held card is a slide.`,
    fix: `Cut the hold to the reading time plus a beat (at most ${TEXT_HOLD_READING_FACTOR}x reading, ${TEXT_HOLD_FLOOR_SEC} s at least), or give the extra time to something that moves: the next line, the product, a camera push. State readingHoldSec.`,
    shotIds: long.map((row) => row.id),
  };
}

function checkEntryHierarchy(plan: MotionPlan): PlanFinding {
  const dimension = "entry-hierarchy";
  const layered = plan.shots.filter((shot) => (shot.layers?.length ?? 0) >= HIERARCHY_MIN_LAYERS);
  const unordered = layered.filter((shot) => !ORDERING.test(`${shot.entrance} ${shot.intent}`));
  if (!unordered.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: 0,
      target: { max: 0 },
      message: layered.length
        ? `All ${layered.length} shot(s) with ${HIERARCHY_MIN_LAYERS}+ layers say in what order they arrive.`
        : `No shot has ${HIERARCHY_MIN_LAYERS} or more layers.`,
      shotIds: [],
    };
  return {
    dimension,
    status: "warn",
    score: 1,
    value: unordered.length,
    target: { max: 0 },
    message: `${unordered.length} of ${layered.length} shot(s) with ${HIERARCHY_MIN_LAYERS}+ layers do not say what arrives first: ${unordered.map((shot) => shot.id).join(", ")}. Without an order they tend to be built to enter at once (motion:check SIMULTANEOUS_ENTRY).`,
    fix: 'Write the order into `entrance`: "headline lands, then the number 4f later, the label last", or "stagger 3f, leading with ...".',
    shotIds: unordered.map((shot) => shot.id),
  };
}

/**
 * This film's hero blocks against the last films recorded by library:usage (`recent`, newest first, this film left out): a
 * hero block those films used with the same props, in any role, warns; every hero block a hero of one of them fails.
 */
export function checkCrossFilmRepetition(
  heroBlocks: readonly UsageBlock[],
  recent: readonly LibraryUsage[],
): PlanFinding {
  const dimension = "cross-film-repetition";
  const hero = heroBlocks.filter((block) => block.weight === "hero");
  if (!hero.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: null,
      message: "No hero shot names a library block, so repetition across films was not checked.",
      shotIds: [],
    };
  if (!recent.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: 0,
      message: "No other film is recorded in memory/usage yet.",
      shotIds: [],
    };
  const key = (block: Pick<UsageBlock, "id" | "propsHash">) => `${block.id}|${block.propsHash}`;
  const usedAsHero = (record: LibraryUsage, block: UsageBlock) =>
    record.blocks.some((used) => used.weight === "hero" && key(used) === key(block));
  const repeats = hero.filter((block) =>
    recent.some((record) => record.blocks.some((used) => key(used) === key(block))),
  );
  if (!repeats.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: 0,
      target: { max: 0 },
      message: `None of ${hero.length} hero block(s) appeared in the last ${recent.length} film(s) with the same props.`,
      shotIds: [],
    };
  const whole = recent.find((record) => hero.every((block) => usedAsHero(record, block)));
  const names = repeats.map((block) => `${block.id} (${block.propsHash})`).join(", ");
  return {
    dimension,
    status: whole ? "fail" : "warn",
    score: whole ? 3 : 1,
    value: repeats.length,
    target: { max: 0 },
    message: whole
      ? `Every hero block of this film was a hero of ${whole.projectId} (${whole.date}) with the same props: ${names}. The film repeats that one.`
      : `${repeats.length} of ${hero.length} hero block(s) appeared in the last ${recent.length} film(s) with the same props: ${names}.`,
    fix: "Pick another candidate for the shot's function from ref:corpus, change the block's props to this film's idea, or build the signature element there.",
    shotIds: [],
  };
}

/** A bespoke film names one element no library block supplies, from its own idea, and the shots that carry it. */
export function checkSignature(plan: MotionPlan): PlanFinding {
  const dimension = "signature-element";
  const signature = plan.signature;
  const fix =
    "Add `signature`: {description, shotIds, whyFromIdea}: one element no library block supplies, taken from this film's idea, and the shots it lives in.";
  if (!signature)
    return {
      dimension,
      status: "fail",
      score: 3,
      value: 0,
      target: { min: 1 },
      message:
        "The plan names no signature element: every shot could come from the library, so the film could be any film.",
      fix,
      shotIds: [],
    };
  const known = new Set(plan.shots.map((shot) => shot.id));
  const unknown = signature.shotIds.filter((id) => !known.has(id));
  if (unknown.length)
    return {
      dimension,
      status: "fail",
      score: 3,
      value: signature.shotIds.length - unknown.length,
      target: { min: 1 },
      message: `The signature names shots the plan does not have: ${unknown.join(", ")}.`,
      fix,
      shotIds: unknown,
    };
  return {
    dimension,
    status: "pass",
    score: 0,
    value: signature.shotIds.length,
    target: { min: 1 },
    message: `Signature "${signature.description}" lives in ${signature.shotIds.join(", ")}.`,
    shotIds: signature.shotIds,
  };
}

const CUE_DRIFT_FRAMES = 1;

function checkCues(plan: MotionPlan, cueSheet: CueSheet | undefined): PlanFinding {
  const dimension = "cue-sheet";
  if (!cueSheet)
    return {
      dimension,
      status: "warn",
      score: 1,
      value: null,
      message: "No cue sheet, so shot boundaries are not tied to the music.",
      fix: "Run edit:snap on the plan's boundaries and pass --cue-sheet.",
      shotIds: [],
    };
  const cuts = cueSheet.cues.filter((cue) => cue.kind === "cut" || cue.kind === "transition").map((cue) => cue.frame);
  const scale = plan.fps / cueSheet.fps;
  const off = plan.shots
    .slice(1)
    .filter((shot) => !cuts.some((frame) => Math.abs(frame * scale - shot.startFrame) <= CUE_DRIFT_FRAMES));
  if (!off.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: 0,
      target: { max: 0 },
      message: `All ${plan.shots.length - 1} boundaries sit on a cut or transition cue.`,
      shotIds: [],
    };
  const share = off.length / Math.max(1, plan.shots.length - 1);
  const failing = share > 0.2;
  return {
    dimension,
    status: failing ? "fail" : "warn",
    score: failing ? 3 : 1,
    value: off.length,
    target: { max: 0 },
    message: `${off.length} boundaries have no cue within ${CUE_DRIFT_FRAMES} frame: ${off.map((shot) => `${shot.id}@${shot.startFrame}`).join(", ")}.`,
    fix: "Move each boundary to its snapped cue, or rerun edit:snap on the current boundaries.",
    shotIds: off.map((shot) => shot.id),
  };
}

/**
 * Every cut, transition and hero cue is decided: a sound, or a silence with its reason. Undecided blocks the plan. Plan
 * boundaries are matched to cue-sheet cues as sfx:cues matches them (decideFilmEvents), so a boundary with no cue is
 * undecided here too, not first at the build.
 */
export function checkCutSoundDecided(plan: MotionPlan, cueSheet: CueSheet | undefined): PlanFinding {
  const dimension = "cut-sound-decided";
  if (!cueSheet)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: null,
      message: "No cue sheet, so sound decisions were not checked.",
      shotIds: [],
    };
  const open = decideFilmEvents({ fps: plan.fps, plan, cueSheet }).filter((event) => !isDecided(event));
  if (!open.length)
    return {
      dimension,
      status: "pass",
      score: 0,
      value: 0,
      target: { max: 0 },
      message: "Every cut, transition and hero cue decides its sound or its silence.",
      shotIds: [],
    };
  return {
    dimension,
    status: "fail",
    score: Math.min(5, 2.5 + open.length * 0.25),
    value: open.length,
    target: { max: 0 },
    message: `${open.length} undecided: ${describeUndecided(open).join("; ")}.`,
    fix: DECISION_FIX,
    shotIds: [...new Set(open.flatMap((event) => (event.shotId ? [event.shotId] : [])))],
  };
}

function checkContinuity(plan: MotionPlan): PlanFinding[] {
  const broken = plan.shots.slice(1).filter((shot, index) => {
    const previous = plan.shots[index]!;
    return shot.startFrame !== previous.startFrame + previous.durationFrames;
  });
  if (!broken.length) return [];
  return [
    {
      dimension: "timeline",
      status: "warn",
      score: 1,
      value: broken.length,
      message: `${broken.length} shot(s) do not start where the previous one ends: ${broken.map((shot) => shot.id).join(", ")}. Overlaps are fine for transitions; gaps are not.`,
      fix: "Check startFrame and durationFrames.",
      shotIds: broken.map((shot) => shot.id),
    },
  ];
}

const STRUCTURE_TOLERANCE_SEC = 0.08;
/** Boundaries this close together are a burst, which may cut on beats. */
const BURST_SHOT_SEC = 0.5;

/** Advisory: shot boundaries off the music's form, and an ending off its stop. Frames become track seconds through the cue sheet's offset. */
export function checkStructure(plan: MotionPlan, map: AudioMap, cueSheet?: CueSheet): PlanFinding[] {
  const offset = cueSheet?.musicOffsetSec ?? 0;
  const lead = MAX_LEAD_FRAMES.cut / plan.fps;
  const structure = map.structure;
  // A guessed bar line is no anchor: with barKnown false a structural cut need only sit on a beat.
  const gridAnchors =
    map.tempo.gridTrust !== "reliable"
      ? "none"
      : (map.grid?.barKnown ?? structure?.barKnown ?? true)
        ? "downbeat"
        : "beat";
  const anchors = [
    ...(structure
      ? [
          ...structure.phrases.map((phrase) => phrase.startSec),
          ...structure.sections.map((section) => section.startSec),
          ...structure.breaks.flatMap((item) => [item.startSec, item.endSec]),
        ]
      : map.phrases.map((phrase) => phrase.startSec)),
    ...map.keyMoments.filter((moment) => moment.kind !== "hard-stop").map((moment) => moment.timeSec),
    ...(gridAnchors === "downbeat" ? map.downbeatsSec : gridAnchors === "beat" ? map.beatsSec : []),
  ];
  const fills = structure?.fills ?? [];
  const onAnchor = (trackSec: number) =>
    anchors.some(
      (anchor) => trackSec >= anchor - lead - STRUCTURE_TOLERANCE_SEC && trackSec <= anchor + STRUCTURE_TOLERANCE_SEC,
    );
  const off = plan.shots.slice(1).filter((shot, index) => {
    const trackSec = shot.startFrame / plan.fps + offset;
    const burst =
      framesToSec(plan, shot.durationFrames) < BURST_SHOT_SEC ||
      framesToSec(plan, plan.shots[index]!.durationFrames) < BURST_SHOT_SEC;
    const inFill = fills.some((fill) => trackSec >= fill.startSec - 0.1 && trackSec <= fill.endSec + 0.1);
    return !burst && !inFill && !onAnchor(trackSec);
  });
  const boundaries = Math.max(1, plan.shots.length - 1);
  const findings: PlanFinding[] = [
    off.length
      ? {
          dimension: "structure-cuts",
          status: "warn",
          score: 0,
          value: off.length,
          target: { max: 0 },
          message: `${off.length} of ${boundaries} shot boundaries are not on a phrase start, section start, break edge, key moment${gridAnchors === "none" ? "" : ` or ${gridAnchors}`}: ${off.map((shot) => `${shot.id}@${round(shot.startFrame / plan.fps + offset, 2)} s`).join(", ")}.`,
          fix: "Start from edit:plan's slots, or move each boundary to the nearest phrase start or surge; cuts inside a fill or a burst under 0.5 s are exempt.",
          shotIds: off.map((shot) => shot.id),
        }
      : {
          dimension: "structure-cuts",
          status: "pass",
          score: 0,
          value: 0,
          target: { max: 0 },
          message: `All ${boundaries} shot boundaries sit on the music's form or grid.`,
          shotIds: [],
        },
  ];
  if (structure) {
    const last = plan.shots.at(-1)!;
    const endSec = (last.startFrame + last.durationFrames) / plan.fps + offset;
    const stop = stopSec(structure);
    const miss = endSec - stop.sec;
    const fine = Math.abs(miss) <= 2 / plan.fps + 1e-6;
    findings.push({
      dimension: "structure-ending",
      status: fine ? "pass" : "warn",
      score: 0,
      value: round(miss, 3),
      target: { max: round(2 / plan.fps, 3) },
      message: fine
        ? `The film ends on the music's ${stop.anchor} at ${round(stop.sec, 2)} s.`
        : `The film ends at track ${round(endSec, 2)} s, ${round(Math.abs(miss), 2)} s ${miss > 0 ? "after" : "before"} the music's ${stop.anchor} at ${round(stop.sec, 2)} s (${structure.ending.kind}).`,
      ...(fine
        ? {}
        : { fix: "Backtime the offset with music:backtime, or trim the last shot so the final frame is the stop." }),
      shotIds: fine ? [] : [last.id],
    });
  }
  return findings;
}

/** What plan:check knows beyond the plan: this film's library blocks and the last films' usage, and whether it is a bespoke film. */
export type PlanContext = { blocks?: readonly UsageBlock[]; recent?: readonly LibraryUsage[]; bespoke?: boolean };

export function checkPlan(
  plan: MotionPlan,
  targets: FilmTargets,
  cueSheet?: CueSheet,
  audioMap?: AudioMap,
  context: PlanContext = {},
): PlanCheck {
  const lengths = plan.shots.map((shot) => framesToSec(plan, shot.durationFrames));
  const findings = [
    ...checkPace(plan, targets, lengths),
    checkVariety(lengths, targets),
    checkHolds(plan, targets),
    checkEntrances(plan),
    checkBoundaries(plan),
    checkLayers(plan),
    checkSubjectFill(plan),
    checkReading(plan),
    checkRepetition(plan),
    checkCues(plan, cueSheet),
    checkCutSoundDecided(plan, cueSheet),
    ...checkContinuity(plan),
    checkLinearCurves(plan),
    checkTextHolds(plan),
    checkEntryHierarchy(plan),
    ...(context.blocks ? [checkCrossFilmRepetition(context.blocks, context.recent ?? [])] : []),
    ...(context.bespoke ? [checkSignature(plan)] : []),
  ];
  const scored = findings.filter((finding) => !UNSCORED_PLAN_DIMENSIONS.includes(finding.dimension));
  const riskScore = round(scored.reduce((sum, finding) => sum + finding.score, 0) / scored.length, 2);
  const durationSec = lengths.reduce((sum, length) => sum + length, 0);
  return {
    schemaVersion: 1,
    planProjectId: plan.projectId,
    verdict: riskScore >= BLOCKING_RISK || findings.some((finding) => finding.status === "fail") ? "fail" : "pass",
    riskScore,
    stats: {
      shots: plan.shots.length,
      durationSec: round(durationSec, 2),
      medianShotSec: round(median(lengths), 2),
      variety: round(varietyRatio(lengths), 2),
      shotsPer30Sec: round((plan.shots.length / durationSec) * 30, 1),
    },
    findings,
    ...(audioMap ? { advisory: checkStructure(plan, audioMap, cueSheet) } : {}),
  };
}
