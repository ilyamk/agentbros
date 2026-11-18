import { z } from "zod";
import { ContributorHandleSchema, HttpsUrlSchema } from "./contributor";

const text = z.string().trim().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ShowcaseSlugSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const ShowcaseHarnessSchema = z.enum(["claude-code", "codex"]);
export const ShowcaseVerificationSchema = z.enum(["declared", "receipt", "maintainer", "reproducible"]);
export const ShowcaseReleaseAssetsSchema = z.array(z.object({ name: z.string().min(1), url: HttpsUrlSchema }));
export const ShowcaseMediaSchema = z
  .object({ thumbnail: HttpsUrlSchema, contactSheet: HttpsUrlSchema, preview: HttpsUrlSchema })
  .strict();
export const ShowcaseMediaSourcesSchema = z
  .array(z.object({ kind: z.enum(["thumbnail", "contactSheet", "preview"]), url: HttpsUrlSchema }).strict())
  .max(3)
  .refine((rows) => new Set(rows.map((row) => row.kind)).size === rows.length, "Duplicate media source kind");
export const ShowcaseMediaManifestSchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(
        z
          .object({
            path: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/(?:thumbnail\.jpg|contact-sheet\.jpg|preview\.mp4)$/),
            sha256: hash,
            bytes: z.number().int().positive(),
          })
          .strict(),
      )
      .max(300),
  })
  .strict()
  .refine(
    (manifest) => new Set(manifest.files.map((file) => file.path)).size === manifest.files.length,
    "Duplicate media path",
  );
export const ShowcaseDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    slug: ShowcaseSlugSchema,
    createdAt: z.iso.datetime(),
    title: text.max(160),
    summary: text.max(2000),
    language: text.nullable(),
    format: z.enum(["vertical", "square", "landscape"]),
    durationSec: z.number().positive(),
    playbook: text.nullable(),
    route: text.nullable(),
    filmType: text.nullable(),
    libraryBlocks: z.array(text),
    harness: ShowcaseHarnessSchema.nullable(),
    model: text.nullable(),
    harnessVersion: text,
    wallTimeMin: z.number().nonnegative().nullable(),
    rounds: z.number().int().nonnegative(),
    userInterventions: z.number().int().nonnegative(),
    budget: z
      .object({
        totalUsd: z.number().nonnegative().nullable(),
        byProvider: z.array(z.object({ provider: text, totalUsd: z.number().nonnegative().nullable() }).strict()),
        subscriptionNote: text,
      })
      .strict(),
    settings: z
      .object({
        briefExcerpt: z.string().max(2000),
        musicRoute: text.nullable(),
        voice: text.nullable(),
        references: z.array(z.object({ kind: text, count: z.number().int().positive() }).strict()),
        motionPlanChoices: z.array(z.string().max(300)).max(20),
      })
      .strict(),
    author: z
      .object({
        handle: ContributorHandleSchema,
        displayName: text.max(120),
        links: z.array(HttpsUrlSchema),
        credits: z.string().max(500),
      })
      .strict(),
    links: z.array(HttpsUrlSchema),
    rights: z.string().max(2000).nullable(),
    licence: text.nullable(),
    evidence: z
      .object({ deliveryReceiptHash: hash.nullable(), snapshotId: hash.nullable(), renderHash: hash })
      .strict(),
    verification: ShowcaseVerificationSchema,
    mediaSources: ShowcaseMediaSourcesSchema.optional(),
    media: ShowcaseMediaSchema.optional(),
  })
  .strict();
export const ShowcaseSchema = ShowcaseDraftSchema.safeExtend({
  harness: ShowcaseHarnessSchema,
  model: text,
  rights: text.max(2000),
  licence: text,
});
export type ShowcaseDraft = z.infer<typeof ShowcaseDraftSchema>;
export type Showcase = z.infer<typeof ShowcaseSchema>;
