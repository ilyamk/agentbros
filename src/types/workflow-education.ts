import { z } from "zod";
import { AssetProvenanceSchema, AssetRightsSchema } from "./assets";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(4000);
export const EDUCATION_STAGES = [
  "prerequisite",
  "question",
  "explanation",
  "worked-example",
  "application",
  "recap",
] as const;
export const EducationRequestSchema = z
  .object({
    version: z.literal(1),
    projectId: id,
    title: text,
    audience: text,
    objective: text,
    language: z.string().min(2).max(32),
    formats: z
      .array(z.enum(["vertical", "square", "landscape"]))
      .min(1)
      .max(3)
      .default(["landscape"]),
    sources: z
      .array(
        z
          .object({
            id,
            file: text,
            sha256: hash,
            title: text,
            url: z.string().url().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    claims: z
      .array(
        z
          .object({
            id,
            text,
            basis: z.enum(["direct", "inference", "illustrative", "uncertain"]),
            evidence: z
              .array(z.object({ sourceId: id, excerpt: text, locator: text }).strict())
              .min(1)
              .max(16),
            limitations: z.array(text).max(16).default([]),
            uncertainty: text.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    media: z
      .array(
        z
          .object({
            id,
            file: text,
            sha256: hash,
            kind: z.enum(["image", "video", "audio"]),
            provenance: AssetProvenanceSchema.default({
              origin: "manual",
              tool: "creator-supplied",
              model: "unknown",
              referenceAssetIds: [],
              billing: { status: "unknown" },
            }),
            rights: AssetRightsSchema.default({
              licence: "unknown",
              commercialAllowed: "unknown",
              attributionRequired: "unknown",
            }),
          })
          .strict(),
      )
      .min(4)
      .max(64),
    music: z
      .object({
        mediaId: id,
        sourceStartFrame: z.number().int().nonnegative().default(0),
        loop: z.boolean().default(false),
        volume: z.number().min(0.25).max(0.35).default(0.25),
      })
      .strict(),
    chapters: z
      .array(
        z
          .object({
            id,
            title: text,
            beats: z
              .array(
                z
                  .object({
                    id,
                    stage: z.enum(EDUCATION_STAGES),
                    headline: text,
                    spokenText: text,
                    claimIds: z.array(id).min(1).max(32),
                    visualId: id,
                    visualStartFrame: z.number().int().nonnegative().default(0),
                    voiceId: id,
                    sourceStartFrame: z.number().int().nonnegative(),
                    durationFrames: z.number().int().min(15).max(9000),
                    captions: z
                      .array(
                        z
                          .object({
                            text,
                            startFrame: z.number().int().nonnegative(),
                            endFrame: z.number().int().positive(),
                          })
                          .strict(),
                      )
                      .min(1)
                      .max(512),
                    context: z.array(text).max(16).default([]),
                  })
                  .strict(),
              )
              .length(6),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();
export type EducationRequest = z.infer<typeof EducationRequestSchema>;
