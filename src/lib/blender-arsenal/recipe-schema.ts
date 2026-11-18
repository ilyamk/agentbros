import { z } from "zod";

export const RecipeParamSchema = z
  .object({
    type: z.enum(["integer", "number", "string", "boolean"]),
    default: z.union([z.number().finite(), z.string(), z.boolean()]),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    doc: z.string().min(1),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const numeric = spec.type === "number" || spec.type === "integer";
    if (
      numeric
        ? typeof spec.default !== "number" || (spec.type === "integer" && !Number.isInteger(spec.default))
        : typeof spec.default !== spec.type
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Default must match the parameter type" });
    if (
      (!numeric && (spec.min !== undefined || spec.max !== undefined)) ||
      (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid parameter bounds" });
    if (
      typeof spec.default === "number" &&
      ((spec.min !== undefined && spec.default < spec.min) || (spec.max !== undefined && spec.default > spec.max))
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Default is outside bounds" });
  });
export const RecipeMetaSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().min(1),
    category: z.enum([
      "geometry",
      "shader",
      "particles",
      "simulation",
      "volume",
      "curves",
      "lighting",
      "typography",
      "stage",
    ]),
    intent: z.string().min(20),
    params: z.record(z.string(), RecipeParamSchema),
    frames_hint: z.number().int().min(2).max(300),
    cost_hint: z
      .object({ cycles: z.number().nonnegative().nullable(), eevee: z.number().nonnegative().nullable() })
      .strict(),
    status: z.enum(["ready", "experimental"]).default("experimental"),
    needs_bake: z.boolean(),
    inspired_by: z.array(z.string()).optional(),
    requires: z
      .object({
        extensions: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)),
        generators: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
    capabilities: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).optional(),
  })
  .strict();
export type RecipeMeta = z.infer<typeof RecipeMetaSchema>;
export type RecipeParams = Record<string, string | number | boolean>;
export const RecipeStatsSchema = z
  .object({
    recipe: z.string(),
    objects: z.number().int().nonnegative(),
    polygons: z.number().int().nonnegative(),
    instances: z.number().int().nonnegative(),
    result: z
      .object({
        objects: z.array(z.string()),
        materials: z.array(z.string()),
        bake: z
          .object({ path: z.string(), reused: z.boolean(), seconds: z.number().nonnegative() })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();
const PixelStatsSchema = z
  .object({
    mean: z.number(),
    variance: z.number(),
    clippedShare: z.number(),
    coverage: z.number().nullable(),
    contactDarkening: z.number().nullable(),
  })
  .strict();
export const RecipeQualitySchema = z
  .object({
    pass: z.boolean(),
    failures: z.array(z.string()),
    frames: z.array(PixelStatsSchema),
    activity: z.number(),
    peakDelta: z.number(),
    flickerRatio: z.number(),
  })
  .strict();
export const RecipeDeterminismSchema = z
  .object({ pass: z.boolean(), exact: z.boolean(), maxAbsDiff: z.number(), psnr: z.number().nullable() })
  .strict();
export const RecipeProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string(),
    settings: z
      .object({
        samples: z.number(),
        resolution: z.tuple([z.number(), z.number()]),
        frames: z.tuple([z.number(), z.number()]),
        engine: z.enum(["cycles", "eevee"]),
        device: z.enum(["cpu", "auto", "gpu"]).optional(),
        blenderVersion: z.string().optional(),
        frameNumbers: z.array(z.number().int().positive()).min(3).optional(),
      })
      .strict(),
    pass: z.boolean(),
    recipes: z.array(
      z
        .object({
          id: z.string(),
          status: z.enum(["passed", "failed"]),
          error: z.string().optional(),
          sheet: z.string().optional(),
          device: z.string().optional(),
          blenderVersion: z.string().optional(),
          secondsPerFrame: z.number().optional(),
          renderSecondsPerFrame: z.number().optional(),
          stats: RecipeStatsSchema.optional(),
          quality: RecipeQualitySchema.optional(),
          determinism: RecipeDeterminismSchema.optional(),
          cpuDeterminism: RecipeDeterminismSchema.optional(),
          cacheReuse: RecipeStatsSchema.shape.result.shape.bake.optional(),
        })
        .strict(),
    ),
    sheet: z.string().nullable(),
  })
  .strict();
export type RecipeProof = z.infer<typeof RecipeProofSchema>;
