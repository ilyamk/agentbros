import { z } from "zod";

export const VisionProfileSchema = z.enum(["overview", "motion", "typography", "ui", "captions", "reference"]);
export const VisionFieldSchema = z.enum(["selectionReason", "text", "measurements", "findings"]);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const VisionEventSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    reasons: z.array(z.string().min(1).max(500)).min(1).max(20),
    clipId: z.string().max(200).optional(),
    text: z.string().max(10000).optional(),
    basis: z.enum(["measured", "declared", "inferred"]).default("declared"),
    reasonEvidence: z
      .array(z.object({ reason: z.string(), basis: z.enum(["measured", "declared", "inferred"]) }))
      .optional(),
  })
  .strict();
export const VisionCropSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export const VisionMeasurementSchema = z
  .object({
    frame: z.number().int().nonnegative(),
    name: z.string().min(1).max(200),
    value: z.union([z.string().max(10000), z.number().finite(), z.boolean()]),
    sourceSha256: Hash,
    basis: z.enum(["measured", "declared", "inferred"]),
    evidence: z.string().min(1).max(1000),
  })
  .strict();
export const VisionRequestSchema = z
  .object({
    version: z.literal(1).default(1),
    input: z.string().min(1),
    profile: VisionProfileSchema.default("overview"),
    events: z.array(VisionEventSchema).max(10000).default([]),
    measurements: z.array(VisionMeasurementSchema).max(10000).default([]),
    crops: z.array(VisionCropSchema).max(100).default([]),
    fields: z.array(VisionFieldSchema).default(["selectionReason", "text", "measurements", "findings"]),
    startFrame: z.number().int().nonnegative().optional(),
    endFrame: z.number().int().nonnegative().optional(),
    step: z.number().int().positive().max(10000).default(1),
    count: z.number().int().min(2).max(300).default(12),
    maxFrames: z.number().int().min(2).max(300).default(80),
    phone: z.boolean().default(false),
  })
  .strict();
export type VisionRequest = z.infer<typeof VisionRequestSchema>;
export type VisionEvent = z.infer<typeof VisionEventSchema>;
export const VisionManifestSchema = z.object({
  version: z.literal(1),
  profile: VisionProfileSchema,
  source: z.object({
    path: z.string(),
    sha256: Hash,
    kind: z.enum(["video", "composition"]),
    width: z.number().positive(),
    height: z.number().positive(),
    fps: z.number().positive(),
    frameCount: z.number().int().positive(),
    clock: z.enum(["verified-cfr", "composition-frames"]),
  }),
  request: VisionRequestSchema,
  frames: z.array(
    z.object({
      id: z.string(),
      frame: z.number().int().nonnegative(),
      timeSec: z.number().nonnegative(),
      reasons: z.array(z.string()),
      reasonEvidence: z
        .array(z.object({ reason: z.string(), basis: z.enum(["measured", "declared", "inferred"]) }))
        .optional(),
      clipId: z.string().optional(),
      text: z.string().optional(),
      basis: z.enum(["measured", "declared", "inferred"]),
      path: z.string(),
      sha256: Hash,
      diff: z.object({ path: z.string(), sha256: Hash, previousFrame: z.number(), mean: z.number() }).optional(),
      measurements: z.array(VisionMeasurementSchema),
      crops: z.array(
        z.object({
          path: z.string(),
          sha256: Hash,
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }),
      ),
    }),
  ),
  pages: z.array(
    z.object({
      path: z.string(),
      html: z.string(),
      htmlSha256: Hash,
      sha256: Hash,
      width: z.number(),
      height: z.number(),
      frameIds: z.array(z.string()),
      kind: z.enum(["frames", "diff"]),
    }),
  ),
  omitted: z.array(VisionEventSchema.extend({ reasons: z.array(z.string()) })),
  warnings: z.array(z.string()),
  readingOrder: z.array(z.string()),
  status: z.literal("needs-review"),
});
export type VisionManifest = z.infer<typeof VisionManifestSchema>;
