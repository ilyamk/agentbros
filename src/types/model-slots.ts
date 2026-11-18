import { z } from "zod";
import { FalCategorySchema, InputMediaSchema, OutputKindSchema, ProviderIdSchema } from "./fal-catalog";

const text = z.string().min(1);
const endpoint = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/)
  .max(200);
const slotId = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
export const ModelClassSchema = z.enum(["hero", "balanced", "budget", "draft"]);
export const CandidateStatusSchema = z.enum(["active", "candidate", "retired"]);
export const ModelEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("arena"),
      rank: z.number().int().positive(),
      source: text,
      url: z.url(),
      observedAt: z.iso.date(),
    })
    .strict(),
  z.object({ kind: z.literal("owner"), text, source: text, date: z.iso.date() }).strict(),
  z.object({ kind: z.literal("eval"), result: text, source: text, date: z.iso.date() }).strict(),
  z
    .object({
      kind: z.literal("acceptance"),
      accepted: z.number().int().nonnegative(),
      generations: z.number().int().positive(),
      source: text,
      date: z.iso.date(),
    })
    .strict()
    .refine((row) => row.accepted <= row.generations, "Accepted count exceeds generations"),
  z.object({ kind: z.literal("docs"), source: text, url: z.url(), date: z.iso.date() }).strict(),
]);
export const ReferenceEstimateSchema = z
  .object({
    usd: z.number().finite().nonnegative(),
    per: z.enum(["image", "second", "request"]),
    setting: text,
    source: z.url(),
    observedAsOf: z.iso.date(),
  })
  .strict();
export const ModelSlotCandidateSchema = z
  .object({
    provider: ProviderIdSchema,
    endpoint,
    class: ModelClassSchema,
    alsoClasses: z.array(ModelClassSchema).min(1).optional(),
    order: z.number().int().positive(),
    status: CandidateStatusSchema,
    why: text,
    evidence: z.array(ModelEvidenceSchema),
    addedAt: z.iso.date(),
    notes: text.optional(),
    referenceEstimate: ReferenceEstimateSchema.optional(),
    unverifiedAccepted: z.object({ reason: text, at: z.iso.date() }).strict().optional(),
  })
  .strict();
export const ModelReferenceSettingSchema = z
  .object({
    generateAudio: z.boolean().optional(),
    durationSec: z.number().finite().positive().optional(),
    resolution: text.optional(),
    aspect: z
      .string()
      .regex(/^\d+:\d+$/)
      .optional(),
    images: z.number().int().positive().optional(),
    megapixels: z.number().finite().positive().optional(),
    inputCharacters: z.number().int().positive().optional(),
    inputAudioSec: z.number().finite().positive().optional(),
    inputVideoDurationSec: z.number().finite().nonnegative().optional(),
    inputMegapixels: z.number().finite().nonnegative().optional(),
  })
  .strict();
export const ModelSlotSchema = z
  .object({
    id: slotId,
    title: text,
    description: text,
    concepts: z.array(text),
    categories: z.array(FalCategorySchema).min(1),
    inputs: z.array(InputMediaSchema).optional(),
    outputs: z.array(OutputKindSchema).min(1),
    reviewBy: z.iso.date(),
    reference: ModelReferenceSettingSchema.optional(),
    candidates: z.array(ModelSlotCandidateSchema),
  })
  .strict()
  .superRefine((slot, ctx) => {
    for (const candidate of slot.candidates)
      if (
        candidate.alsoClasses &&
        (new Set(candidate.alsoClasses).size !== candidate.alsoClasses.length ||
          candidate.alsoClasses.includes(candidate.class))
      )
        ctx.addIssue({
          code: "custom",
          path: ["candidates"],
          message: "Additional classes must be distinct from the primary class and each other",
        });
    for (const [label, values] of [
      ["provider/endpoint", slot.candidates.map((c) => `${c.provider}:${c.endpoint}`)],
      ["order", slot.candidates.map((c) => c.order)],
    ] as const) {
      if (new Set(values.map(String)).size !== values.length)
        ctx.addIssue({ code: "custom", path: ["candidates"], message: `Duplicate ${label} within slot` });
    }
  });
export const ModelSlotsFileSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.iso.date(),
    catalogueOnlyConcepts: z.array(text).default([]),
    slots: z.array(ModelSlotSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (new Set(file.slots.map((s) => s.id)).size !== file.slots.length)
      ctx.addIssue({ code: "custom", path: ["slots"], message: "Duplicate slot id" });
  });
const pin = z
  .object({ slot: slotId, provider: ProviderIdSchema, endpoint, reason: text, at: z.iso.datetime() })
  .strict();
export const ModelPreferencesSchema = z
  .object({
    version: z.literal(1),
    pins: z.array(pin),
    avoid: z.array(
      z.object({ slot: slotId.optional(), provider: ProviderIdSchema, endpoint, reason: text.optional() }).strict(),
    ),
    defaultClass: ModelClassSchema.optional(),
  })
  .strict();
export const ModelVerdictSchema = z
  .object({
    version: z.literal(1),
    operationId: text,
    verdict: z.enum(["accepted", "rejected"]),
    reason: text.optional(),
    at: z.iso.datetime(),
  })
  .strict();
export type ModelClass = z.infer<typeof ModelClassSchema>;
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;
export type ModelEvidence = z.infer<typeof ModelEvidenceSchema>;
export type ReferenceEstimate = z.infer<typeof ReferenceEstimateSchema>;
export type ModelSlotCandidate = z.infer<typeof ModelSlotCandidateSchema>;
export type ModelSlot = z.infer<typeof ModelSlotSchema>;
export type ModelSlotsFile = z.infer<typeof ModelSlotsFileSchema>;
export type ModelPreferences = z.infer<typeof ModelPreferencesSchema>;
export type ModelVerdict = z.infer<typeof ModelVerdictSchema>;

export const ModelUseCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: text,
    playbooks: z.array(text).min(1),
    phrasings: z.object({ ru: z.array(text).min(1), en: z.array(text).min(1) }).strict(),
    slots: z.array(slotId).min(1),
    notes: text,
    /** RFC 0003 §10.2: the use case needs reference inputs planned per shot with this command. */
    references: z.literal("refs:plan").optional(),
  })
  .strict();
export const ModelCategoryMappingSchema = z.union([
  z.object({ slots: z.array(slotId).min(1), why: text }).strict(),
  z.object({ excluded: z.literal(true), why: text }).strict(),
]);
export const ModelUseCasesFileSchema = z
  .object({
    version: z.literal(1),
    updatedAt: z.iso.date(),
    useCases: z.array(ModelUseCaseSchema),
    categories: z.partialRecord(FalCategorySchema, ModelCategoryMappingSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (new Set(file.useCases.map((row) => row.id)).size !== file.useCases.length)
      ctx.addIssue({ code: "custom", path: ["useCases"], message: "Duplicate use case id" });
  });
export type ModelUseCase = z.infer<typeof ModelUseCaseSchema>;
export type ModelUseCasesFile = z.infer<typeof ModelUseCasesFileSchema>;

export type ModelReferenceSetting = z.infer<typeof ModelReferenceSettingSchema>;
