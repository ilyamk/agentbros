import { z } from "zod";
import { StyleProfileIdSchema, TemplateInstanceSchema } from "./templates";
export const RecipeIdSchema = z.enum([
  "social-hook",
  "ad-direct",
  "product-demo",
  "educational-explainer",
  "youtube-chapter",
  "documentary-story",
  "music-motion",
]);
export const RecipeRequestSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    recipeId: RecipeIdSchema,
    topic: z.string().min(1),
    formats: z
      .array(z.enum(["vertical", "square", "landscape"]))
      .min(1)
      .default(["vertical", "square", "landscape"]),
    experiment: z.literal("proof-scenes@1").optional(),
    styleProfile: StyleProfileIdSchema.optional(),
    durationSec: z.number().min(6).max(1200).optional(),
    media: z
      .array(
        z
          .object({
            source: z.string().min(1),
            kind: z.enum(["image", "video"]),
            attribution: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    beats: z
      .array(
        z
          .object({
            id: z.string(),
            headline: z.string().min(1).optional(),
            text: z.string().optional(),
            durationSec: z.number().min(1).optional(),
            template: TemplateInstanceSchema.optional(),
            proofSource: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type RecipeRequest = z.input<typeof RecipeRequestSchema>;
