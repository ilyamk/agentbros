import { z } from "zod";
import { ShortSelectionSchema } from "./longform";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .max(64);
export const ShortsSourcePinSchema = z
  .object({
    projectId: id,
    projectHash: hash,
    timelineRevision: z.number().int().nonnegative(),
    timelineHash: hash,
    chapterFile: z.string().regex(/^pipeline\/[a-zA-Z0-9_-]+\.json$/),
    chapterHash: hash,
    dependenciesHash: hash,
    contextHash: hash,
  })
  .strict();
export const ShortsSeriesRequestSchema = z
  .object({
    version: z.literal(1),
    seriesId: id,
    source: ShortsSourcePinSchema,
    episodes: z
      .array(
        z
          .object({
            selection: ShortSelectionSchema,
            approvedSourceHash: hash,
            formats: z
              .array(z.enum(["vertical", "square"]))
              .min(1)
              .max(2)
              .default(["vertical"]),
          })
          .strict(),
      )
      .min(2)
      .max(30),
  })
  .strict();
export type ShortsSeriesRequest = z.infer<typeof ShortsSeriesRequestSchema>;
export const ShortsEpisodeBindingSchema = z
  .object({
    version: z.literal(1),
    workflow: z.literal("shorts-series"),
    seriesId: id,
    projectId: id,
    seriesHash: hash,
    episodeHash: hash,
  })
  .strict();
