import { z } from "zod";
import { CaptionProfileIdSchema } from "./caption-style";

/**
 * What the user wants from their own recording, written once by `footage:next` with goal flags into the source
 * project's `pipeline/footage-goals.json`; every later `footage:next` reads it.
 */
export const FootageGoalSchema = z.enum(["recut", "captions", "vertical", "shorts", "multicam"]);
export const FootageFormatSchema = z.enum(["landscape", "vertical", "square"]);

export const FootageGoalsObjectSchema = z
  .object({
    version: z.literal(1),
    goals: z.array(FootageGoalSchema).min(1),
    formats: z.array(FootageFormatSchema).min(1).optional(),
    captionStyle: CaptionProfileIdSchema.optional(),
    language: z.string().min(2).max(16).optional(),
    /** The recording to edit, relative to the repository root or absolute. */
    source: z.string().min(1).optional(),
    /** Other cameras of the same event, for `multicam`. */
    cameras: z.array(z.string().min(1)).optional(),
    /** `scribe` is paid and verbatim (fillers); `local` is free. */
    transcriber: z.enum(["scribe", "local"]).optional(),
    speakers: z.number().int().min(1).max(32).optional(),
    recutId: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(128)
      .optional(),
    shortsBrief: z.string().min(1).max(2000).optional(),
    /** Pace for every `recut:plan` that `footage:next` prints, within recut:plan's ranges (mid ≤ sentence). */
    midPauseMs: z.number().finite().min(250).max(400).optional(),
    sentencePauseMs: z.number().finite().min(250).max(400).optional(),
    punchIn: z.number().finite().min(1).max(1.2).optional(),
    /** Where the vertical cut runs: `ad` keeps captions clear of the paid-placement interface (`captions:place --placement ad`). */
    placement: z.enum(["organic", "ad"]).optional(),
    /** With `ad`: the one platform it runs on; absent means all three. */
    platform: z.enum(["tiktok", "reels", "shorts"]).optional(),
  })
  .strict();

export const FootageGoalsSchema = FootageGoalsObjectSchema.superRefine((goals, ctx) => {
  if ((goals.midPauseMs ?? 250) > (goals.sentencePauseMs ?? 400))
    ctx.addIssue({
      code: "custom",
      path: ["midPauseMs"],
      message: "midPauseMs must not exceed sentencePauseMs (default 400)",
    });
  if (goals.platform && goals.placement !== "ad")
    ctx.addIssue({ code: "custom", path: ["platform"], message: "platform applies to placement ad only" });
});

export type FootageGoal = z.infer<typeof FootageGoalSchema>;
export type FootageFormat = z.infer<typeof FootageFormatSchema>;
export type FootageGoals = z.infer<typeof FootageGoalsSchema>;
