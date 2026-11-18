import { z } from "zod";
import { RationalSchema, type EditCommand, type Rational } from "../../types/timeline";
import { validateTimeline, clipDuration, compileTimelineIR } from "../timeline-ir/compiler";
import { add, div, mul, compare, fraction, numeric } from "../timeline-ir/rational";
import { mediaTiming } from "../timeline-ir/render";
import { applyEdit } from "../timeline-ir/commands";
export const VisualSlipProposalSchema = z
  .object({
    expectedRevision: z.number().int().safe().nonnegative(),
    trackId: z.string().min(1).max(200),
    clipId: z.string().min(1).max(200),
    delta: RationalSchema,
  })
  .strict();
/** Physical evidence is resolved privately by the server, never accepted from the caller. */
export type VisualSlipContext = {
  fps: number;
  talkingHead: boolean;
  physicalRate: Rational;
  physicalDuration: Rational;
};
export function buildVisualSlipProposal(rawTimeline: unknown, raw: unknown, context: VisualSlipContext): EditCommand {
  const input = VisualSlipProposalSchema.parse(raw),
    ir = validateTimeline(rawTimeline),
    track = ir.tracks.find((t) => t.id === input.trackId);
  if (!track || track.kind !== "visual") throw Error("Source slip supports visual tracks only");
  const clip = track.clips.find((c) => c.id === input.clipId);
  if (!clip) throw Error("Selected visual clip no longer exists");
  if (context.talkingHead) throw Error("Source slip does not support talking-head/presenter layouts");
  if (clip.captions.length) throw Error("Source slip refuses caption-bearing visual clips");
  // Unknown authored payloads may change animation/phase with source trims. Fail closed.
  if (clip.payload && Object.keys(clip.payload).some((key) => !["originalHash", "reframe"].includes(key)))
    throw Error("Source slip supports plain muted video without authored payload/animation/loop");
  if (
    clip.payload?.originalHash !== undefined &&
    (typeof clip.payload.originalHash !== "string" || !/^[a-f0-9]{64}$/.test(clip.payload.originalHash))
  )
    throw Error("Source slip original metadata checksum unavailable");
  const sorted = [...track.clips].sort((a, b) => compare(a.start, b.start)),
    prior = sorted[sorted.indexOf(clip) - 1];
  if (clip.transition.kind !== "cut" || prior?.transition.kind === "fade")
    throw Error("Source slip requires no attached fades");
  if (input.delta.num === 0) throw Error("Source slip makes no change");
  if (
    !Number.isSafeInteger(context.fps) ||
    context.fps <= 0 ||
    context.physicalRate.num <= 0 ||
    context.physicalDuration.num <= 0
  )
    throw Error("Source slip requires a verified physical clock");
  const source = { ...clip.source, start: add(clip.source.start, input.delta), end: add(clip.source.end, input.delta) };
  if (
    compare(source.start, fraction(0)) < 0 ||
    compare(div(source.end, source.timebase), context.physicalDuration) > 0 ||
    compare(div(clip.source.end, clip.source.timebase), context.physicalDuration) > 0
  )
    throw Error("Source slip exceeds the physical original interval");
  const rateDen = BigInt(fraction(clip.rate.num, clip.rate.den).den);
  if ((rateDen & (rateDen - 1n)) !== 0n) throw Error("Source slip requires an exactly representable playback rate");
  const exact = (value: Rational, clock: Rational, label: string) => {
    if (mul(div(value, clock), fraction(context.fps)).den !== 1)
      throw Error("Source slip requires exact rendered " + label + " frame boundaries; no rounding");
  };
  exact(clip.start, ir.timebase, "output");
  exact(add(clip.start, clipDuration(clip, ir.timebase)), ir.timebase, "output");
  for (const value of [clip.source.start, clip.source.end, source.start, source.end]) {
    exact(value, source.timebase, "source");
    if (mul(div(value, source.timebase), context.physicalRate).den !== 1)
      throw Error("Source slip requires exact decoded physical frame boundaries");
  }
  const timing = mediaTiming(source, clip.rate, context.fps);
  if (timing.playbackRate !== numeric(clip.rate) || timing.trimBefore >= timing.trimAfter)
    throw Error("Source slip cannot preserve rendered phase");
  const command: EditCommand = { type: "replace", trackId: track.id, clipId: clip.id, assetId: clip.assetId, source };
  const next = applyEdit(ir, command),
    changed = next.tracks.find((t) => t.id === track.id)!.clips.find((c) => c.id === clip.id)!;
  if (
    compare(clipDuration(clip, ir.timebase), clipDuration(changed, ir.timebase)) !== 0 ||
    compare(compileTimelineIR(ir).duration, compileTimelineIR(next).duration) !== 0
  )
    throw Error("Source slip must preserve the exact output interval");
  return command;
}
