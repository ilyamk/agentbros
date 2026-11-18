import { z } from "zod";
import { AuthoredCopyCommandSchema, AuthoredCopyFields } from "../../types/authored-copy";
export const AuthoredCopyProposalSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    trackId: z.string().min(1).max(200),
    clipId: z.string().min(1).max(200),
    target: z.enum(["legacy", "scene.hook"]),
    ...AuthoredCopyFields,
  })
  .strict()
  .refine((v) => v.headline !== undefined || v.subtext !== undefined, "Choose at least one copy field");
export function authoredCopyCommand(raw: unknown) {
  const { expectedRevision, ...patch } = AuthoredCopyProposalSchema.parse(raw);
  return { expectedRevision, command: AuthoredCopyCommandSchema.parse({ type: "authored-copy", ...patch }) };
}
