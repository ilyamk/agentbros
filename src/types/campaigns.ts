import { z } from "zod";
import { EntityKindSchema } from "./entities";
import { RecipeRequestSchema } from "./recipes";
const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const usd = z.number().finite().nonnegative().max(1_000_000);
export const EntityPinSchema = z
  .object({
    sourceProjectId: slug,
    kind: EntityKindSchema,
    entityId: slug,
    revision: z.number().int().positive(),
    contentHash: hash,
  })
  .strict();
const LegacyCampaignBindingSchema = z
  .object({
    version: z.literal(1),
    campaignId: slug,
    projectId: slug,
    episodeId: slug,
    manifestHash: hash,
    quotaUsd: usd,
  })
  .strict();
export const ProductionBindingSchema = LegacyCampaignBindingSchema.extend({
  version: z.literal(2),
  ownerProjectId: slug,
  role: z.enum(["shared", "member"]),
}).strict();
export const CampaignBindingSchema = z.discriminatedUnion("version", [
  LegacyCampaignBindingSchema,
  ProductionBindingSchema,
]);
export const CampaignManifestSchema = z
  .object({
    version: z.literal(1),
    id: slug,
    revision: z.number().int().positive(),
    capUsd: usd,
    brand: z
      .object({
        revision: z.number().int().positive(),
        name: z.string().min(1),
        palette: z
          .object({
            accent: z.string(),
            background: z.string(),
            text: z.string(),
          })
          .strict(),
        rules: z.array(z.string()).default([]),
      })
      .strict(),
    world: z
      .object({
        revision: z.number().int().positive(),
        pins: z.array(EntityPinSchema),
        invariants: z.array(z.string()).default([]),
      })
      .strict(),
    episodes: z
      .array(
        z
          .object({
            id: slug,
            projectId: slug,
            quotaUsd: usd,
            language: z.string().min(2),
            voice: z.string().min(1),
            recipe: RecipeRequestSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type CampaignManifest = z.infer<typeof CampaignManifestSchema>;
export const TranslationSchema = z
  .object({
    version: z.literal(1),
    sourceProjectId: slug,
    sourceLanguage: z.string().min(2),
    targetLanguage: z.string().min(2),
    projectId: slug,
    voice: z.string().min(1),
    source: z.string().min(1),
    wordsPerSecond: z.number().min(0.5).max(5),
    scenes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            text: z.string(),
            headline: z.string().min(1),
            subtext: z.string().optional(),
            labels: z.record(z.string(), z.string()).default({}),
            captions: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const OutcomeSchema = z
  .object({
    version: z.literal(1),
    campaignId: slug,
    episodeId: slug,
    observedAt: z.string().datetime(),
    source: z.string().min(1),
    cohort: z.string().min(1),
    metrics: z.record(z.string(), z.number().finite()),
    notes: z.array(z.string()).default([]),
    claims: z.array(z.string()).default([]),
    review: z.object({ reviewedBy: z.string().min(1), evidence: z.string().min(1) }).strict(),
  })
  .strict();
