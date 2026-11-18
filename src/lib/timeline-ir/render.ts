import type { Rational } from "../../types/timeline";
import { numeric } from "./rational";

/** Quantize shared boundaries upward exactly once; adjacent clips cannot drift. */
export function renderBoundary(frame: Rational, timebase: Rational, outputFps: number): number {
  if (!Number.isSafeInteger(outputFps) || outputFps <= 0) throw new Error("Output fps must be a positive integer");
  const numerator = BigInt(frame.num) * BigInt(outputFps) * BigInt(timebase.den);
  const denominator = BigInt(frame.den) * BigInt(timebase.num);
  const result = (numerator + denominator - 1n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Render boundary exceeds safe integer limits");
  return Number(result);
}

export function mediaTiming(
  source: { start: Rational; end: Rational; timebase: Rational },
  rate: Rational,
  outputFps: number,
) {
  return {
    trimBefore: Math.round((numeric(source.start) * outputFps) / numeric(source.timebase)),
    trimAfter: Math.round((numeric(source.end) * outputFps) / numeric(source.timebase)),
    playbackRate: numeric(rate),
  };
}

/** Freeze the selected render inputs so a frame cannot mutate later frames. */
export function freezeRenderData<T>(data: T): T {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      Object.values(value).forEach(visit);
      Object.freeze(value);
    }
  };
  visit(data);
  return data;
}

/** Sequence owns playback span; untrimmed physical original owns zero-origin loop cycles. */
export function audioClipTiming(
  source: { start: Rational; end: Rational; timebase: Rational },
  rate: Rational,
  outputFps: number,
  loop: boolean,
) {
  const timing = mediaTiming(source, rate, outputFps);
  return loop && source.start.num === 0 ? { ...timing, trimAfter: undefined } : timing;
}
