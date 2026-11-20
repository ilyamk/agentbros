import { FilmStyleKeySchema } from "./film-styles";
import { z } from "zod";
import { RecipeRequestSchema } from "./recipes";
import { ProjectConfigSchema } from "./video";
import { EntityPinSchema, TranslationSchema } from "./campaigns";
import { FilmTypeSchema, PipelineStageSchema } from "./pipeline";
import { DeliveryRequestSchema } from "./delivery";

export const CampaignId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(100);
export const CampaignProjectId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .max(100);
export const CampaignHash = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.string().min(1).max(4096);
const words = z.string().trim().min(1).max(8000);
const usd = z.number().finite().nonnegative().max(1_000_000);
export const CampaignFileSchema = z.object({ path: file, sha256: CampaignHash }).strict();
export const CampaignScenarioSchema = z.enum([
  "ad-experiments",
  "catalogue-videos",
  "reference-family",
  "localise-campaign",
  "content-series",
]);
export const CampaignAdapterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recipe"), request: RecipeRequestSchema }).strict(),
  z.object({ kind: z.literal("template"), project: ProjectConfigSchema }).strict(),
  z
    .object({
      kind: z.literal("workflow"),
      scenario: z.enum(["product-ad", "education", "recording-edit"]),
      request: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ kind: z.literal("localise"), translation: TranslationSchema }).strict(),
  z
    .object({
      kind: z.literal("film"),
      filmType: FilmTypeSchema,
      playbook: CampaignId,
      styleCard: FilmStyleKeySchema.clone().optional(),
      product: CampaignFileSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("existing"), projectId: CampaignProjectId }).strict(),
]);
export const CampaignAnchorSchema = z
  .object({
    id: CampaignId,
    sceneId: z.string().min(1),
    alignment: CampaignFileSchema,
    at: z.enum(["start", "end", "word"]),
    word: z.string().min(1).optional(),
    occurrence: z.number().int().positive().optional(),
    offsetFrames: z.number().int().default(0),
    overlayId: z.string().min(1).optional(),
    durationFrames: z.number().int().positive().optional(),
  })
  .strict()
  .refine((row) => row.at !== "word" || Boolean(row.word), "Word anchors require a word");
export const CampaignMemberSchema = z
  .object({
    id: CampaignId,
    projectId: CampaignProjectId,
    productId: z.string().min(1).optional(),
    language: z.string().min(2),
    quotaUsd: usd.default(0),
    factors: z.record(z.string(), z.string()).default({}),
    hypothesis: words.optional(),
    scheduledFor: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    adapter: CampaignAdapterSchema,
    excluded: z.boolean().optional(),
    inputs: z.array(CampaignFileSchema).default([]),
    materials: z.array(CampaignId).default([]),
    anchors: z.array(CampaignAnchorSchema).default([]),
    speech: z
      .array(
        z
          .object({
            sceneId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
            audio: CampaignFileSchema,
            alignment: CampaignFileSchema,
          })
          .strict(),
      )
      .default([]),
    fontContext: CampaignFileSchema.optional(),
    expectedProject: CampaignFileSchema.optional(),
    assurance: z
      .object({
        facts: z
          .array(
            z
              .object({
                key: words,
                value: words,
                source: CampaignFileSchema,
                jsonPointer: z.string().startsWith("/").optional(),
              })
              .strict(),
          )
          .default([]),
        requiredText: z.array(words).default([]),
        forbiddenText: z.array(words).default([]),
        referenceSlots: z.array(z.object({ slotId: CampaignId, sceneId: words }).strict()).default([]),
      })
      .strict()
      .optional(),
    formats: z
      .array(z.enum(["vertical", "square", "landscape"]))
      .min(1)
      .default(["vertical"]),
    variants: z
      .array(z.enum(["clean", "captioned"]))
      .min(1)
      .default(["clean"]),
    delivery: DeliveryRequestSchema.optional(),
  })
  .strict();
export const CampaignMaterialSchema = z
  .object({
    id: CampaignId,
    owner: CampaignId.default("shared"),
    source: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("supplied"),
          file: CampaignFileSchema,
          provenance: z.record(z.string(), z.unknown()),
          rights: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("generate"),
          useCase: z.string().min(1),
          request: CampaignFileSchema,
          output: file,
          maxCostUsd: z.number().positive().optional(),
          reason: words,
        })
        .strict(),
    ]),
    dependsOn: z.array(CampaignId).default([]),
  })
  .strict();
export const CampaignMatrixSchema = z
  .object({
    axes: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), z.array(z.string().min(1)).min(1)),
    combinations: z.array(z.record(z.string(), z.string())).min(1).max(1000),
    exclude: z.array(z.record(z.string(), z.string())).default([]),
    memberTemplate: z.record(z.string(), z.unknown()),
  })
  .strict();
export const CampaignCatalogueSchema = z
  .object({
    file: CampaignFileSchema,
    format: z.enum(["csv", "tsv", "json"]),
    idColumn: z.string().min(1),
    columns: z.record(z.string(), z.string()),
    memberTemplate: z.record(z.string(), z.unknown()),
  })
  .strict();
export const CampaignAgentTaskSchema = z
  .object({
    id: CampaignId,
    agent: CampaignId,
    purpose: words,
    dependsOn: z.array(CampaignId).default([]),
    inputs: z.array(CampaignFileSchema).default([]),
    outputs: z.array(file).min(1),
    memberId: CampaignId.optional(),
    requirements: z
      .object({
        commands: z.array(words).max(32),
        modelUseCases: z.array(words).max(32),
        acceptance: z.array(words).min(1).max(32),
      })
      .strict()
      .optional(),
  })
  .strict();
export const CampaignProductionRequestSchema = z
  .object({
    version: z.literal(1),
    id: CampaignId,
    revision: z.number().int().positive(),
    scenario: CampaignScenarioSchema,
    brief: words,
    spend: z.enum(["forbid", "authorised"]).default("forbid"),
    capUsd: usd.default(0),
    sharedQuotaUsd: usd.default(0),
    members: z.array(CampaignMemberSchema).max(1000).default([]),
    matrix: CampaignMatrixSchema.optional(),
    catalogue: CampaignCatalogueSchema.optional(),
    materials: z.array(CampaignMaterialSchema).default([]),
    agentTasks: z.array(CampaignAgentTaskSchema).default([]),
    entityPins: z.array(EntityPinSchema).default([]),
    reference: CampaignFileSchema.optional(),
    sourceCampaign: CampaignId.optional(),
    policy: z
      .object({
        maxAgentAttempts: z.number().int().min(1).max(10).optional(),
        maxTaskAttempts: z.number().int().min(1).max(10).optional(),
        pilotMemberIds: z.array(CampaignId).min(1).max(20).optional(),
        quality: z.enum(["advisory", "strict"]).optional(),
        controlMemberId: CampaignId.optional(),
        variableFactors: z.array(words).optional(),
        variableSceneIds: z.array(words).optional(),
        terminology: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (r) => [r.members.length > 0, Boolean(r.matrix), Boolean(r.catalogue)].filter(Boolean).length === 1,
    "Supply exactly one of members, matrix or catalogue",
  );
export type CampaignProductionRequest = z.input<typeof CampaignProductionRequestSchema>;
export type CampaignRequest = z.output<typeof CampaignProductionRequestSchema>;
export type CampaignMember = z.output<typeof CampaignMemberSchema>;
export type CampaignMaterial = z.output<typeof CampaignMaterialSchema>;
export type CampaignFile = z.infer<typeof CampaignFileSchema>;

export const CampaignAllocationSchema = z
  .object({
    version: z.literal(1),
    campaignId: CampaignId,
    capUsd: usd,
    owners: z.array(z.object({ projectId: CampaignProjectId, episodeId: CampaignId, quotaUsd: usd }).strict()).min(2),
  })
  .strict();
export { ProductionBindingSchema } from "./campaigns";
export const CampaignTaskSchema = z
  .object({
    id: CampaignId,
    kind: z.enum(["material", "prepare", "anchors", "agent", "validate", "snapshot", "render", "qa", "delivery"]),
    memberId: CampaignId.optional(),
    resource: z.enum(["generation", "process", "render", "qa"]),
    dependsOn: z.array(CampaignId),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CampaignTask = z.infer<typeof CampaignTaskSchema>;
export const CampaignProductionPlanSchema = z
  .object({
    version: z.literal(1),
    request: CampaignProductionRequestSchema,
    members: z.array(CampaignMemberSchema).min(1),
    allocation: CampaignAllocationSchema,
    allocationHash: CampaignHash,
    tasks: z.array(CampaignTaskSchema),
    inputPins: z.array(CampaignFileSchema),
    planHash: CampaignHash,
    reusePlan: z
      .array(
        z
          .object({
            memberId: CampaignId,
            projectAction: z.enum(["reuse", "derive", "create"]),
            sourceProjectId: CampaignProjectId.optional(),
            preservedInputs: z.array(CampaignFileSchema),
            materials: z.array(
              z
                .object({
                  id: CampaignId,
                  ownerProjectId: CampaignProjectId,
                  action: z.literal("import-verified-copy"),
                })
                .strict(),
            ),
            recompute: z.array(
              z.enum(["speech-timing", "captions", "events", "render", "technical-qa", "creative-review"]),
            ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type CampaignProductionPlan = z.infer<typeof CampaignProductionPlanSchema>;
export const CampaignTaskReceiptSchema = z
  .object({
    version: z.literal(1),
    taskId: CampaignId,
    planHash: CampaignHash,
    inputHash: CampaignHash,
    outputs: z.array(CampaignFileSchema),
    completedAt: z.string().datetime(),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CampaignTaskReceipt = z.infer<typeof CampaignTaskReceiptSchema>;
export const CampaignDecisionSchema = z
  .object({
    version: z.literal(1),
    taskId: CampaignId,
    planHash: CampaignHash,
    inputHash: CampaignHash,
    agent: CampaignId,
    supersedes: CampaignHash.optional(),
    issues: z
      .array(
        z
          .object({
            id: CampaignId,
            category: z.enum([
              "presentation",
              "timing",
              "facts",
              "rights",
              "language",
              "identity",
              "source",
              "technical",
            ]),
            sceneId: words.optional(),
            instruction: words,
            acceptance: words,
            evidence: z.array(CampaignFileSchema).min(1),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    verdict: z.enum(["accept", "revise", "reject"]),
    rationale: words,
    evidence: z.array(CampaignFileSchema).min(1),
    outputs: z.array(CampaignFileSchema),
  })
  .strict();
export const CampaignReviewMemberSchema = z
  .object({
    id: CampaignId,
    projectId: CampaignProjectId,
    kind: z.enum(["plan", "film", "template", "outputs"]),
    stage: z.string().optional(),
    revision: z.number().int().nonnegative().optional(),
    artefacts: z.record(z.string(), CampaignHash),
    files: z.array(CampaignFileSchema),
    snapshot: CampaignFileSchema.optional(),
    request: CampaignFileSchema.optional(),
  })
  .strict();
export const CampaignReviewPackageSchema = z
  .object({
    version: z.literal(1),
    campaignId: CampaignId,
    planHash: CampaignHash,
    purpose: z.enum(["creative-plan", "generation-requests", "child-gates", "final-outputs", "pilot-outputs"]),
    members: z.array(CampaignReviewMemberSchema).min(1),
    packageHash: CampaignHash,
  })
  .strict();
export type CampaignReviewPackage = z.infer<typeof CampaignReviewPackageSchema>;
export const CampaignStageSchema = PipelineStageSchema;

export const CampaignRepairSchema = z
  .object({
    version: z.literal(1),
    memberId: CampaignId,
    decisionHash: CampaignHash,
    expectedProject: CampaignFileSchema,
    changes: z
      .array(
        z
          .object({
            sceneId: words,
            durationInFrames: z.number().int().min(1).max(18000).optional(),
            transitionToNext: z.enum(["cut", "fade", "crossfade"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    reason: words,
  })
  .strict();
