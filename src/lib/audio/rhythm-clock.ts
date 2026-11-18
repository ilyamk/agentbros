import { RhythmClockSchema, RhythmClockSummarySchema, type RhythmClockSummary } from "../../types/rhythm-evidence";
import { fraction, compare } from "../timeline-ir/rational";
/** Exact original decoded clock; no codec priming/gap repair or container-duration inference. */
export function validateRhythmClock(input: unknown): RhythmClockSummary {
  const clock = RhythmClockSchema.parse(input),
    rate = BigInt(clock.sampleRate),
    num = BigInt(clock.timebase.num),
    den = BigInt(clock.timebase.den);
  let samples = 0n;
  for (const frame of clock.frames) {
    if (BigInt(frame.pts) * num * rate !== samples * den) throw Error("Rhythm clock has offset/gap/overlap");
    samples += BigInt(frame.nbSamples);
    if (samples > 300n * rate) throw Error("Rhythm source exceeds300 seconds");
  }
  if (BigInt(clock.terminalTick) * num * rate !== samples * den)
    throw Error("Rhythm terminal does not equal decoded sample extent");
  const scaled = samples * 16000n;
  if (scaled % rate !== 0n) throw Error("Rhythm resample extent is fractional/unsupported");
  if (samples < rate) throw Error("Rhythm source shorter than one second");
  return RhythmClockSummarySchema.parse({
    sampleRate: clock.sampleRate,
    channels: clock.channels,
    codec: clock.codec,
    timebase: clock.timebase,
    terminalTick: clock.terminalTick,
    sourceSamples: Number(samples),
    analysisSamples: Number(scaled / rate),
    duration: fraction(samples, rate),
  });
}

/** Summary arithmetic is checked independently of any claimed decoder invocation. */
export function validateRhythmClockSummary(input: unknown): RhythmClockSummary {
  const clock = RhythmClockSummarySchema.parse(input),
    samples = BigInt(clock.sourceSamples),
    rate = BigInt(clock.sampleRate);
  if (
    samples < rate ||
    samples > 300n * rate ||
    samples * 16000n !== BigInt(clock.analysisSamples) * rate ||
    BigInt(clock.terminalTick) * BigInt(clock.timebase.num) * rate !== samples * BigInt(clock.timebase.den) ||
    compare(clock.duration, fraction(samples, rate)) !== 0
  )
    throw Error("Rhythm clock summary arithmetic inconsistent");
  return clock;
}
