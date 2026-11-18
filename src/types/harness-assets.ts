import { z } from "zod";
import { AssetRightsSchema, AssetProvenanceSchema } from "./assets";
import { EntityKindSchema } from "./entities";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const text = z.string().min(1).max(8192);
export const HarnessFilePinSchema = z.object({ file: z.string().min(1).max(1024), sha256: hash }).strict();
export const HarnessCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtime: z.enum(["codex", "claude", "other"]),
    sessionId: id,
    evidenceKind: z.enum(["observed-runtime", "supplied-runtime"]),
    evidence: HarnessFilePinSchema,
    observedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    tools: z
      .array(
        z
          .object({
            toolId: id,
            available: z.boolean(),
            kinds: z
              .array(z.enum(["image", "video", "audio"]))
              .min(1)
              .max(3),
            operations: z
              .array(z.enum(["generate", "edit"]))
              .min(1)
              .max(2),
            selectableModels: z.array(z.string().min(1).max(256)).max(100).default([]),
            quota: z.enum(["unknown", "available", "exhausted"]).default("unknown"),
            localOriginalOutput: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (Date.parse(c.expiresAt) <= Date.parse(c.observedAt))
      ctx.addIssue({ code: "custom", message: "Capability expiry must follow observation." });
    if (new Set(c.tools.map((t) => t.toolId)).size !== c.tools.length)
      ctx.addIssue({ code: "custom", message: "Duplicate tool identity." });
  });
export const HarnessAssetRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: id,
    projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    toolId: id,
    kind: z.enum(["image", "video", "audio"]),
    operation: z.enum(["generate", "edit"]),
    purpose: text,
    prompt: text,
    requestedModel: z.string().min(1).max(256).optional(),
    modelPolicy: z.enum(["allow-tool-default", "require-selectable-model"]).default("allow-tool-default"),
    width: z.number().int().positive().max(16384).optional(),
    height: z.number().int().positive().max(16384).optional(),
    transparency: z.enum(["required", "optional"]).default("optional"),
    acceptanceCriteria: z.array(text).min(1).max(30),
    references: z
      .array(z.object({ assetId: z.string().regex(/^sha256:[a-f0-9]{64}$/), sha256: hash }).strict())
      .max(30)
      .default([]),
    entities: z
      .array(
        z
          .object({ kind: EntityKindSchema, entityId: id, revision: z.number().int().positive(), contentHash: hash })
          .strict(),
      )
      .max(30)
      .default([]),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.modelPolicy === "require-selectable-model" && !r.requestedModel)
      ctx.addIssue({ code: "custom", message: "Exact model selection requires requestedModel." });
    if (r.kind === "audio" && (r.width || r.height || r.transparency === "required"))
      ctx.addIssue({ code: "custom", message: "Audio cannot request visual dimensions/alpha." });
    if (r.operation === "edit" && r.references.length === 0)
      ctx.addIssue({ code: "custom", message: "Edit requires pinned references." });
    if (
      new Set(r.references.map((x) => x.assetId)).size !== r.references.length ||
      new Set(r.entities.map((x) => `${x.kind}/${x.entityId}`)).size !== r.entities.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate reference/entity identity." });
  });
export const HarnessAssetResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: id,
    requestHash: hash,
    runtime: z.enum(["codex", "claude", "other"]),
    toolId: id,
    model: z.string().min(1).max(256).default("unknown"),
    original: HarnessFilePinSchema,
    toolResultEvidence: HarnessFilePinSchema,
    rights: AssetRightsSchema,
    billing: AssetProvenanceSchema.shape.billing,
  })
  .strict();
export type HarnessCapabilities = z.infer<typeof HarnessCapabilitiesSchema>;
export type HarnessAssetRequest = z.infer<typeof HarnessAssetRequestSchema>;
export type HarnessAssetResult = z.infer<typeof HarnessAssetResultSchema>;
export const HarnessOperationSchema = z
  .object({
    schemaVersion: z.literal(1),
    request: HarnessAssetRequestSchema,
    requestHash: hash,
    projectSha256: hash,
    capabilities: HarnessCapabilitiesSchema,
    capabilitiesHash: hash,
    createdAt: z.string().datetime(),
    status: z.enum(["awaiting-import", "importing", "complete"]),
    result: HarnessAssetResultSchema.optional(),
    resultHash: hash.optional(),
    receipt: z
      .object({
        assetId: z.string(),
        original: z.string(),
        duplicate: z.boolean(),
        provenance: AssetProvenanceSchema,
        rights: AssetRightsSchema,
        registryMetadataPreserved: z.boolean(),
        creativeApproval: z.literal("required"),
        importedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.status === "awaiting-import") !== !v.result ||
      !!v.result !== !!v.resultHash ||
      (v.status === "complete") !== !!v.receipt
    )
      ctx.addIssue({ code: "custom", message: "Invalid operation state/result/receipt." });
  });
export type HarnessOperation = z.infer<typeof HarnessOperationSchema>;
