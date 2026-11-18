import { z } from "zod";
import { EntityKindSchema } from "./entities";
import { RemoteMediaBindingSchema } from "./remote-media";
import { PreparationIdSchema, GenjutsuModeSchema } from "./model-preparation-binding";
export {
  PreparationIdSchema,
  ModelPreparationBindingSchema,
  GenjutsuModeSchema,
  type GenjutsuMode,
  type ModelPreparationBinding,
} from "./model-preparation-binding";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const assetId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const note = z.string().trim().min(1).max(4000);
const reference = z
  .object({
    kind: EntityKindSchema,
    entityId: PreparationIdSchema,
    revision: z.number().int().positive(),
    role: note,
  })
  .strict();
export const ModelPreparationSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: PreparationIdSchema,
    mode: GenjutsuModeSchema,
    sourceAssetId: assetId,
    remoteSource: RemoteMediaBindingSchema.optional(),
    segment: z
      .object({
        startSec: z.number().nonnegative(),
        durationSec: z.number().min(4).max(30),
        crop: z
          .object({
            x: z.number().int().nonnegative(),
            y: z.number().int().nonnegative(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    references: z.array(reference).max(8),
    target: z
      .object({
        description: note,
        change: note,
        preserve: z.array(note).min(1),
        otherSubjects: z.array(note).default([]),
      })
      .strict(),
    resolution: z.enum(["480p", "720p", "1080p"]).default("720p"),
    presetId: z.uuid().optional(),
    additionalPrompt: z.string().max(6000).optional(),
    useMarkers: z.boolean().default(true),
    audioPolicy: z.enum(["preserve-source", "mute", "replace-in-edit"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== "restyle" && !value.references.length)
      ctx.addIssue({
        code: "custom",
        path: ["references"],
        message: "Motion transfer and object swap need approved image references.",
      });
    if (value.mode === "restyle" && (!value.presetId || value.references.length > 5))
      ctx.addIssue({ code: "custom", message: "Restyle needs a current presetId and at most five image references." });
    if (value.mode !== "restyle" && value.presetId)
      ctx.addIssue({ code: "custom", path: ["presetId"], message: "Only restyle accepts a preset." });
  });
export type ModelPreparationSpec = z.infer<typeof ModelPreparationSpecSchema>;
/** A measured, hash-pinned media file (reused by reference derivatives and packs). */
export const MediaPinSchema = z
  .object({
    assetId,
    sha256: hash,
    original: note,
    bytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    contentType: note,
    durationSec: z.number().positive().optional(),
    fps: z.number().positive().optional(),
    frameCount: z.number().int().positive().optional(),
    hasAudio: z.boolean(),
  })
  .strict();
export const ModelPreparationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: PreparationIdSchema,
    id: PreparationIdSchema,
    createdAt: z.iso.datetime(),
    spec: ModelPreparationSpecSchema,
    endpoint: note,
    schemaSha256: hash,
    requestSha256: hash,
    resolvedInputSha256: hash,
    source: MediaPinSchema,
    preparedSource: MediaPinSchema,
    inputProvenance: z.array(z.object({ assetId, sha256: hash, provenanceSha256: hash }).strict()).min(1),
    references: z.array(z.object({ ...reference.shape, versionHash: hash, media: MediaPinSchema }).strict()).max(8),
    reviewFiles: z.array(z.object({ path: note, sha256: hash }).strict()).min(1),
    warnings: z.array(note),
  })
  .strict();
export type ModelPreparationReceipt = z.infer<typeof ModelPreparationReceiptSchema>;
/** The user's rights statement fields, shared by preparation and reference-pack rights (src/types/references.ts). */
export const RightsStatementShape = {
  status: z.enum(["owned", "licensed", "study-only"]),
  userStatement: note,
  evidence: note,
  recordedAt: z.iso.datetime(),
  processingAllowed: z.literal(true),
  commercialAllowed: z.boolean(),
  placements: z.array(note).min(1),
  usage: z.object({ advertising: z.boolean(), endorsement: z.boolean(), standaloneResale: z.boolean() }).strict(),
  audioRights: z.enum(["owned", "licensed", "muted"]),
  assets: z.array(z.object({ assetId, sha256: hash }).strict()).min(1),
};
export function refineRightsStatement(
  value: { status: "owned" | "licensed" | "study-only"; commercialAllowed: boolean },
  ctx: z.RefinementCtx,
) {
  if (value.status === "study-only" && value.commercialAllowed)
    ctx.addIssue({ code: "custom", message: "Study-only material cannot be cleared for commercial use." });
}
export const PreparationRightsSchema = z
  .object({ schemaVersion: z.literal(1), preparationSha256: hash, ...RightsStatementShape })
  .strict()
  .superRefine(refineRightsStatement);
export type PreparationRights = z.infer<typeof PreparationRightsSchema>;
export const PreparationVisualReviewSchema = z
  .object({
    preparationSha256: hash,
    reviewer: note,
    evidence: note,
    sourceMotionReadable: z.literal(true),
    targetUnambiguous: z.literal(true),
    references: z.array(
      z
        .object({
          sha256: hash,
          identityConsistent: z.literal(true),
          detailReadable: z.literal(true),
          angleSuitable: z.literal(true),
          evidence: note,
        })
        .strict(),
    ),
  })
  .strict();
export const PreparationApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    preparationSha256: hash,
    rightsSha256: hash,
    userStatement: note,
    approvedAt: z.iso.datetime(),
    review: PreparationVisualReviewSchema,
  })
  .strict();
export const PreparationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    preparationSha256: hash,
    operationId: note,
    outputSha256: hash,
    assetId,
    path: note,
  })
  .strict();
export const PreparationResultReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    preparationSha256: hash,
    outputSha256: hash,
    reviewer: note,
    evidence: note,
    identity: z.enum(["pass", "fail", "not-applicable"]),
    motion: z.enum(["pass", "fail"]),
    preservedElements: z.enum(["pass", "fail"]),
    otherSubjects: z.enum(["pass", "fail", "not-applicable"]),
    temporalConsistency: z.enum(["pass", "fail"]),
    audio: z.enum(["pass", "fail", "replace-in-edit"]),
    verdict: z.enum(["pass", "repair", "reshoot"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.verdict === "pass" &&
      [
        value.identity,
        value.motion,
        value.preservedElements,
        value.otherSubjects,
        value.temporalConsistency,
        value.audio,
      ].includes("fail")
    )
      ctx.addIssue({ code: "custom", message: "A failed dimension cannot receive a passing verdict." });
  });
export const MotionCandidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: PreparationIdSchema,
    title: note,
    origin: z.enum(["higgsfield", "social", "stock", "owned"]),
    sourceUrl: z.url(),
    category: note,
    tags: z.array(note),
    market: note,
    observedAt: z.iso.datetime(),
    trendEvidence: note,
    metrics: z.record(z.string(), z.number().nonnegative()).optional(),
    acquisition: z.enum(["public-post", "public-link", "manual-export", "local-asset", "unavailable"]),
    assetId: assetId.optional(),
    rights: z.enum(["unknown", "owned", "licensed", "study-only"]).default("unknown"),
    remoteMedia: RemoteMediaBindingSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.acquisition === "local-asset" && !value.assetId)
      ctx.addIssue({ code: "custom", message: "Local candidates need an imported assetId." });
    if (value.origin === "higgsfield" && value.acquisition === "public-post")
      ctx.addIssue({
        code: "custom",
        message:
          "No supported Higgsfield Motion Library acquisition API is established; use an authorised manual export.",
      });
  });
export type MotionCandidate = z.infer<typeof MotionCandidateSchema>;
