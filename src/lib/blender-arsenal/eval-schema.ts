import { z } from "zod";

const text = z.string().trim().min(1);
export const ArsenalTasksSchema = z
  .object({
    version: z.literal(1),
    tasks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            brief: text,
            expected: z
              .object({
                recipes: z.array(text),
                collections: z.array(text),
                extensions: z.array(text),
                builtins: z.array(text),
                commands: z.array(text),
                requiresBake: z.boolean(),
                requiresCredit: z.boolean(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.tasks.map((t) => t.id)).size !== value.tasks.length)
      ctx.addIssue({ code: "custom", message: "Duplicate task ids" });
  });
export const ArsenalPlanSchema = z
  .object({
    commands: z
      .array(
        z
          .object({
            argv: z.array(text).min(2),
            phase: z.enum(["inspect", "local", "after-consent", "after-approval"]),
            purpose: text,
          })
          .strict(),
      )
      .min(1),
    choices: z
      .array(
        z.object({ kind: z.enum(["recipe", "collection", "extension", "builtin"]), id: text, reason: text }).strict(),
      )
      .min(1),
    builtIn: z.object({ method: text, comparison: text }).strict(),
    shot: z.object({ intent: text, camera: text, light: text, kit: z.array(text) }).strict(),
    determinism: z
      .object({
        seed: z.number().int(),
        method: z.enum(["frame-function", "baked", "mixed"]),
        cachePath: z.string().nullable(),
        pixelCheck: text,
      })
      .strict(),
    acquisition: z
      .object({ needsDownload: z.boolean(), consent: z.enum(["required", "not-needed"]), note: text })
      .strict(),
    credits: z.object({ required: z.boolean(), lines: z.array(text) }).strict(),
  })
  .strict();
export type ArsenalPlan = z.infer<typeof ArsenalPlanSchema>;
export type ArsenalTask = z.infer<typeof ArsenalTasksSchema>["tasks"][number];
export const EVAL_WEIGHTS = {
  fit: 20,
  commands: 15,
  builtInFirst: 10,
  consent: 15,
  determinism: 15,
  intent: 5,
  camera: 5,
  light: 5,
  kit: 5,
  credits: 5,
} as const;
export const ArsenalScoreSchema = z
  .object({
    id: text,
    score: z.number(),
    maximum: z.literal(100),
    checks: z.array(
      z
        .object({
          criterion: z.enum(Object.keys(EVAL_WEIGHTS) as [keyof typeof EVAL_WEIGHTS, ...(keyof typeof EVAL_WEIGHTS)[]]),
          pass: z.boolean(),
          points: z.number(),
          reason: text,
        })
        .strict(),
    ),
    error: z.string().nullable(),
  })
  .strict();
export const ArsenalEvalReportSchema = z
  .object({
    version: z.literal(1),
    generatedAt: text,
    harness: z.enum(["codex", "claude"]),
    model: text,
    repository: text,
    revision: text,
    tasksSha256: text,
    schemaSha256: text,
    scorerSha256: text,
    commandAliases: z.array(text),
    weights: z.record(z.string(), z.number()),
    results: z.array(
      ArsenalScoreSchema.extend({
        elapsedMs: z.number(),
        responseFile: text,
        eventsFile: text,
        stderrFile: text,
        plan: ArsenalPlanSchema.nullable(),
      }).strict(),
    ),
    total: z.number(),
    maximum: z.number(),
    percent: z.number(),
    completed: z.number(),
    failures: z.number(),
  })
  .strict();

// Version 1 plans/reports above remain readable as historical evidence.
export const ExecutableArsenalPlanSchema = ArsenalPlanSchema.extend({
  version: z.literal(2),
  execution: z
    .object({
      scripts: z.array(z.object({ path: text, code: text }).strict()),
      recipes: z.array(z.object({ id: text, params: text }).strict()),
      assets: z.array(text),
      extensions: z.array(z.object({ id: text, requiresApproval: z.boolean() }).strict()),
      frames: z.array(z.number().int().positive()).length(2),
      lensMm: z.number().positive(),
      cameraMove: z.enum(["push-in", "dolly", "orbit", "crane", "truck", "handheld", "locked"]),
      lightPreset: text,
      keyFillRatio: z.number().positive(),
      temperatureK: z.number().int().min(1000).max(20000),
      materials: z
        .array(
          z
            .object({
              target: text,
              shader: text,
              roughness: z.number().min(0).max(1),
              metallic: z.number().min(0).max(1),
              assetId: text.nullable(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
}).strict();
export type ExecutableArsenalPlan = z.infer<typeof ExecutableArsenalPlanSchema>;
export const EXECUTION_WEIGHTS = {
  commands: 20,
  references: 20,
  implementation: 20,
  determinism: 15,
  specificity: 15,
  safety: 10,
} as const;
export const ExecutionFindingSchema = z
  .object({
    category: z.enum(["commands", "references", "implementation", "determinism", "specificity", "safety"]),
    message: text,
  })
  .strict();
export const ExecutableScoreSchema = z
  .object({
    id: text,
    sample: z.number().int().positive(),
    score: z.number(),
    maximum: z.literal(100),
    checks: z.array(
      z.object({ criterion: text, pass: z.boolean(), points: z.number(), maximum: z.number(), reason: text }).strict(),
    ),
    findings: z.array(ExecutionFindingSchema),
    error: text.nullable(),
  })
  .strict();
export const DistributionSchema = z
  .object({ mean: z.number(), sd: z.number(), min: z.number(), max: z.number(), n: z.number().int() })
  .strict();
export const ExecutableEvalReportSchema = z
  .object({
    version: z.literal(2),
    generatedAt: text,
    harness: z.enum(["codex", "claude"]),
    model: text,
    repository: text,
    revision: text,
    tasksSha256: text,
    schemaSha256: text,
    scorerSha256: text,
    inventorySha256: text,
    samples: z.number().int().positive(),
    results: z.array(
      ExecutableScoreSchema.extend({
        elapsedMs: z.number(),
        responseFile: text,
        eventsFile: text,
        stderrFile: text,
        plan: ExecutableArsenalPlanSchema.nullable(),
      }).strict(),
    ),
    perTask: z.array(DistributionSchema.extend({ id: text }).strict()),
    overall: DistributionSchema,
    total: z.number(),
    maximum: z.number(),
    percent: z.number(),
    completed: z.number(),
    failures: z.number(),
  })
  .strict();

export const RescoreProvenanceSchema = z
  .object({
    original: text,
    originalScorerSha256: text,
    scorerSha256: text,
    samplesRetained: z.number().int(),
    inventorySha256: text,
    originalErrors: z.array(z.object({ id: text, sample: z.number().int(), error: text }).strict()),
  })
  .strict();
