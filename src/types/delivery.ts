import { z } from "zod";
import {
  PlatformAudioPlacementSchema,
  PlatformAudioSelectionSchema,
  PlatformAudioHandoffSchema,
} from "./platform-audio";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DeliverySourceSchema = z
  .object({
    path: z.string().min(1),
    sha256: hash,
    role: z.enum(["config", "creative", "edit", "caption", "asset", "code"]),
  })
  .strict();
export const RenderIdentitySchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    format: z.enum(["vertical", "square", "landscape"]),
    captions: z.enum(["on", "off"]),
    compositionId: z.string(),
    durationInFrames: z.number().int().positive(),
    propsHash: hash,
    sourceSnapshotHash: hash,
    storyHash: hash,
    editRevision: z.number().int().nonnegative().nullable(),
    sources: z.array(DeliverySourceSchema),
  })
  .strict();
export type RenderIdentity = z.infer<typeof RenderIdentitySchema>;
export const RenderReceiptSchema = z
  .object({
    version: z.literal(1),
    sourceSnapshotHash: hash,
    propsHash: hash,
    outputSha256: hash,
    format: z.enum(["vertical", "square", "landscape"]),
    captions: z.enum(["on", "off"]),
    createdAt: z.iso.datetime(),
    sources: z.array(DeliverySourceSchema),
    evidence: z.enum(["renderer", "human-declared"]).default("renderer"),
    reviewedBy: z.string().optional(),
    note: z.string().optional(),
    patched: z
      .object({
        baseSha256: hash,
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    partial: z
      .object({
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().nonnegative(),
        totalFrames: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.patched &&
      (receipt.partial || receipt.evidence !== "renderer" || receipt.patched.endFrame < receipt.patched.startFrame)
    )
      context.addIssue({
        code: "custom",
        message: "A patched receipt must describe a complete renderer output with an ordered span",
      });
    if (receipt.evidence === "human-declared" && (!receipt.reviewedBy?.trim() || !receipt.note?.trim()))
      context.addIssue({
        code: "custom",
        message: "Manual render binding requires named reviewer and explicit evidence note",
      });
  });
export type RenderReceipt = z.infer<typeof RenderReceiptSchema>;
const HumanReview = z
  .object({ reviewedBy: z.string().trim().min(1), reviewedAt: z.iso.datetime(), evidence: z.string().trim().min(1) })
  .strict();
export const DeliveryUsageSchema = z
  .object({
    advertising: z.boolean().default(false),
    endorsement: z.boolean().default(false),
    standaloneResale: z.boolean().default(false),
  })
  .strict();
export const DeliverySubtitleTrackSchema = z
  .object({
    trackId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,159}$/),
    language: z
      .string()
      .max(48)
      .regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/),
    filename: z
      .string()
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:srt|vtt)$/)
      .refine(
        (name) => !name.includes("..") && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name),
        "Use a portable local subtitle basename",
      ),
    format: z.enum(["srt", "vtt"]),
  })
  .strict()
  .refine(
    (item) => item.filename.endsWith("." + item.format),
    "Subtitle filename extension must match declared format",
  );
export const DeliverySubtitleOutputSchema = DeliverySubtitleTrackSchema.safeExtend({
  trackSha256: hash,
  cuesSha256: hash,
  sha256: hash,
  cueCount: z.number().int().positive(),
});
export const DeliverySubtitleSelectionSchema = z
  .object({
    version: z.literal(1),
    requestHash: hash,
    timelineSource: DeliverySourceSchema.extend({ role: z.literal("edit") }),
    journalRevision: z.number().int().nonnegative(),
    outputs: z.array(DeliverySubtitleOutputSchema).min(1).max(16),
  })
  .strict();
export const DeliveryRequestSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    mode: z.enum(["production", "draft"]).default("production"),
    formats: z
      .array(z.enum(["vertical", "square", "landscape"]))
      .min(1)
      .refine((v) => new Set(v).size === v.length),
    variants: z
      .array(z.enum(["clean", "captioned"]))
      .min(1)
      .refine((v) => new Set(v).size === v.length),
    timeline: z.boolean().default(false),
    platformAudioPlacement: PlatformAudioPlacementSchema.optional(),
    audioMaster: z.string().optional(),
    fontContext: z.string().min(1).optional(),
    subtitles: z.array(z.enum(["srt", "vtt"])).default([]),
    subtitleTracks: z.array(DeliverySubtitleTrackSchema).min(1).max(16).optional(),
    placements: z.array(z.string().min(1)).min(1),
    commercial: z.boolean().default(true),
    usage: DeliveryUsageSchema.default({ advertising: false, endorsement: false, standaloneResale: false }),
    loudness: z
      .object({
        targetLufs: z.number().min(-30).max(-5),
        toleranceLu: z.number().positive().max(5),
        maxTruePeakDb: z.number().min(-12).max(0),
        audioRequired: z.boolean(),
      })
      .strict(),
    // "pipeline" (template stage approvals) is gone with the stage machine; old requests still parse and fail the review gate.
    approvalMode: z.enum(["pipeline", "manual"]).default("manual"),
    manualApproval: HumanReview.extend({ storyHash: hash, sourceSnapshotHash: hash }).optional(),
    rightsReviews: z
      .array(
        HumanReview.extend({
          sha256: hash,
          licence: z.string().min(1),
          sourceUrl: z.string().min(1),
          commercialAllowed: z.boolean(),
          modifiedAllowed: z.boolean(),
          placements: z.array(z.string()).min(1),
          attribution: z.string(),
          usage: DeliveryUsageSchema.optional(),
        }),
      )
      .default([]),
    declaredClaims: z
      .array(z.object({ id: z.string().min(1), text: z.string().min(1), sceneId: z.string().min(1) }).strict())
      .default([]),
    claimsReview: HumanReview.extend({
      storyHash: hash,
      claims: z.array(
        z
          .object({ id: z.string(), sourceUrl: z.string().url(), supported: z.literal(true), note: z.string().min(1) })
          .strict(),
      ),
    }).optional(),
    visualReview: HumanReview.extend({
      sourceSnapshotHash: hash,
      outputHashes: z.array(hash).min(1),
      approved: z.literal(true),
    }).optional(),
    renderBindings: z.array(RenderReceiptSchema).default([]),
  })
  .strict()
  .superRefine((request, context) => {
    if (!request.subtitleTracks) return;
    if (!request.timeline || request.subtitles.length)
      context.addIssue({
        code: "custom",
        message: "Explicit subtitle tracks require timeline=true and cannot combine with legacy subtitles",
      });
    const names = new Set<string>(),
      pairs = new Set<string>(),
      ids = new Map<string, string>();
    for (const item of request.subtitleTracks) {
      const name = item.filename.toLowerCase(),
        pair = item.trackId + ":" + item.format,
        folded = item.trackId.toLowerCase();
      if (names.has(name) || pairs.has(pair) || (ids.has(folded) && ids.get(folded) !== item.trackId))
        context.addIssue({
          code: "custom",
          message: "Subtitle filenames/track formats/casefold identities must be unambiguous",
        });
      names.add(name);
      pairs.add(pair);
      ids.set(folded, item.trackId);
    }
  });

export type DeliveryRequest = z.input<typeof DeliveryRequestSchema>;
export const DeliverySnapshotSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    id: hash,
    createdAt: z.iso.datetime(),
    identities: z.array(RenderIdentitySchema).min(1),
    subtitleSelection: DeliverySubtitleSelectionSchema.optional(),
    platformAudioSelection: PlatformAudioSelectionSchema.optional(),
  })
  .strict();
export type DeliverySnapshot = z.infer<typeof DeliverySnapshotSchema>;
export const DeliveryFindingSchema = z
  .object({
    code: z.string(),
    severity: z.enum(["error", "warning"]),
    message: z.string(),
    path: z.string().optional(),
    sceneId: z.string().optional(),
  })
  .strict();
export const DeliveryManifestSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string(),
    snapshotId: hash,
    createdAt: z.iso.datetime(),
    state: z.enum(["production-ready", "draft-needs-review", "blocked"]),
    request: DeliveryRequestSchema,
    sourceIdentities: z.array(RenderIdentitySchema),
    findings: z.array(DeliveryFindingSchema),
    outputs: z.array(
      z
        .object({
          path: z.string(),
          sha256: hash,
          format: z.enum(["vertical", "square", "landscape"]),
          variant: z.enum(["clean", "captioned"]),
          sourceSnapshotHash: hash,
          propsHash: hash,
          durationSec: z.number(),
          fps: z.number(),
          width: z.number(),
          height: z.number(),
          integratedLufs: z.number().nullable(),
          truePeakDb: z.number().nullable(),
        })
        .strict(),
    ),
    subtitleOutputs: z.array(DeliverySubtitleOutputSchema).optional(),
    platformAudioPlacement: PlatformAudioHandoffSchema.optional(),
    rights: z.array(z.record(z.string(), z.unknown())),
    costs: z.record(z.string(), z.unknown()).nullable(),
    reviewEvidence: z.record(z.string(), z.unknown()),
    apiCalls: z.literal(0),
  })
  .strict();
