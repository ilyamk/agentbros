import { z } from "zod";
import { RationalSchema } from "./timeline";
const FrameSpan = z.object({ start: RationalSchema, end: RationalSchema }).strict();
export const ProtectedSpanSchema = FrameSpan.extend({
  id: z.string().min(1),
  reason: z.enum(["negation", "caveat", "claim-context", "user-keep"]),
  requires: z.array(z.string()).default([]),
  note: z.string().min(1),
}).strict();
export type ProtectedSpan = z.infer<typeof ProtectedSpanSchema>;
export const ChapterManifestSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    chapters: z
      .array(
        FrameSpan.extend({
          id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
          title: z.string().min(1),
          revision: z.number().int().positive(),
        }).strict(),
      )
      .min(1),
    protectedSpans: z.array(ProtectedSpanSchema).default([]),
  })
  .strict();
export type ChapterManifest = z.infer<typeof ChapterManifestSchema>;
export const ShortSelectionSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    purpose: z.string().min(1),
    approval: z
      .object({
        approvedBy: z.string().min(1),
        approvedAt: z.string().datetime(),
        selectionHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    ranges: z.array(FrameSpan).min(1).max(30),
  })
  .strict();
export type ShortSelection = z.infer<typeof ShortSelectionSchema>;
