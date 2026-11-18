import { z } from "zod";
import { RationalSchema } from "./timeline";
import { ResourceCandidateSchema } from "./resources";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const label = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Control characters forbidden");
const id = z
  .string()
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/);
const time = RationalSchema.refine((value) => value.num >= 0, "Time must be nonnegative");
export const PlatformAudioEvidenceSchema = z
  .object({
    file: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
          !value.split("/").some((part) => ["", ".", ".."].includes(part)),
        "Project-relative evidence path required",
      ),
    sha256: hash,
  })
  .strict();
const review = z
  .object({ reviewedBy: label, reviewedAt: z.iso.datetime(), note: label, evidence: PlatformAudioEvidenceSchema })
  .strict();
const target = z
  .object({
    format: z.enum(["vertical", "square", "landscape"]),
    variant: z.enum(["clean", "captioned"]),
    placement: id,
  })
  .strict();
export const PlatformAudioEntrySchema = z
  .object({
    id,
    platform: z.enum(["tiktok", "instagram", "facebook", "youtube"]),
    resource: ResourceCandidateSchema,
    target,
    territory: z.string().regex(/^[A-Z]{2}$/),
    account: z.object({ kind: z.enum(["personal", "creator", "business"]), identifier: label }).strict(),
    clock: z.literal("seconds-rational-v1"),
    sourceOffset: time,
    videoStart: time,
    videoEnd: time,
    trackDuration: time.refine((value) => value.num > 0),
    evidence: z
      .object({
        selection: PlatformAudioEvidenceSchema,
        licence: PlatformAudioEvidenceSchema,
        territoryAccount: PlatformAudioEvidenceSchema,
      })
      .strict(),
    marks: z.array(z.object({ id, videoTime: time, trackTime: time, label }).strict()).max(256),
    selectionReview: review
      .extend({
        decision: z.literal("declared-suitable-for-manual-placement"),
        selectionHash: hash,
        usageContextSha256: hash,
      })
      .strict(),
    marksReview: review.extend({ selectionHash: hash, marksHash: hash }).strict(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.resource.kind !== "audio" ||
      entry.resource.acquisition !== "native-platform" ||
      !["tiktok-cml", "meta-sound-collection", "youtube-audio-library"].includes(entry.resource.provider)
    )
      context.addIssue({ code: "custom", message: "Explicit native-platform audio catalogue required" });
    if (new TextEncoder().encode(JSON.stringify(entry.resource)).length > 64 * 1024)
      context.addIssue({ code: "custom", message: "Native resource declaration exceeds bound" });
    if (new Set(entry.marks.map((mark) => mark.id.toLowerCase())).size !== entry.marks.length)
      context.addIssue({ code: "custom", message: "Duplicate mark IDs" });
  });
export const PlatformAudioPlacementSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(PlatformAudioEntrySchema).min(1).max(16),
    sourceReviews: z
      .array(
        review
          .extend({
            trackId: id,
            clipId: id,
            assetSha256: hash,
            spanHash: hash,
            musicContent: z.literal("declared-absent"),
            role: z.enum(["speech", "sfx"]),
          })
          .strict(),
      )
      .max(256),
    outputReviews: z
      .array(
        review
          .extend({
            musicContent: z.literal("declared-absent"),
            entryId: id,
            outputSha256: hash,
            sourceSnapshotHash: hash,
            propsHash: hash,
            selectionHash: hash,
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((plan, context) => {
    const ids = plan.entries.map((entry) => entry.id.toLowerCase()),
      slots = plan.entries.map((entry) => JSON.stringify(entry.target));
    if (new Set(ids).size !== ids.length || new Set(slots).size !== slots.length)
      context.addIssue({ code: "custom", message: "Duplicate native selection/target ownership" });
    const sourceKeys = plan.sourceReviews.map((item) => JSON.stringify([item.trackId, item.clipId])),
      outputKeys = plan.outputReviews.map((item) => item.entryId);
    if (plan.outputReviews.some((review) => !plan.entries.some((entry) => entry.id === review.entryId)))
      context.addIssue({ code: "custom", message: "Output review must name a current native entry" });
    if (new Set(sourceKeys).size !== sourceKeys.length || new Set(outputKeys).size !== outputKeys.length)
      context.addIssue({ code: "custom", message: "Ambiguous native audio reviews" });
    if (new TextEncoder().encode(JSON.stringify(plan)).length > 1024 * 1024)
      context.addIssue({ code: "custom", message: "Native plan exceeds byte bound" });
  });
export type PlatformAudioPlacement = z.infer<typeof PlatformAudioPlacementSchema>;
export const PlatformAudioSelectionSchema = z
  .object({
    version: z.literal(1),
    requestHash: hash,
    usageContextSha256: hash,
    projectId: id,
    journalRevision: z.number().int().nonnegative(),
    routingHash: hash,
    sources: z
      .array(
        z
          .object({
            path: z.string().min(1),
            sha256: hash,
            role: z.enum(["edit", "config", "asset", "creative", "caption", "code"]),
          })
          .strict(),
      )
      .max(512),
    entries: z
      .array(
        z
          .object({ id, selectionHash: hash, marksHash: hash, target, sourceSnapshotHash: hash, propsHash: hash })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type PlatformAudioSelection = z.infer<typeof PlatformAudioSelectionSchema>;
export const PlatformAudioFindingSchema = z
  .object({ code: z.string().min(1), message: label, entryId: id.optional() })
  .strict();
export const PlatformAudioHandoffSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("pending-manual"),
    localStatus: z.enum([
      "blocked",
      "eligible-awaiting-movie",
      "eligible-awaiting-delivery-gates",
      "ready-for-manual-placement",
    ]),
    selection: PlatformAudioSelectionSchema.optional(),
    findings: z.array(PlatformAudioFindingSchema).max(128),
    movieBindings: z
      .array(
        z
          .object({
            entryId: id,
            outputSha256: hash,
            sourceSnapshotHash: hash,
            propsHash: hash,
            selectionHash: hash,
            reviewSha256: hash,
          })
          .strict(),
      )
      .max(16),
    provenance: z.literal(
      "Locally checked correspondence; reviews are declarations; external placement, account availability and legal permission remain unverified",
    ),
  })
  .strict();
