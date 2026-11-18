import { z } from "zod";
import { SfxKindSchema } from "./film";

const SoundKindSchema = SfxKindSchema.exclude(["none"]);

/** One candidate sound event: where, which cue family it reads as, and how strongly (Earshot's calibrated z). */
export const SfxMapEventSchema = z.object({
  kind: SoundKindSchema,
  startSec: z.number().nonnegative(),
  endSec: z.number().positive(),
  z: z.number(),
  verdict: z.enum(["strong", "plausible"]),
  peakDbfs: z.number().nullable(),
});
export type SfxMapEvent = z.infer<typeof SfxMapEventSchema>;

/**
 * `sfx:map`: a recording's sound events by cue family, from Earshot's semantic search, bound to the source bytes.
 * Candidates, not a verdict: music hits can read as impacts and a quiet sound can be missed.
 */
export const SfxMapSchema = z.object({
  version: z.literal(1),
  engine: z.literal("earshot"),
  advisory: z.literal(true),
  source: z.object({
    file: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    durationSec: z.number().positive(),
  }),
  analysedRange: z.object({ startSec: z.number().nonnegative(), endSec: z.number().positive() }),
  modelRevision: z.string(),
  packageSha: z.string(),
  /** The query each family was searched with, so the map can be reproduced. */
  queries: z.record(z.string(), z.string()),
  events: z.array(SfxMapEventSchema),
  summary: z.object({
    events: z.number().int().nonnegative(),
    perMinute: z.number().nonnegative(),
    byKind: z.record(z.string(), z.object({ count: z.number().int().nonnegative(), perMinute: z.number() })),
    /** The longest stretches without a candidate event, longest first (at most three). */
    longestGaps: z.array(z.object({ startSec: z.number(), endSec: z.number(), durationSec: z.number() })),
  }),
  notice: z.string(),
});
export type SfxMap = z.infer<typeof SfxMapSchema>;
