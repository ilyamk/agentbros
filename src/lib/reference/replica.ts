import { cameraWords, type CameraComparison, type ColourComparison, type Finding } from "./findings";
import type { TimeWarp } from "./align";

/**
 * ref:compare --tolerance replica: how close an exact replica must measure. Each measure holds or fails on its own;
 * nothing adds them into a score. A shot the replica spec lists in `swaps[].shots` is exempt from the colour checks:
 * counted `exempt`, never `held`.
 */
export const REPLICA_TOLERANCES = {
  /** A shot's length: within whichever is larger, one frame or 3% of the reference shot. */
  shotDurationFrames: 1,
  shotDurationShare: 0.03,
  /** Each cut, after taking out the whole film's offset. */
  cutOffsetFrames: 1,
  /** The whole film's offset: the one most matched cuts share. */
  alignmentOffsetFrames: 1,
  /** How far from where the alignment puts it a cut is looked for. */
  cutSearchSec: 0.5,
  cameraKindMatch: 0.8,
  /** span90 length and travel, as a share either way. */
  cameraLengthShare: 0.1,
  cameraAmountShare: 0.1,
  /** Used only when one side has no GSAP name: the progress curves' RMSE. */
  easeRmse: 0.05,
  /** Wasserstein distance between the shots' L histograms, in lightness points. */
  lightnessEmd: 5,
  /** Difference of mean Lab b. */
  warmthB: 4,
} as const;

/** How far past its tolerance a miss turns major. */
const MAJOR_FACTOR = 3;
/** Shot times are written to the millisecond. */
const EPSILON_SEC = 0.002;

const EASE_RANK: Record<string, number> = {
  none: 0,
  sine: 1,
  power1: 2,
  power2: 3,
  circ: 3.5,
  power3: 4,
  power4: 5,
  expo: 6,
};

/**
 * Neighbouring GSAP eases: the same direction (`.in`, `.out`, `.inOut`) one step apart on
 * none, sine, power1, power2, circ, power3, power4, expo. `none` neighbours every direction; `back` only `back`.
 */
export function easeNeighbours(a: string, b: string): boolean {
  if (a === b) return true;
  const [familyA, directionA] = a.split(".");
  const [familyB, directionB] = b.split(".");
  if (familyA === "back" || familyB === "back") return false;
  const rankA = EASE_RANK[familyA!];
  const rankB = EASE_RANK[familyB!];
  if (rankA === undefined || rankB === undefined) return false;
  if (familyA !== "none" && familyB !== "none" && directionA !== directionB) return false;
  return Math.abs(rankA - rankB) <= 1;
}

export type MeasureCount = { held: number; failed: number; notMeasured: number; exempt: number };
export const REPLICA_MEASURES = [
  "alignment",
  "cuts",
  "coverage",
  "shotDuration",
  "cameraKind",
  "cameraLength",
  "cameraAmount",
  "ease",
  "lightness",
  "warmth",
] as const;
export type ReplicaMeasure = (typeof REPLICA_MEASURES)[number];

export type ReplicaPair = {
  id: string;
  startSec: number;
  referenceShot: string | null;
  referenceStartSec?: number;
  durationSec?: { reference: number; render: number };
  colour?: ColourComparison;
  camera?: CameraComparison & { reference: string[]; render: string[] };
  /** Whether both sides could have a fitted move compared. */
  cameraComparable: boolean;
};

const signed = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
const frames = (seconds: number, fps: number) => Math.round(seconds * fps);

/** The offset most matched cuts agree with to within `within`; a tie goes to the smaller. A median would split one late cut's difference with the cuts on time. */
export function filmOffset(offsets: number[], within: number): number {
  let best = 0;
  let bestCount = -1;
  for (const candidate of offsets) {
    const count = offsets.filter((offset) => Math.abs(offset - candidate) <= within).length;
    if (count > bestCount || (count === bestCount && Math.abs(candidate) < Math.abs(best))) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** Pairs each reference cut with the nearest unused render cut near where the alignment puts it. */
export function matchCuts(
  referenceCuts: number[],
  renderCuts: number[],
  warp: Pick<TimeWarp, "toRender">,
  searchSec = REPLICA_TOLERANCES.cutSearchSec,
) {
  const candidates = referenceCuts
    .flatMap((reference) =>
      renderCuts.map((render) => ({ reference, render, distance: Math.abs(render - warp.toRender(reference)) })),
    )
    .filter((row) => row.distance <= searchSec)
    .sort((a, b) => a.distance - b.distance);
  const usedReference = new Set<number>();
  const usedRender = new Set<number>();
  const matched: { reference: number; render: number }[] = [];
  for (const row of candidates) {
    if (usedReference.has(row.reference) || usedRender.has(row.render)) continue;
    usedReference.add(row.reference);
    usedRender.add(row.render);
    matched.push({ reference: row.reference, render: row.render });
  }
  return {
    matched: matched.sort((a, b) => a.reference - b.reference),
    missing: referenceCuts.filter((time) => !usedReference.has(time)),
    extra: renderCuts.filter((time) => !usedRender.has(time)),
  };
}

export function replicaFindings(input: {
  fps: number;
  referenceCuts: number[];
  renderCuts: number[];
  warp: Pick<TimeWarp, "toRender">;
  referenceShots: { id: string; startSec: number; endSec: number }[];
  pairs: ReplicaPair[];
  swappedShots?: string[];
}) {
  const swapped = new Set(input.swappedShots ?? []);
  const tolerance = REPLICA_TOLERANCES;
  const frame = 1 / input.fps;
  const counts = Object.fromEntries(
    REPLICA_MEASURES.map((measure) => [measure, { held: 0, failed: 0, notMeasured: 0, exempt: 0 }]),
  ) as Record<ReplicaMeasure, MeasureCount>;
  const findings: Finding[] = [];
  const easeNotes = new Map<string, string>();
  const count = (measure: ReplicaMeasure, held: boolean | undefined) =>
    counts[measure][held === undefined ? "notMeasured" : held ? "held" : "failed"]++;
  const severity = (miss: number, allowed: number): Finding["severity"] =>
    miss > MAJOR_FACTOR * allowed ? "major" : "minor";

  const cuts = matchCuts(input.referenceCuts, input.renderCuts, input.warp);
  const offsets = cuts.matched.map((row) => row.render - row.reference);
  const cutAllowed = tolerance.cutOffsetFrames * frame + EPSILON_SEC;
  const offset = filmOffset(offsets, cutAllowed);
  const alignmentAllowed = tolerance.alignmentOffsetFrames * frame + EPSILON_SEC;
  if (!offsets.length) count("alignment", undefined);
  else {
    const held = Math.abs(offset) <= alignmentAllowed;
    count("alignment", held);
    if (!held)
      findings.push({
        component: "alignment",
        where: "whole film",
        severity: severity(Math.abs(offset), alignmentAllowed),
        text: `Whole film: cuts land ${Math.abs(offset).toFixed(3)} s (${Math.abs(frames(offset, input.fps))} frames) ${offset > 0 ? "late" : "early"} against the reference (the offset most of ${offsets.length} cuts share); allowed ${tolerance.alignmentOffsetFrames} frame.`,
      });
  }
  for (const row of cuts.matched) {
    const residual = row.render - row.reference - offset;
    const held = Math.abs(residual) <= cutAllowed;
    count("cuts", held);
    if (!held)
      findings.push({
        component: "cuts",
        where: `${row.render.toFixed(2)} s`,
        severity: severity(Math.abs(residual), cutAllowed),
        text: `Reference cut at ${row.reference.toFixed(2)} s lands at ${row.render.toFixed(2)} s here, ${Math.abs(frames(residual, input.fps))} frames ${residual > 0 ? "late" : "early"} after the film's offset; allowed ${tolerance.cutOffsetFrames} frame.`,
        referenceSec: row.reference,
        renderSec: row.render,
      });
  }
  for (const time of cuts.missing) {
    count("cuts", false);
    findings.push({
      component: "cuts",
      where: `${input.warp.toRender(time).toFixed(2)} s`,
      severity: "major",
      text: `Reference cut at ${time.toFixed(2)} s has no cut within ${tolerance.cutSearchSec} s of ${input.warp.toRender(time).toFixed(2)} s here.`,
      referenceSec: time,
    });
  }
  for (const time of cuts.extra) {
    count("cuts", false);
    findings.push({
      component: "cuts",
      where: `${time.toFixed(2)} s`,
      severity: "major",
      text: `Cut at ${time.toFixed(2)} s here has no reference cut.`,
      renderSec: time,
    });
  }

  const partnered = new Set(input.pairs.map((pair) => pair.referenceShot).filter(Boolean));
  for (const shot of input.referenceShots) {
    const held = partnered.has(shot.id);
    count("coverage", held);
    if (!held)
      findings.push({
        component: "timing",
        where: `ref ${shot.id}`,
        severity: "major",
        text: `Reference shot ${shot.id} (${shot.startSec.toFixed(2)}-${shot.endSec.toFixed(2)} s) has no replica shot.`,
        referenceSec: shot.startSec,
      });
  }

  for (const pair of input.pairs) {
    if (!pair.referenceShot || !pair.durationSec) continue;
    const where = `${pair.id} vs ref ${pair.referenceShot}`;
    const at = {
      renderSec: pair.startSec,
      ...(pair.referenceStartSec === undefined ? {} : { referenceSec: pair.referenceStartSec }),
    };
    const say = (component: Finding["component"], level: Finding["severity"], text: string) =>
      findings.push({ component, where, severity: level, text: `${where}: ${text}`, ...at });

    const { reference, render } = pair.durationSec;
    const durationAllowed =
      Math.max(tolerance.shotDurationFrames * frame, tolerance.shotDurationShare * reference) + EPSILON_SEC;
    const durationMiss = Math.abs(render - reference);
    count("shotDuration", durationMiss <= durationAllowed);
    if (durationMiss > durationAllowed)
      say(
        "timing",
        severity(durationMiss, durationAllowed),
        `runs ${render.toFixed(3)} s against ${reference.toFixed(3)} s (${signed(frames(render - reference, input.fps), 0)} frames); allowed ${Math.max(tolerance.shotDurationFrames, frames(tolerance.shotDurationShare * reference, input.fps))} frame(s) or 3%`,
      );

    const camera = pair.camera;
    if (!pair.cameraComparable || !camera) {
      for (const measure of ["cameraKind", "cameraLength", "cameraAmount", "ease"] as const) count(measure, undefined);
    } else {
      const kindHeld = camera.kindMatch >= tolerance.cameraKindMatch;
      count("cameraKind", kindHeld);
      if (!kindHeld)
        say(
          "camera",
          camera.kindMatch < 0.4 ? "major" : "minor",
          `the reference camera ${cameraWords(camera.reference)}; this one ${cameraWords(camera.render)} (kind match ${camera.kindMatch.toFixed(2)}; needs ${tolerance.cameraKindMatch})`,
        );
      const ratio = (
        value: number | undefined,
        share: number,
        measure: "cameraLength" | "cameraAmount",
        noun: (percent: number, more: boolean) => string,
      ) => {
        if (value === undefined) return count(measure, undefined);
        const miss = Math.abs(value - 1);
        count(measure, miss <= share + 1e-9);
        if (miss > share + 1e-9)
          say(
            "camera",
            severity(miss, share),
            `${noun(Math.round(miss * 100), value > 1)} (ratio ${value.toFixed(3)}; allowed ±${Math.round(share * 100)}%)`,
          );
      };
      ratio(
        camera.durationRatio,
        tolerance.cameraLengthShare,
        "cameraLength",
        (percent, more) =>
          `the move takes ${percent}% ${more ? "longer" : "less time"} than the reference's (5-95% span)`,
      );
      ratio(
        camera.amountRatio,
        tolerance.cameraAmountShare,
        "cameraAmount",
        (percent, more) => `the move travels ${percent}% ${more ? "further" : "less far"} than the reference's`,
      );
      if (camera.easeRmse === undefined) count("ease", undefined);
      else if (camera.referenceEase && camera.renderEase) {
        const same = camera.referenceEase === camera.renderEase;
        const near = !same && easeNeighbours(camera.referenceEase, camera.renderEase);
        count("ease", same || near);
        if (near)
          easeNotes.set(
            pair.id,
            `${camera.renderEase} is a neighbour of the reference's ${camera.referenceEase}; curves differ by RMSE ${camera.easeRmse.toFixed(3)}`,
          );
        if (!same && !near)
          say(
            "camera",
            camera.easeRmse > 0.15 ? "major" : "minor",
            `ease ${camera.renderEase} against the reference's ${camera.referenceEase} (curve RMSE ${camera.easeRmse.toFixed(3)})${camera.referenceCss ? `; use ${camera.referenceCss}` : ""}`,
          );
      } else {
        const held = camera.easeRmse <= tolerance.easeRmse;
        count("ease", held);
        if (!held)
          say(
            "camera",
            severity(camera.easeRmse, tolerance.easeRmse),
            `the move's progress curve differs from the reference's by RMSE ${camera.easeRmse.toFixed(3)}; allowed ${tolerance.easeRmse}`,
          );
      }
    }

    const colour = pair.colour;
    if (swapped.has(pair.id)) {
      counts.lightness.exempt++;
      counts.warmth.exempt++;
      continue;
    }
    if (!colour) {
      count("lightness", undefined);
      count("warmth", undefined);
      continue;
    }
    const lightHeld = colour.emdL <= tolerance.lightnessEmd;
    count("lightness", lightHeld);
    if (!lightHeld)
      say(
        "colour",
        severity(colour.emdL, tolerance.lightnessEmd),
        `${colour.render.L < colour.reference.L ? "darker" : "brighter"} than the reference (mean L ${colour.render.L.toFixed(1)} against ${colour.reference.L.toFixed(1)}, EMD ${colour.emdL.toFixed(2)}; allowed ${tolerance.lightnessEmd})`,
      );
    const shift = colour.render.b - colour.reference.b;
    const warmHeld = Math.abs(shift) <= tolerance.warmthB;
    count("warmth", warmHeld);
    if (!warmHeld)
      say(
        "colour",
        severity(Math.abs(shift), tolerance.warmthB),
        `${shift > 0 ? "warmer" : "cooler"} than the reference (Lab b ${signed(colour.render.b, 1)} against ${signed(colour.reference.b, 1)}; allowed ±${tolerance.warmthB})`,
      );
  }
  return {
    findings,
    easeNotes,
    summary: { offsetSec: Number(offset.toFixed(3)), withinTolerance: counts, tolerances: tolerance },
  };
}
