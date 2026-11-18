import { z } from "zod";
import { RationalSchema, type EditCommand, type Rational } from "../../types/timeline";
import { clipDuration, outputToSource, validateTimeline } from "../timeline-ir/compiler";
import { add, sub, mul, div, compare, fraction, numeric } from "../timeline-ir/rational";
import { mediaTiming, renderBoundary } from "../timeline-ir/render";
import { applyEdit } from "../timeline-ir/commands";

export const VisualSplitProposalSchema = z
  .object({
    expectedRevision: z.number().int().safe().nonnegative(),
    trackId: z.string().min(1).max(200),
    clipId: z.string().min(1).max(200),
    at: RationalSchema,
    newClipId: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (value) => value === value.trim() && !/[\x00-\x1f\x7f]/.test(value),
        "Split right clip ID must not contain edge whitespace or control characters",
      ),
  })
  .strict();
/** Private server-supplied renderer classification, never a field of the public request. */
export type VisualSplitRenderContext = { kind: "image" | "video"; fps: number; talkingHead: boolean };
export function buildVisualSplitProposal(
  rawTimeline: unknown,
  raw: unknown,
  context: VisualSplitRenderContext,
): EditCommand {
  const input = VisualSplitProposalSchema.parse(raw),
    ir = validateTimeline(rawTimeline),
    track = ir.tracks.find((t) => t.id === input.trackId);
  if (!track || track.kind !== "visual") throw Error("Split proposal supports visual tracks only");
  const clip = track.clips.find((c) => c.id === input.clipId);
  if (!clip) throw Error("Selected visual clip no longer exists");
  if (context.talkingHead) throw Error("Split proposal does not support talking-head/presenter layouts");
  if (
    clip.payload?.reframe !== undefined &&
    Object.keys(clip.payload).some((key) => !["originalHash", "reframe"].includes(key))
  )
    throw Error("Reframed split requires plain payload only");
  if (clip.captions.length) throw Error("Split proposal preserves captions by refusing caption-bearing visual clips");
  const sorted = [...track.clips].sort((a, b) => compare(a.start, b.start)),
    prior = sorted[sorted.indexOf(clip) - 1];
  if (clip.transition.kind !== "cut" || prior?.transition.kind === "fade")
    throw Error("Split proposal requires no attached incoming or outgoing transition");
  if (context.kind === "video" && (clip.payload?.scene !== undefined || clip.payload?.loop === true))
    throw Error(
      "Split proposal supports plain muted video only; authored overlays/loop phases require separate editing",
    );
  if (!["image", "video"].includes(context.kind))
    throw Error("Split proposal requires an imported image or plain video");
  if (track.clips.some((c) => c.id === input.newClipId)) throw Error("Split right clip ID already exists");
  const end = add(clip.start, clipDuration(clip, ir.timebase));
  if (compare(input.at, clip.start) <= 0 || compare(input.at, end) >= 0)
    throw Error("Split must be inside the current clip output interval");
  const frameClock = fraction(context.fps),
    outputFrame = (value: Rational) => mul(div(value, ir.timebase), frameClock);
  const startFrame = outputFrame(clip.start),
    cutFrame = outputFrame(input.at);
  if (startFrame.den !== 1 || cutFrame.den !== 1)
    throw Error("Split requires exact rendered output-frame boundaries; no automatic rounding");
  if (renderBoundary(end, ir.timebase, context.fps) <= cutFrame.num)
    throw Error("Split would leave an empty rendered right clip");
  const sourceCut = outputToSource(clip, input.at, ir.timebase);
  if (context.kind === "video") {
    const rateDen = BigInt(fraction(clip.rate.num, clip.rate.den).den);
    if ((rateDen & (rateDen - 1n)) !== 0n)
      throw Error("Split video requires an exactly representable playback rate; no approximate phase conversion");
    const sourceFrame = (value: Rational) => mul(div(value, clip.source.timebase), frameClock),
      origin = sourceFrame(clip.source.start),
      cut = sourceFrame(sourceCut);
    if (origin.den !== 1 || cut.den !== 1)
      throw Error("Split source phase is not aligned to rendered frames; no automatic rounding");
    const prior = mediaTiming(clip.source, clip.rate, context.fps),
      right = mediaTiming({ ...clip.source, start: sourceCut }, clip.rate, context.fps);
    const phase = add(fraction(prior.trimBefore), mul(sub(cutFrame, startFrame), clip.rate));
    if (
      compare(phase, fraction(right.trimBefore)) !== 0 ||
      prior.playbackRate !== numeric(clip.rate) ||
      right.trimAfter !== prior.trimAfter
    )
      throw Error("Split would change the rendered video source phase");
  }
  const command: EditCommand = {
    type: "split",
    trackId: track.id,
    clipId: clip.id,
    at: input.at,
    newClipId: input.newClipId,
  };
  applyEdit(ir, command);
  return command;
}
