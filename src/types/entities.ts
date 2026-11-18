import { z } from "zod";
import { AssetRightsSchema, AssetProvenanceSchema } from "./assets";
import { EntityReferenceFactsSchema } from "./reference-view";

export const EntityKindSchema = z.enum(["character", "object", "location", "style", "scene"]);
export type EntityKind = z.infer<typeof EntityKindSchema>;
const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const assetId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const EntityRefSchema = z
  .object({
    entityId: slug,
    kind: EntityKindSchema,
    revision: z.number().int().positive(),
    role: z.string().optional(),
  })
  .strict();
export type EntityRef = z.infer<typeof EntityRefSchema>;
const consent = z
  .object({
    status: z.enum(["unknown", "documented", "not-applicable"]).default("unknown"),
    evidence: z.string().optional(),
    subject: z.string().optional(),
    scope: z.string().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.status === "documented" && (!c.evidence || !c.scope))
      ctx.addIssue({ code: "custom", message: "Documented consent requires supplied evidence and scope." });
  });
const base = z.object({
  id: slug,
  name: z.string().min(1),
  description: z.string().min(1),
  invariants: z.array(z.string().min(1)).default([]),
  allowedChanges: z.array(z.string()).default([]),
  references: z
    .array(
      z
        .object({
          assetId,
          role: z.string().min(1),
          notes: z.string().optional(),
          /** Declared or measured view facts (RFC 0003 §6.1); optional, never defaulted, so old hashes hold. */
          facts: EntityReferenceFactsSchema.optional(),
        })
        .strict(),
    )
    .default([]),
  links: z.array(EntityRefSchema).default([]),
  rights: AssetRightsSchema.default({
    licence: "unknown",
    commercialAllowed: "unknown",
    attributionRequired: "unknown",
  }),
  createdBy: z.string().min(1),
  generationNotes: z.string().optional(),
  /** The verbatim invariant sentence repeated in every prompt that shows this entity (RFC 0003 §6.1). */
  fixedSentence: z.string().min(1).optional(),
});
export const EntityCardInputSchema = z.discriminatedUnion("kind", [
  base
    .extend({
      kind: z.literal("character"),
      appearance: z
        .object({
          physical: z.string(),
          wardrobe: z.string().optional(),
          ageDescription: z.string().optional(),
          distinguishingFeatures: z.array(z.string()).default([]),
        })
        .strict(),
      persona: z
        .object({ role: z.string(), traits: z.array(z.string()).default([]), speakingStyle: z.string().optional() })
        .strict(),
      voice: z
        .object({
          description: z.string(),
          providerVoiceId: z.string().optional(),
          consent,
          /** Imported audio samples of this voice (asset ids). Optional and never defaulted (hash stability). */
          sampleAssetIds: z.array(assetId).min(1).optional(),
          pronunciation: z
            .object({
              dictionaryAssetId: assetId.optional(),
              aliases: z
                .array(z.object({ text: z.string().min(1), alias: z.string().min(1) }).strict())
                .min(1)
                .optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
      likenessConsent: consent.optional(),
    })
    .strict(),
  base
    .extend({
      kind: z.literal("object"),
      physical: z
        .object({
          materials: z.array(z.string()).default([]),
          dimensions: z.string().optional(),
          shape: z.string(),
          label: z.string().optional(),
          function: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  base
    .extend({
      kind: z.literal("location"),
      geography: z.string(),
      layout: z.string(),
      lighting: z.string(),
      timeOfDay: z.string().optional(),
      zones: z.array(z.string()).default([]),
    })
    .strict(),
  base
    .extend({
      kind: z.literal("style"),
      palette: z.array(z.string()).min(1),
      typography: z.array(z.string()).default([]),
      texture: z.string().optional(),
      cameraGrammar: z.string(),
      editGrammar: z.string(),
      prohibitions: z.array(z.string()).default([]),
    })
    .strict(),
  base
    .extend({
      kind: z.literal("scene"),
      action: z.string(),
      objective: z.string(),
      blocking: z.string(),
      continuityBefore: z.string().optional(),
      continuityAfter: z.string().optional(),
      shotIds: z.array(slug).default([]),
    })
    .strict(),
]);
export type EntityCardInput = z.input<typeof EntityCardInputSchema>;
export type EntityCard = z.output<typeof EntityCardInputSchema>;
export const EntityVersionSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    parentRevision: z.number().int().positive().nullable(),
    createdAt: z.string().datetime(),
    card: EntityCardInputSchema,
    referenceSnapshots: z.array(
      z
        .object({
          assetId: z.string(),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          original: z.string(),
          role: z.string(),
          provenance: AssetProvenanceSchema,
          rights: AssetRightsSchema,
        })
        .strict(),
    ),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type EntityVersion = z.infer<typeof EntityVersionSchema>;
export const ApprovalActorSchema = z
  .object({ id: z.string().min(1), kind: z.literal("human"), authorizationEvidence: z.string().min(1) })
  .strict();
export type ApprovalActor = z.infer<typeof ApprovalActorSchema>;
export const EntityApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    approvedAt: z.string().datetime(),
    actor: ApprovalActorSchema,
    versionHash: z.string().regex(/^[a-f0-9]{64}$/),
    referenceHashes: z.array(z.string()),
    consentInferred: z.literal(false),
  })
  .strict();
export type EntityApproval = z.infer<typeof EntityApprovalSchema>;
export const EntityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: slug,
    kind: EntityKindSchema,
    latestRevision: z.number().int().positive(),
    canonicalRevision: z.number().int().positive().nullable(),
    canonicalHistory: z
      .array(
        z
          .object({ revision: z.number().int().positive(), at: z.string().datetime(), actor: ApprovalActorSchema })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.canonicalRevision !== null && manifest.canonicalRevision > manifest.latestRevision)
      ctx.addIssue({ code: "custom", message: "Canonical revision cannot exceed latest revision." });
  });
