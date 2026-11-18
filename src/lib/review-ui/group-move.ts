import { z } from "zod";
import { RationalSchema, type EditCommand } from "../../types/timeline";
import { compileTimelineIR, clipDuration, validateTimeline } from "../timeline-ir/compiler";
import { applyEdit } from "../timeline-ir/commands";
import { add, compare, fraction } from "../timeline-ir/rational";

export const ReviewGroupMoveSchema = z
  .object({
    expectedRevision: z.number().int().safe().nonnegative(),
    members: z
      .array(z.object({ trackId: z.string().min(1).max(200), clipId: z.string().min(1).max(200) }).strict())
      .min(2)
      .max(24),
    delta: RationalSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.delta.num === 0) context.addIssue({ code: "custom", message: "Group move delta must be nonzero" });
    const keys = value.members.map((member) => JSON.stringify([member.trackId, member.clipId]));
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: "custom", message: "Group members must be unique" });
  });

/** Resolve current visual IDs, never accept copied clips/payloads or authored command trees. */
export function buildVisualGroupMove(timeline: unknown, raw: unknown): EditCommand {
  const request = ReviewGroupMoveSchema.parse(raw),
    ir = validateTimeline(timeline);
  const duration = compileTimelineIR(ir).duration;
  const members = [...request.members].sort((a, b) => {
    const left = JSON.stringify([a.trackId, a.clipId]),
      right = JSON.stringify([b.trackId, b.clipId]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const command: EditCommand = {
    type: "batch",
    commands: members.map((member) => {
      const track = ir.tracks.find((track) => track.id === member.trackId);
      if (!track || track.kind !== "visual") throw new Error("Group move supports existing visual tracks only");
      const clip = track.clips.find((clip) => clip.id === member.clipId);
      if (!clip) throw new Error("Selected group clip no longer exists");
      const start = add(clip.start, request.delta),
        end = add(start, clipDuration(clip, ir.timebase));
      if (compare(start, fraction(0)) < 0 || compare(end, duration) > 0)
        throw new Error("Group move must remain inside the current timeline interval");
      return { type: "move" as const, ...member, start };
    }),
  };
  // Existing reducer validates only the final batch, including overlap and fade adjacency.
  // It clones input and changes only these starts; source/rate/caption/audio ownership remains.
  applyEdit(ir, command);
  return command;
}
