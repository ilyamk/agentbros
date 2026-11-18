import { z } from "zod";

/**
 * `matte.json`, the receipt `pnpm matte` writes beside its cut-outs (docs/matte.md). The cut-outs themselves follow
 * the rmbg contract: an RGBA PNG at the source's pixel size, the subject opaque and everything else transparent.
 */

export const MatteKindSchema = z.enum(["subject", "person"]);
export const MatteEngineSchema = z.enum(["vision", "onnx"]);
export const MatteEngineRequestSchema = z.enum(["auto", "vision", "onnx"]);

const FlickerSchema = z
  .object({
    /** Frame pairs measured. */
    pairs: z.number().int().nonnegative(),
    /** Share of pixels whose source picture was stable (the pixels the flicker means are taken over). */
    stableShare: z.number().min(0).max(1),
    /** Mean |alpha_t - alpha_t-1| over stable pixels, in 0..255 alpha units. */
    stable: z.number().nonnegative(),
    /** The same over stable edge pixels (alpha strictly between 5 and 250 in either frame), where flicker shows. */
    stableEdge: z.number().nonnegative(),
    /** After smoothing only: mean |smoothed - raw| over moving pixels, the lag the smoothing costs. */
    movingDelta: z.number().nonnegative().nullable(),
  })
  .strict();

export const MatteReceiptSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string(),
    kind: MatteKindSchema,
    requestedEngine: MatteEngineRequestSchema,
    engine: z
      .object({
        name: MatteEngineSchema,
        /** `apple-vision-foreground-instance`, `apple-vision-person-segmentation` or the ONNX model id. */
        model: z.string(),
        /** OS version (vision) or onnxruntime version and provider (onnx). */
        runtime: z.string(),
        /** Person quality level (vision person only). */
        quality: z.enum(["fast", "balanced", "accurate"]).optional(),
        /** sha256 of the prepared worker executable (vision) or of the model weights (onnx). */
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    /** Why `auto` or the request did not get the engine it would have chosen first. */
    fallback: z.string().optional(),
    input: z
      .object({
        path: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        kind: z.enum(["image", "video", "sequence"]),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        fps: z.number().positive().optional(),
        /** First source frame (0-based) of the range, and the number of frames. */
        startFrame: z.number().int().nonnegative(),
        frames: z.number().int().positive(),
      })
      .strict(),
    outputs: z
      .object({
        /** RGBA cut-outs: one file for an image, a printf pattern for frames (`%05d` is the source frame number). */
        cutout: z.string(),
        /** Grey alpha (255 = subject), same naming. */
        alpha: z.string(),
        /** ProRes 4444 with alpha (yuva444p10le), when asked for. */
        prores: z.string().optional(),
      })
      .strict(),
    timings: z
      .object({
        totalMs: z.number().nonnegative(),
        /** Engine start (model load, worker launch) not counted in per-frame times. */
        loadMs: z.number().nonnegative(),
        perFrameMs: z.object({ mean: z.number().nonnegative(), max: z.number().nonnegative() }).strict(),
        temporalMs: z.number().nonnegative(),
        /** 1-minute load average when the run began: timings on a busy machine are not the engine's speed. */
        loadAverage: z.number().nonnegative().optional(),
      })
      .strict(),
    coverage: z
      .object({
        /** Share of pixels at or above half alpha, over the frames. */
        mean: z.number().min(0).max(1),
        min: z.number().min(0).max(1),
        max: z.number().min(0).max(1),
        /** Source frame numbers where the engine found no subject at all. */
        emptyFrames: z.array(z.number().int().nonnegative()),
      })
      .strict(),
    temporal: z
      .object({
        mode: z.enum(["none", "ema"]),
        strength: z.number().min(0).max(1),
        refine: z.boolean(),
        flickerBefore: FlickerSchema.optional(),
        flickerAfter: FlickerSchema.optional(),
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();

export type MatteReceipt = z.infer<typeof MatteReceiptSchema>;
export type MatteKind = z.infer<typeof MatteKindSchema>;
export type MatteEngine = z.infer<typeof MatteEngineSchema>;
export type MatteEngineRequest = z.infer<typeof MatteEngineRequestSchema>;
