import { z } from "zod";

export const ProviderSchema = z.enum(["anthropic", "openai", "openrouter"]);
export const JudgeSlotSchema = z
  .object({
    label: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    provider: ProviderSchema,
    model: z.string().min(1),
    dataCollection: z.enum(["deny", "allow"]).optional(),
    reasoningEffort: z.enum(["low", "medium", "high", "none"]).optional(),
  })
  .strict()
  .refine(
    (slot) =>
      slot.provider !== "openrouter" ||
      (/^[^/]+\/[^/]+$/.test(slot.model) && !slot.model.startsWith("openrouter/") && !slot.model.endsWith("/auto")),
    "OpenRouter requires a concrete family/model ID, never a router",
  );
export type JudgeSlot = z.infer<typeof JudgeSlotSchema>;
export function modelFamily(slot: Pick<JudgeSlot, "provider" | "model">): string {
  return slot.provider === "openrouter" ? slot.model.split("/")[0]! : slot.provider;
}
export const TriageConfigSchema = z
  .object({
    version: z.literal(2),
    enabled: z.boolean().default(false),
    judges: z.tuple([JudgeSlotSchema, JudgeSlotSchema]),
    perPrCapUsd: z.number().finite().positive(),
    monthlyCapUsd: z.number().finite().nonnegative().nullable(),
    maxDiffBytes: z.number().int().positive(),
    maxRunsPerPr: z.number().int().positive().default(2),
    minTierForAutoTriage: z.number().int().min(1).max(3).default(1),
    perOwnerMonthlyRuns: z.number().int().positive().default(4),
    pricing: z.record(
      z.string(),
      z
        .object({
          inputUsdPerMtok: z.number().finite().nonnegative(),
          outputUsdPerMtok: z.number().finite().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (modelFamily(config.judges[0]) === modelFamily(config.judges[1]))
      ctx.addIssue({ code: "custom", message: "Judges must use different model families", path: ["judges"] });
    if (config.judges[0].label === config.judges[1].label)
      ctx.addIssue({ code: "custom", message: "Judge labels must differ", path: ["judges"] });
    for (const [model, price] of Object.entries(config.pricing)) {
      const free = model.endsWith(":free") && /^[^/]+\/[^/]+$/.test(model);
      if (!free && (price.inputUsdPerMtok <= 0 || price.outputUsdPerMtok <= 0))
        ctx.addIssue({
          code: "custom",
          message: "Only explicit OpenRouter :free model prices may be zero",
          path: ["pricing", model],
        });
    }
  });
export type TriageConfig = z.infer<typeof TriageConfigSchema>;

export const UsageSchema = z
  .object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() })
  .strict();
export type Usage = z.infer<typeof UsageSchema>;
export const JudgementSchema = z
  .object({
    verdict: z.enum(["promising", "needs-work", "likely-slop"]),
    scores: z
      .object({
        usefulness: z.number().int().min(1).max(5),
        fit: z.number().int().min(1).max(5),
        duplication: z.number().int().min(1).max(5),
        scope: z.number().int().min(1).max(5),
        tests: z.number().int().min(1).max(5),
        slop: z.number().int().min(1).max(5),
      })
      .strict(),
    reasons: z
      .array(z.object({ file: z.string().min(1).max(500), reason: z.string().min(1).max(2000) }).strict())
      .min(1)
      .max(20),
    canary: z.string().min(1),
  })
  .strict();
export type Judgement = z.infer<typeof JudgementSchema>;

export const AuditJudgementSchema = z
  .object({
    canary: z.string().min(1),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(["high", "medium", "low"]),
            reason: z.string().min(1).max(2000),
            suggestion: z.string().min(1).max(2000),
            files: z.array(z.string().min(1).max(500)).min(1).max(20),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type AuditJudgement = z.infer<typeof AuditJudgementSchema>;

export const SpendRecordSchema = z.discriminatedUnion("event", [
  z
    .object({
      event: z.literal("reserve"),
      id: z.string(),
      runId: z.string(),
      scope: z.enum(["pr", "audit"]).optional(),
      prIdentity: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+#[1-9]\d*$/)
        .optional(),
      at: z.string().datetime(),
      label: z.string(),
      provider: ProviderSchema,
      model: z.string(),
      costUsd: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      event: z.literal("settle"),
      id: z.string(),
      at: z.string().datetime(),
      costUsd: z.number().finite().nonnegative(),
      usage: UsageSchema,
    })
    .strict(),
]);
export type SpendRecord = z.infer<typeof SpendRecordSchema>;

export const TriageArtefactMetadataSchema = z
  .object({
    pr: z.number().int().positive(),
    head: z.string(),
    files: z
      .array(
        z
          .object({
            path: z.string().max(4096),
            additions: z.number().int().nonnegative(),
            deletions: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(3000),
    diff: z
      .object({
        truncated: z.boolean(),
        originalBytes: z.number().int().nonnegative(),
        includedBytes: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const TriageReservationSchema = z
  .object({
    operation: z.string(),
    at: z.string().datetime(),
    boundUsd: z.number().finite().nonnegative(),
    prIdentity: z.string().optional(),
    headSha: z.string().optional(),
    owner: z.string().optional(),
    settled: z.boolean().optional(),
    settledUsd: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .refine((row) => !row.settled || row.settledUsd !== undefined, "Settlement requires a cost");
export const TriageBudgetStateSchema = z
  .object({ version: z.literal(1), reservations: z.array(TriageReservationSchema) })
  .strict();
