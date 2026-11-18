import { z } from "zod";
import { RhythmOverridesSchema } from "./rhythm-overrides";
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
/** Shared existing RMS detector. Pure numerical samples; no decoder, tool, clock or media authority. */
export function analyzeRhythmPcm(
  bytes: Buffer,
  durationSec: number,
  sourceSha256: string,
  overrides?: z.infer<typeof RhythmOverridesSchema>,
) {
  const hop = 320,
    energy: number[] = [];
  for (let from = 0; from < bytes.length / 4; from += hop) {
    let sum = 0,
      count = 0;
    for (let at = from; at < Math.min(from + hop, bytes.length / 4); at++) {
      const value = bytes.readFloatLE(at * 4);
      if (!Number.isFinite(value)) throw new Error("Nonfinite decoded audio");
      sum += value * value;
      count++;
    }
    energy.push(Math.sqrt(sum / count));
  }
  const onsetsSec: number[] = [],
    onsetSamples: number[] = [];
  for (let i = 1; i < energy.length - 1; i++) {
    const floor = Math.max(0.005, median(energy.slice(Math.max(0, i - 25), i)) * 1.8);
    if (
      energy[i] > floor &&
      energy[i] > energy[i - 1] * 1.5 &&
      (!onsetsSec.length || i * 0.02 - onsetsSec.at(-1)! > 0.12)
    ) {
      onsetsSec.push(i * 0.02);
      onsetSamples.push(i * hop);
    }
  }
  const intervals = onsetsSec
      .slice(1)
      .map((at, i) => at - onsetsSec[i])
      .filter((value) => value >= 0.25 && value <= 1.5),
    interval = median(intervals);
  const confidence =
    intervals.length >= 4 && interval > 0
      ? intervals.filter((value) => Math.abs(value - interval) <= interval * 0.08 + 0.02).length /
        Math.max(intervals.length, onsetsSec.length - 1)
      : 0;
  const reviewed = overrides ? RhythmOverridesSchema.parse(overrides) : undefined;
  if (
    reviewed &&
    (reviewed.beatsSec.some((at) => at >= durationSec) ||
      reviewed.beatsSec.some((at, i) => i > 0 && at <= reviewed.beatsSec[i - 1]))
  )
    throw new Error("Override beats must be strictly ordered and inside audio");
  const sections = Array.from({ length: Math.ceil(durationSec / 4) }, (_, i) => ({
    startSec: i * 4,
    endSec: Math.min(durationSec, (i + 1) * 4),
    rms:
      energy.slice(i * 200, (i + 1) * 200).reduce((sum, value) => sum + value, 0) /
      Math.max(1, energy.slice(i * 200, (i + 1) * 200).length),
  }));
  return {
    onsetSamples,
    report: {
      sourceSha256,
      durationSec,
      algorithm: "rms-onset-v1",
      onsetsSec,
      tempoBpm: confidence >= 0.65 ? 60 / interval : null,
      confidence,
      beatCandidatesSec: reviewed?.beatsSec ?? (confidence >= 0.65 ? onsetsSec : []),
      overrides: reviewed ?? null,
      fallback: reviewed ? "reviewed-marks" : confidence >= 0.65 ? "candidate-beats" : "speech-story-rhythm",
      sections,
      automaticCuts: false as const,
    },
  };
}
