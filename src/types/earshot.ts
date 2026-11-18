import { z } from "zod";

export const EarshotRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z
    .object({
      action: z.literal("render"),
      sound: z
        .string()
        .regex(/^[a-z0-9_-]+(?:\/[a-z0-9_-]+){1,3}$/)
        .max(150),
      seed: z.number().int().min(0).max(4294967295).default(1),
      duration: z.number().positive().max(30).optional(),
      apex: z.number().nonnegative().max(30).optional(),
      pitch: z
        .string()
        .regex(/^[A-Ga-g][#b]?-?\d$/)
        .optional(),
      cueKind: z.enum(["sub-drop", "hit", "riser", "whoosh", "click", "tick", "pop", "glass", "chime"]).optional(),
      alignTo: z.enum(["onset", "peak", "end"]).default("peak"),
    })
    .strict()
    .refine(
      (value) => value.duration === undefined || value.apex === undefined || value.apex <= value.duration,
      "Apex exceeds the requested sound duration",
    ),
  z.object({ action: z.literal("check"), input: z.string().min(1) }).strict(),
  z
    .object({
      action: z.literal("find"),
      input: z.string().min(1),
      query: z.string().min(1).max(1000),
      top: z.number().int().min(1).max(20).default(5),
      start: z.number().nonnegative().optional(),
      end: z.number().positive().optional(),
      kind: z.enum(["auto", "event", "texture"]).default("auto"),
    })
    .strict()
    .refine(
      (value) => value.start === undefined || value.end === undefined || value.end > value.start,
      "End must follow start",
    ),
]);
export type EarshotRequest = z.infer<typeof EarshotRequestSchema>;
export const EarshotSegmentSchema = z
  .object({
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    duration: z.number().finite().positive(),
    score: z.number().finite(),
    z: z.number().finite(),
    cosine: z.number().finite(),
    verdict: z.string(),
    kind: z.enum(["stroke", "event", "window"]),
    peak_dbfs: z.number().finite().nullable(),
    head_db: z.number().finite().nullable(),
    tail_db: z.number().finite().nullable(),
    cut: z.string(),
  })
  .passthrough()
  .refine((value) => value.end > value.start);
