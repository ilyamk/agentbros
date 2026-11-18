import type { ShotCamera } from "../../types/reference";
import { histogramMeans, wasserstein, type LabHistogram } from "./align";

// Findings in words: numeric and tied to a shot or a time, so a builder knows what to change. Thresholds after
// ReelMimic's perception/distance.py (MIT, © 2026 ReelMimic contributors); there is no overall score and no verdict.

export type Finding = {
  component: "alignment" | "cuts" | "timing" | "motion" | "camera" | "colour" | "palette";
  where: string;
  severity: "major" | "minor";
  text: string;
  renderSec?: number;
  referenceSec?: number;
};

const MIN_AMOUNT = 0.015;
const fixed = (value: number, digits = 2) => value.toFixed(digits);
const signed = (value: number, digits = 0) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

/** "38% slower" for a move that takes 1.38 times as long; "30% faster" for one that takes 0.7 times as long. */
export function paceWords(ratio: number): string {
  return ratio >= 1 ? `${Math.round((ratio - 1) * 100)}% slower` : `${Math.round((1 - ratio) * 100)}% faster`;
}

export function amountWords(axis: "x" | "y" | "z" | "r", value: number): string {
  if (axis === "z") return `${signed((Math.exp(value) - 1) * 100)}%`;
  if (axis === "r") return `${signed((value * 180) / Math.PI, 1)}°`;
  return `${signed(value, 2)} frame widths`;
}

const VERBS: Record<string, string> = {
  push_in: "pushes in",
  pull_out: "pulls out",
  move_left: "moves left",
  move_right: "moves right",
  move_up: "moves up",
  move_down: "moves down",
  roll_cw: "rolls clockwise",
  roll_ccw: "rolls counter-clockwise",
  shake: "shakes",
};
const MOVE_NOUNS: Record<string, string> = {
  push_in: "push",
  pull_out: "pull-out",
  move_left: "move left",
  move_right: "move right",
  move_up: "move up",
  move_down: "move down",
  roll_cw: "roll",
  roll_ccw: "roll",
};
const AXIS_KINDS: Record<string, [string, string]> = {
  x: ["move_right", "move_left"],
  y: ["move_down", "move_up"],
  z: ["push_in", "pull_out"],
  r: ["roll_cw", "roll_ccw"],
};

export function cameraWords(kinds: string[]): string {
  if (kinds.length === 1 && kinds[0] === "static") return "holds still";
  const words = kinds.map((kind) => VERBS[kind] ?? kind.replace(/_/g, " "));
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** How clearly a move goes each way, 0-1: half the still threshold counts 0, twice it counts 1. Comparing kinds as sets made 0.0149 against 0.0151 a different move. */
function membership(camera: ShotCamera): Map<string, number> {
  const out = new Map<string, number>();
  for (const [axis, value] of Object.entries(camera.amount)) {
    const weight = Math.min(1, Math.max(0, (Math.abs(value) - 0.5 * MIN_AMOUNT) / (1.5 * MIN_AMOUNT)));
    if (weight > 0) out.set(`${axis}${value > 0 ? "+" : "-"}`, weight);
  }
  if (camera.kind.includes("shake")) out.set("shake", 1);
  return out;
}

/** Soft Jaccard of what two camera moves do: 1 is the same kinds of move, 0 nothing in common. */
export function kindSimilarity(a: ShotCamera, b: ShotCamera): number {
  const first = membership(a);
  const second = membership(b);
  const keys = new Set([...first.keys(), ...second.keys()]);
  if (!keys.size) return 1;
  let shared = 0;
  let either = 0;
  for (const key of keys) {
    shared += Math.min(first.get(key) ?? 0, second.get(key) ?? 0);
    either += Math.max(first.get(key) ?? 0, second.get(key) ?? 0);
  }
  return shared / either;
}

const rmse = (a: number[], b: number[]) =>
  Math.sqrt(a.reduce((sum, value, index) => sum + (value - (b[index] ?? value)) ** 2, 0) / Math.max(1, a.length));

export type CameraComparison = {
  kindMatch: number;
  durationRatio?: number;
  amountRatio?: number;
  easeRmse?: number;
  referenceEase?: string;
  renderEase?: string;
  referenceCss?: string;
};

export function compareCamera(
  where: string,
  reference: ShotCamera,
  render: ShotCamera,
  at: { renderSec: number; referenceSec: number },
): { numbers: CameraComparison; findings: Finding[] } {
  const findings: Finding[] = [];
  const kindMatch = kindSimilarity(reference, render);
  const numbers: CameraComparison = { kindMatch: Number(kindMatch.toFixed(2)) };
  const say = (severity: Finding["severity"], component: Finding["component"], text: string) =>
    findings.push({ component, where, severity, text: `${where}: ${text}`, ...at });
  if (kindMatch < 0.6 && reference.kind.join() !== render.kind.join()) {
    const amount = reference.axis ? ` (${amountWords(reference.axis, reference.amount[reference.axis])})` : "";
    say(
      kindMatch < 0.25 ? "major" : "minor",
      "camera",
      `the reference camera ${cameraWords(reference.kind)}${amount}; this one ${cameraWords(render.kind)}`,
    );
  }
  if (!reference.axis || !render.axis || reference.axis !== render.axis) return { numbers, findings };
  const axis = reference.axis;
  const noun = MOVE_NOUNS[AXIS_KINDS[axis]![reference.amount[axis] >= 0 ? 0 : 1]] ?? "move";
  if (reference.snap !== render.snap) {
    const snapped = render.snap ? "this film" : "the reference";
    const eased = render.snap ? reference : render;
    say(
      "major",
      "camera",
      `${snapped} jumps in one frame where the other moves over ${fixed(eased.durationSec ?? 0)} s (${eased.ease?.gsap ?? "an unfitted curve"})`,
    );
    return { numbers, findings };
  }
  const referenceSpan = reference.span90Sec ?? reference.durationSec;
  const renderSpan = render.span90Sec ?? render.durationSec;
  if (referenceSpan && renderSpan) {
    const ratio = renderSpan / referenceSpan;
    numbers.durationRatio = Number(ratio.toFixed(3));
    if (Math.abs(Math.log2(ratio)) > 0.35)
      say(
        Math.abs(Math.log2(ratio)) > 1 ? "major" : "minor",
        "camera",
        `the ${noun} takes ${fixed(renderSpan)} s against ${fixed(referenceSpan)} s (${paceWords(ratio)})`,
      );
  }
  const referenceAmount = (reference.moveAmount ?? reference.amount)[axis];
  const renderAmount = (render.moveAmount ?? render.amount)[axis];
  if (Math.abs(referenceAmount) > 1e-3) {
    const ratio = Math.abs(renderAmount) / Math.abs(referenceAmount);
    numbers.amountRatio = Number(ratio.toFixed(3));
    if (Math.abs(Math.log2(Math.max(ratio, 1e-3))) > 0.6)
      say(
        Math.abs(Math.log2(Math.max(ratio, 1e-3))) > 1.2 ? "major" : "minor",
        "camera",
        `the ${noun} goes ${amountWords(axis, renderAmount)} against ${amountWords(axis, referenceAmount)}`,
      );
  }
  if (reference.progress && render.progress) {
    const error = rmse(reference.progress, render.progress);
    Object.assign(numbers, {
      easeRmse: Number(error.toFixed(3)),
      referenceEase: reference.ease?.gsap,
      renderEase: render.ease?.gsap,
      referenceCss: reference.ease?.css,
    });
    if (error > 0.08) {
      const same = reference.ease?.gsap === render.ease?.gsap;
      const what = same
        ? `both read as ${reference.ease?.gsap} but the curves differ by ${fixed(error)}`
        : `this one is about ${render.ease?.gsap ?? "unfitted"}, the reference about ${reference.ease?.gsap ?? "unfitted"}`;
      const overshoot =
        (reference.ease?.overshoot ?? 0) > 0.02 ? `, overshoot ${Math.round(reference.ease!.overshoot * 100)}%` : "";
      say(
        error > 0.15 ? "major" : "minor",
        "camera",
        `the ${noun}'s easing differs: ${what}${reference.ease ? `; use ${reference.ease.css}${overshoot}` : ""}`,
      );
    }
  }
  return { numbers, findings };
}

export type ColourComparison = {
  emdL: number;
  emdA: number;
  emdB: number;
  reference: { L: number; a: number; b: number };
  render: { L: number; a: number; b: number };
};

const lab = (means: [number, number, number]) => ({
  L: Number(means[0].toFixed(1)),
  a: Number(means[1].toFixed(1)),
  b: Number(means[2].toFixed(1)),
});

/** One shot's colour against its partner's: brightness by the L distance, warmth by the shift on b. */
export function compareShotColour(
  where: string,
  reference: LabHistogram,
  render: LabHistogram,
  at: { renderSec: number; referenceSec: number },
): { numbers: ColourComparison; findings: Finding[] } {
  const [emdL, emdA, emdB] = wasserstein(reference, render);
  const referenceMeans = histogramMeans(reference);
  const renderMeans = histogramMeans(render);
  const findings: Finding[] = [];
  const darker = renderMeans[0] < referenceMeans[0];
  if (emdL > 10)
    findings.push({
      component: "colour",
      where,
      severity: emdL > 20 ? "major" : "minor",
      text: `${where}: ${darker ? "darker" : "brighter"} than the reference (mean L ${fixed(renderMeans[0], 0)} against ${fixed(referenceMeans[0], 0)}, EMD ${fixed(emdL, 1)})`,
      ...at,
    });
  const shiftB = renderMeans[2] - referenceMeans[2];
  if (Math.abs(shiftB) > 8)
    findings.push({
      component: "colour",
      where,
      severity: "minor",
      text: `${where}: ${shiftB > 0 ? "warmer" : "cooler"} than the reference (Lab b ${signed(renderMeans[2])} against ${signed(referenceMeans[2])})`,
      ...at,
    });
  return {
    numbers: {
      emdL: Number(emdL.toFixed(2)),
      emdA: Number(emdA.toFixed(2)),
      emdB: Number(emdB.toFixed(2)),
      reference: lab(referenceMeans),
      render: lab(renderMeans),
    },
    findings,
  };
}

/** The whole film's colour, each shot weighted by its time on screen. */
export function comparePalette(
  reference: LabHistogram,
  render: LabHistogram,
): { numbers: Omit<ColourComparison, never>; findings: Finding[] } {
  const [emdL, emdA, emdB] = wasserstein(reference, render);
  const referenceMeans = histogramMeans(reference);
  const renderMeans = histogramMeans(render);
  const findings: Finding[] = [];
  if (emdL > 8)
    findings.push({
      component: "palette",
      where: "whole film",
      severity: emdL > 15 ? "major" : "minor",
      text: `Whole film: ${renderMeans[0] > referenceMeans[0] ? "brighter" : "darker"} than the reference (mean L ${fixed(renderMeans[0], 0)} against ${fixed(referenceMeans[0], 0)}, EMD ${fixed(emdL, 1)})`,
    });
  if (emdA + emdB > 10) {
    const da = renderMeans[1] - referenceMeans[1];
    const db = renderMeans[2] - referenceMeans[2];
    const hue = Math.abs(db) >= Math.abs(da) ? (db > 0 ? "warmer" : "cooler") : da > 0 ? "redder" : "greener";
    findings.push({
      component: "palette",
      where: "whole film",
      severity: emdA + emdB > 18 ? "major" : "minor",
      text: `Whole film: ${hue} than the reference (Lab a ${signed(renderMeans[1])} against ${signed(referenceMeans[1])}, b ${signed(renderMeans[2])} against ${signed(referenceMeans[2])})`,
    });
  }
  return {
    numbers: {
      emdL: Number(emdL.toFixed(2)),
      emdA: Number(emdA.toFixed(2)),
      emdB: Number(emdB.toFixed(2)),
      reference: lab(referenceMeans),
      render: lab(renderMeans),
    },
    findings,
  };
}

export function compareTiming(
  where: string,
  referenceSec: number,
  renderSec: number,
  at: { renderSec: number; referenceSec: number },
): Finding | undefined {
  const ratio = renderSec / Math.max(referenceSec, 1e-3);
  if (Math.abs(Math.log2(ratio)) <= 0.5) return undefined;
  return {
    component: "timing",
    where,
    severity: Math.abs(Math.log2(ratio)) > 1 ? "major" : "minor",
    text: `${where}: runs ${fixed(renderSec)} s against ${fixed(referenceSec)} s (${ratio > 1 ? `${Math.round((ratio - 1) * 100)}% longer` : `${Math.round((1 - ratio) * 100)}% shorter`})`,
    ...at,
  };
}

export function compareMotion(
  where: string,
  referenceEnergy: number,
  renderEnergy: number,
  at: { renderSec: number; referenceSec: number },
): Finding | undefined {
  if (referenceEnergy < 0.002 && renderEnergy < 0.002) return undefined;
  const ratio = Math.max(renderEnergy, 1e-4) / Math.max(referenceEnergy, 1e-4);
  if (Math.abs(Math.log2(ratio)) <= 0.6) return undefined;
  return {
    component: "motion",
    where,
    severity: Math.abs(Math.log2(ratio)) > 1.2 ? "major" : "minor",
    text: `${where}: ${ratio > 1 ? `${Math.round((ratio - 1) * 100)}% more` : `${Math.round((1 - ratio) * 100)}% less`} change between frames than the reference (${fixed(renderEnergy, 4)} against ${fixed(referenceEnergy, 4)})`,
    ...at,
  };
}

export const bySeverity = (findings: Finding[]) =>
  [...findings].sort(
    (a, b) => Number(a.severity !== "major") - Number(b.severity !== "major") || a.component.localeCompare(b.component),
  );
