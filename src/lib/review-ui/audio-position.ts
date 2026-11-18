import { z } from "zod";
import { RationalSchema, type EditCommand } from "../../types/timeline";
import { validateTimeline, compileTimelineIR, clipDuration } from "../timeline-ir/compiler";
import { add, sub, mul, div, compare, fraction } from "../timeline-ir/rational";
import { applyEdit } from "../timeline-ir/commands";
const binding = {
  expectedRevision: z.number().int().safe().nonnegative(),
  trackId: z.string().min(1).max(200),
  clipId: z.string().min(1).max(200),
};
export const AudioPositionProposalSchema = z.discriminatedUnion("mode", [
  z.object({ ...binding, mode: z.literal("move"), start: RationalSchema }).strict(),
  z.object({ ...binding, mode: z.literal("trim"), sourceStart: RationalSchema, sourceEnd: RationalSchema }).strict(),
]);
/** Propose only existing commands over current music/SFX IDs; no copied clips or clocks. */
export function buildAudioPositionProposal(rawTimeline: unknown, raw: unknown): EditCommand {
  const input = AudioPositionProposalSchema.parse(raw),
    ir = validateTimeline(rawTimeline),
    track = ir.tracks.find((t) => t.id === input.trackId);
  if (!track || !["music", "sfx"].includes(track.kind)) throw Error("Audio positioning supports music/SFX tracks only");
  const clip = track.clips.find((c) => c.id === input.clipId);
  if (!clip) throw Error("Selected audio clip no longer exists");
  const bound = { trackId: track.id, clipId: clip.id };
  let command: EditCommand,
    start = clip.start,
    span = clipDuration(clip, ir.timebase);
  if (input.mode === "move") {
    start = input.start;
    if (compare(start, clip.start) === 0) throw Error("Audio proposal makes no change");
    command = { type: "move", ...bound, start };
  } else {
    if (
      compare(input.sourceStart, clip.source.start) < 0 ||
      compare(input.sourceEnd, clip.source.end) > 0 ||
      compare(input.sourceStart, input.sourceEnd) >= 0
    )
      throw Error("Audio trim must remain inward inside the existing source interval");
    if (compare(input.sourceStart, clip.source.start) === 0 && compare(input.sourceEnd, clip.source.end) === 0)
      throw Error("Audio proposal makes no change");
    const offset = mul(
      div(sub(input.sourceStart, clip.source.start), clip.rate),
      div(ir.timebase, clip.source.timebase),
    );
    start = add(clip.start, offset);
    span = mul(div(sub(input.sourceEnd, input.sourceStart), clip.rate), div(ir.timebase, clip.source.timebase));
    command = {
      type: "batch",
      commands: [
        { type: "trim", ...bound, start: input.sourceStart, end: input.sourceEnd },
        { type: "move", ...bound, start },
      ],
    };
  }
  if (compare(start, fraction(0)) < 0 || compare(add(start, span), compileTimelineIR(ir).duration) > 0)
    throw Error("Audio positioning must remain inside the current timeline interval");
  if (clip.payload?.loop === true && (input.mode === "trim" ? input.sourceStart.num : clip.source.start.num) !== 0)
    throw Error("Audio positioning requires zero source origin for looped originals; no automatic loop change");
  applyEdit(ir, command);
  return command;
}
