import { z } from "zod";
import type { EditCommand } from "../../types/timeline";
import { validateTimeline } from "../timeline-ir/compiler";
import { applyEdit } from "../timeline-ir/commands";
export const VisualRemoveProposalSchema = z
  .object({
    expectedRevision: z.number().int().safe().nonnegative(),
    trackId: z.string().min(1).max(200),
    clipId: z.string().min(1).max(200),
  })
  .strict();
export function buildVisualRemoveProposal(
  rawTimeline: unknown,
  raw: unknown,
  context: { talkingHead: boolean },
): EditCommand {
  const input = VisualRemoveProposalSchema.parse(raw),
    ir = validateTimeline(rawTimeline);
  if (context.talkingHead) throw Error("Visual remove does not support talking-head/presenter layouts");
  const command: EditCommand = { type: "remove-visual", trackId: input.trackId, clipId: input.clipId };
  applyEdit(ir, command);
  return command;
}
