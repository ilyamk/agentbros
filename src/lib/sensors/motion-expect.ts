import { spawnSync } from "node:child_process";
import { MOTION_SAMPLE_FPS, motionPass, type FilmEvidence } from "../film/evidence";
import { readStills } from "../film/readings";
import { median, round } from "../film/stats";

// Motion expectation for a single clip, typically a generated video: does it move as much as it was asked to?
// Free and local: one 10 fps grey decode through motionPass (the same readings film:measure uses).

/** The overrides apply to "animated" only; "still" always needs STILL_MIN_STILL_SHARE. */
export type MotionExpect = { motion: "animated" | "still"; minMovingShare?: number; maxStillShare?: number };

export type MotionSummary = {
  /** Share of the clip spent in frozen spans (readStills: under STILL_CHANGED_SHARE changing for at least 0.5 s). */
  stillShare: number;
  longestStillSec: number;
  /** Mean absolute grey difference per pixel between samples, 0..255. */
  meanEnergy: number;
  /** Mean share of pixels changing beyond noise between samples. */
  meanChanged: number;
  /** Median share of the 4x4 grid's cells that moved between samples: how much of the picture takes part. */
  medianSpread: number;
  durationSec: number;
};

export type MotionVerdict = { passed: boolean; findings: string[] };

// calibrated on 8 renders, 2026-11-17 (motion pass at 10 fps, 160x90 grey, 4x4 grid):
// - must fail animated: out/contributing-map-loop/loop-draft.mp4, a paid image-to-video clip where only light flickers (and
//   its identical download): stillShare 0.18, longest still 0.9s, meanEnergy 0.267, medianSpread 0.
// - animated, pass: out/qa/blender-proofs-v2/device-array.mp4 spread 0.875 (still 0); vork swarm 0.5; vork cloth 0.375;
//   also a critic calibration clip 1.0 and hf-live-test/hf-light-480p 0.94.
// - known misses: vork fog (slow whole-frame atmospherics) reads stillShare 0.525 and spread 0, as still as the draft, so no
//   grid threshold separates them; viz embedded-landscape (a test pattern, one panel moving) reads spread 0.19. Pass
//   minMovingShare for intentionally local motion.
/** Default for "animated": fail above this share of frozen time. */
export const ANIMATED_MAX_STILL_SHARE = 0.5;
/** Default for "animated": fail when the median sample moves fewer than this share of grid cells. */
export const ANIMATED_MIN_MOVING_SHARE = 0.25;
/** Default for "still": fail under this share of frozen time. */
export const STILL_MIN_STILL_SHARE = 0.9;

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

/** Summary of motion readings; durationSec defaults to the sampled span (one more frame than pairs). */
export function summariseMotion(
  motion: FilmEvidence["motion"],
  spread: number[],
  durationSec = (motion.length + 1) / MOTION_SAMPLE_FPS,
): MotionSummary {
  const stills = readStills(motion, Math.max(durationSec, 1 / MOTION_SAMPLE_FPS));
  return {
    stillShare: Math.min(1, stills.share),
    longestStillSec: stills.longestSec,
    meanEnergy: round(mean(motion.map((row) => row.energy))),
    meanChanged: round(mean(motion.map((row) => row.changed)), 5),
    medianSpread: round(median(spread), 4),
    durationSec: round(durationSec, 2),
  };
}

/** Decodes the file once (ffmpeg) and summarises its motion. Throws a CliErrorObject when ffmpeg fails. */
export function readMotionSummary(file: string): MotionSummary {
  const { motion, spread } = motionPass(file);
  return summariseMotion(motion, spread);
}

export function judgeMotion(readings: MotionSummary, expect: MotionExpect): MotionVerdict {
  const findings: string[] = [];
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  if (readings.durationSec <= 1 / MOTION_SAMPLE_FPS)
    return { passed: false, findings: ["Clip too short to read motion (under two samples)."] };
  if (expect.motion === "animated") {
    const maxStill = expect.maxStillShare ?? ANIMATED_MAX_STILL_SHARE;
    const minMoving = expect.minMovingShare ?? ANIMATED_MIN_MOVING_SHARE;
    if (readings.stillShare > maxStill)
      findings.push(
        `Frozen for ${pct(readings.stillShare)} of ${readings.durationSec}s (longest ${readings.longestStillSec}s); animated allows at most ${pct(maxStill)}.`,
      );
    if (readings.medianSpread < minMoving)
      findings.push(
        `Only ${pct(readings.medianSpread)} of the frame moves in a typical sample (mean change ${readings.meanEnergy}/255); animated needs at least ${pct(minMoving)}.`,
      );
  } else {
    if (readings.stillShare < STILL_MIN_STILL_SHARE)
      findings.push(
        `Frozen for only ${pct(readings.stillShare)} of ${readings.durationSec}s (median ${pct(readings.medianSpread)} of the frame moving); still needs at least ${pct(STILL_MIN_STILL_SHARE)}.`,
      );
  }
  return { passed: findings.length === 0, findings };
}

const VIDEO_EXTENSION = /\.(mp4|mov|webm|mkv|m4v)$/i;

export type OutputMotion = {
  motion: (MotionSummary & { file: string }) | { skipped: string };
  acceptance?: MotionVerdict;
};

/**
 * Post-publish reading of a generated video: never throws, so a paid and kept asset is reported, not failed.
 * Reads the first video file of `outputs`; with `expect`, adds an acceptance verdict.
 */
export function readOutputMotion(outputs: string[], expect?: MotionExpect): OutputMotion | undefined {
  const file = outputs.find((output) => VIDEO_EXTENSION.test(output));
  if (!file) return undefined;
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return { motion: { skipped: "ffmpeg missing" } };
  let summary: MotionSummary;
  try {
    summary = readMotionSummary(file);
  } catch (error) {
    return { motion: { skipped: error instanceof Error ? error.message : String(error) } };
  }
  return { motion: { file, ...summary }, ...(expect ? { acceptance: judgeMotion(summary, expect) } : {}) };
}
