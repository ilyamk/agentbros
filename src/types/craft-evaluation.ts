import { z } from "zod";
import { WorkflowKindSchema } from "../lib/workflows/dispatch";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(4000);
export const EvaluationPinSchema = z.object({ id, path: text, sha256: hash }).strict();
const variant = z
  .object({
    id,
    request: EvaluationPinSchema,
    skills: z.array(EvaluationPinSchema).min(1).max(32),
    configuration: EvaluationPinSchema,
    decisions: EvaluationPinSchema,
    evidence: z.array(EvaluationPinSchema).max(64).default([]),
    review: EvaluationPinSchema.optional(),
    delivery: EvaluationPinSchema.optional(),
  })
  .strict();
export const CraftEvaluationRequestSchema = z
  .object({
    version: z.literal(1),
    id,
    scenario: WorkflowKindSchema,
    material: z.enum(["synthetic-fixture", "supplied-pilot"]),
    inputs: z.array(EvaluationPinSchema).min(1).max(128),
    baseline: variant,
    candidate: variant.optional(),
    repairs: z
      .array(
        z
          .object({
            criterion: id,
            baselineFingerprint: hash,
            candidateFingerprint: hash,
            decisionId: id,
            rationale: text,
          })
          .strict(),
      )
      .max(64)
      .default([]),
  })
  .strict();
export type CraftEvaluationRequest = z.infer<typeof CraftEvaluationRequestSchema>;
export type EvaluationPin = z.infer<typeof EvaluationPinSchema>;
export const CraftDecisionSchema = z
  .object({
    version: z.literal(1),
    decisions: z
      .array(
        z
          .object({
            criterion: id,
            observation: text,
            choice: text,
            rationale: text,
            evidenceIds: z.array(id).min(1).max(32),
            unresolved: z.array(text).max(16).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
export const CraftHumanReviewSchema = z
  .object({
    version: z.literal(1),
    origin: z.enum(["human-declared", "synthetic-fixture"]),
    reviewer: text,
    reviewedAt: z.string().datetime(),
    variantFingerprint: hash,
    observations: z
      .array(
        z
          .object({
            criterion: id,
            judgement: z.enum(["accepted", "changes-requested", "uncertain"]),
            note: text,
            evidenceIds: z.array(id).min(1).max(32),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict();
