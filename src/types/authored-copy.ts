import { z } from "zod";
const copy = (max: number, lines: number, required = false) =>
  z
    .string()
    .max(max)
    .refine(
      (v) => !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(v),
      "Copy contains unsupported control characters",
    )
    .refine((v) => v.split("\n").length <= lines, "Copy exceeds drafting line bound")
    .refine((v) => !required || v.trim().length > 0, "Headline must be nonblank");
export const AuthoredCopyFields = {
  headline: copy(80, 3, true).optional(),
  subtext: copy(160, 4).nullable().optional(),
};
export const AuthoredCopyCommandSchema = z
  .object({
    type: z.literal("authored-copy"),
    trackId: z.string().min(1).max(200),
    clipId: z.string().min(1).max(200),
    target: z.enum(["legacy", "scene.hook"]),
    ...AuthoredCopyFields,
  })
  .strict()
  .refine((v) => v.headline !== undefined || v.subtext !== undefined, "Choose at least one copy field");
export type AuthoredCopyCommand = z.infer<typeof AuthoredCopyCommandSchema>;
