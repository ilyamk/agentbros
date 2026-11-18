import { LocalResultReceiptSchema } from "./local-capabilities";
import { VorkResultSchema } from "./vork";
import { z } from "zod";
import { ModelPreparationBindingSchema } from "./model-preparation-binding";
import { ReferencePackIdSchema } from "./reference-pack-binding";

export const AssetRightsSchema = z
  .object({
    licence: z.string().default("unknown"),
    commercialAllowed: z.union([z.boolean(), z.literal("unknown")]).default("unknown"),
    attributionRequired: z.union([z.boolean(), z.literal("unknown")]).default("unknown"),
    attribution: z.string().optional(),
    sourceUrl: z.string().url().optional(),
    checkedAsOf: z.string().datetime().optional(),
  })
  .strict();

export const AssetProvenanceSchema = z
  .object({
    origin: z.enum(["manual", "agent-harness", "provider", "stock", "derivative"]),
    originalFilename: z.string().optional(),
    tool: z.string().default("unknown"),
    model: z.string().default("unknown"),
    prompt: z.string().optional(),
    referenceAssetIds: z.array(z.string()).default([]),
    generationJobId: z.string().optional(),
    modelPreparation: ModelPreparationBindingSchema.optional(),
    /** origin "derivative" only: the refs:derive output's spec and receipt (RFC 0003 §6.4). */
    derivative: z
      .object({
        id: ReferencePackIdSchema,
        specSha256: z.string().regex(/^[a-f0-9]{64}$/),
        receipt: z.string().regex(/^pipeline\/reference-derivatives\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\/receipt\.json$/),
      })
      .strict()
      .optional(),
    billing: z
      .object({
        status: z.enum(["unknown", "reported"]),
        apiUsd: z.number().nonnegative().optional(),
        source: z.string().optional(),
      })
      .strict()
      .default({ status: "unknown" }),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.origin === "derivative") !== (value.derivative !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["derivative"],
        message: "A derivative asset, and only one, links its refs:derive spec and receipt.",
      });
    if (value.billing.status === "unknown" && value.billing.apiUsd !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["billing", "apiUsd"],
        message: "Unknown billing cannot have an invented API price.",
      });
    if (value.billing.status === "reported" && (value.billing.apiUsd === undefined || !value.billing.source))
      ctx.addIssue({
        code: "custom",
        path: ["billing"],
        message: "Reported billing requires API USD and evidence source.",
      });
  });

export const AssetRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.literal(1),
    createdAt: z.string().datetime(),
    /** model3d (GLB/glTF), text and json are inspected without ffprobe (assets/inspect.ts). */
    kind: z.enum(["image", "video", "audio", "model3d", "text", "json"]),
    files: z
      .object({
        original: z.string().regex(/^projects\/[A-Za-z0-9][A-Za-z0-9_-]*\/assets\/imported\/[a-f0-9]{64}\.[a-z0-9]+$/),
        bytes: z.number().int().positive(),
        mime: z.string(),
      })
      .strict(),
    media: z
      .object({
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        durationSec: z.number().nonnegative().optional(),
        timebase: z.string().optional(),
        frameRate: z.string().optional(),
        sampleRate: z.number().int().positive().optional(),
        channels: z.number().int().positive().optional(),
        hasAlpha: z.union([z.boolean(), z.literal("unknown")]).default("unknown"),
        codec: z.string(),
        hasAudio: z.boolean(),
        /** model3d only: counts from the glTF JSON. */
        meshCount: z.number().int().nonnegative().optional(),
        nodeCount: z.number().int().nonnegative().optional(),
        materialCount: z.number().int().nonnegative().optional(),
        hasAnimations: z.boolean().optional(),
        /** text and json only. */
        lineCount: z.number().int().positive().optional(),
      })
      .strict(),
    localResult: z
      .object({
        receipt: LocalResultReceiptSchema,
        receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
        sourceOutputHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    vorkResult: VorkResultSchema.optional(),
    provenance: AssetProvenanceSchema,
    rights: AssetRightsSchema,
    entityLinks: z
      .array(
        z
          .object({ entityId: z.string(), revision: z.number().int().positive(), purpose: z.string().optional() })
          .strict(),
      )
      .default([]),
    status: z.literal("candidate"),
  })
  .strict()
  .superRefine((asset, ctx) => {
    if (!asset.files.original.split("/").at(-1)?.startsWith(`${asset.hash}.`))
      ctx.addIssue({
        code: "custom",
        path: ["files", "original"],
        message: "Immutable filename must match asset hash.",
      });
    if ((asset.kind === "image" || asset.kind === "video") && (!asset.media.width || !asset.media.height))
      ctx.addIssue({ code: "custom", path: ["media"], message: "Visual assets require dimensions." });
    if ((asset.kind === "audio" || asset.kind === "video") && !(asset.media.durationSec! > 0))
      ctx.addIssue({
        code: "custom",
        path: ["media", "durationSec"],
        message: "Audio/video assets require positive duration.",
      });
    const structured = asset.kind === "model3d" || asset.kind === "text" || asset.kind === "json";
    if (
      structured &&
      (asset.media.width !== undefined ||
        asset.media.height !== undefined ||
        asset.media.durationSec !== undefined ||
        asset.media.frameRate !== undefined ||
        asset.media.sampleRate !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        path: ["media"],
        message: "Dimensions and duration belong only to image/video/audio assets.",
      });
    if (
      !structured &&
      (asset.media.meshCount !== undefined ||
        asset.media.nodeCount !== undefined ||
        asset.media.materialCount !== undefined ||
        asset.media.hasAnimations !== undefined ||
        asset.media.lineCount !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        path: ["media"],
        message: "Mesh and line counts belong only to model3d/text/json assets.",
      });
    if (asset.kind !== "model3d" && (asset.media.meshCount !== undefined || asset.media.hasAnimations !== undefined))
      ctx.addIssue({ code: "custom", path: ["media"], message: "Mesh counts belong only to model3d assets." });
    if (asset.id !== `sha256:${asset.hash}`)
      ctx.addIssue({ code: "custom", path: ["id"], message: "Asset ID must match hash." });
  });

export const AssetRegistrySchema = z
  .object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), assets: z.array(AssetRecordSchema) })
  .strict()
  .superRefine((registry, ctx) => {
    if (new Set(registry.assets.map((a) => a.id)).size !== registry.assets.length)
      ctx.addIssue({ code: "custom", path: ["assets"], message: "Duplicate immutable asset ID." });
  });
export type AssetRecord = z.infer<typeof AssetRecordSchema>;
export type AssetRegistry = z.infer<typeof AssetRegistrySchema>;
export type AssetProvenanceInput = z.input<typeof AssetProvenanceSchema>;
export type AssetRightsInput = z.input<typeof AssetRightsSchema>;
