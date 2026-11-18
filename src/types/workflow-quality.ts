import { z } from "zod";
import { BenchPathSchema } from "./bench";
import { WorkflowPinSchema } from "./workflow-evaluation";

export const WorkflowQualitySchema = z
  .object({
    version: z.literal(1),
    task: z.enum([
      "speech.transcribe",
      "text.translate",
      "vision",
      "audio.events",
      "text.assist",
      "text.analyse",
      "speech.synthesise",
    ]),
    language: z.string().min(2),
    licence: z.string().min(1),
    annotations: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("synthetic") }).strict(),
      z
        .object({
          kind: z.literal("independently-reviewed"),
          reviewedBy: z.string().min(1),
          evidence: WorkflowPinSchema,
        })
        .strict(),
    ]),
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            input: WorkflowPinSchema,
            reference: WorkflowPinSchema,
            baseline: WorkflowPinSchema.optional(),
            candidate: BenchPathSchema,
            thresholds: z
              .record(
                z.string().min(1),
                z
                  .object({ min: z.number().finite().optional(), max: z.number().finite().optional() })
                  .strict()
                  .refine(
                    (v) =>
                      (v.min !== undefined || v.max !== undefined) &&
                      (v.min === undefined || v.max === undefined || v.min <= v.max),
                  ),
              )
              .refine((v) => Object.keys(v).length > 0),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine((v) => new Set(v.cases.map((c) => c.id)).size === v.cases.length, "Quality case IDs must be unique")
  .refine(
    (v) => v.annotations.kind !== "independently-reviewed" || v.cases.length >= 3,
    "Reviewed quality corpora need at least three cases",
  );
