import { z } from "zod";
import { BlendAssetSchema } from "./blender";
import { ASSET_KINDS } from "../paths";

export const Slug = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
export const AssetId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}:[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
export const Kind = z.enum(ASSET_KINDS);
export const Consent = z
  .object({ by: z.string().min(1), date: z.union([z.string().datetime(), z.string().date()]), note: z.string().min(1) })
  .strict();
const Attribution = z.object({ required: z.boolean(), template: z.string() }).strict();
export const SourceSchema = z
  .object({
    id: Slug,
    name: z.string().min(1),
    kinds: z.array(Kind).min(1),
    licence: z.string().min(1),
    licenceUrl: z.string().url(),
    attribution: Attribution,
    redistribution: z.string().min(1),
    adapter: z.enum([
      "polyhaven-api",
      "ambientcg-api",
      "direct-url",
      "bundled",
      "manual",
      "blender-library-server",
      "khronos-git",
      "google-fonts-git",
      "poly-pizza-api",
      "smithsonian-api",
    ]),
    config: z
      .object({
        baseUrl: z.string().url().optional(),
        query: z.record(z.string(), z.string()).optional(),
        steps: z.string().optional(),
        commit: z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .optional(),
        downloadHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).optional(),
      })
      .strict(),
    evaluation: z
      .string()
      .regex(/^docs\/blender-arsenal\/[A-Za-z][A-Za-z0-9_-]*\.md$/)
      .optional(),
    reason: z.string().trim().min(1).optional(),
    consent: Consent.optional(),
    status: z.enum(["proposed", "approved", "rejected"]),
    notes: z.string(),
    verified: z.string().date().nullable(),
  })
  .strict();
export const DependencySchema = z
  .object({
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().safe(),
    format: z.string().regex(/^[a-z0-9]+$/),
    name: z.string().min(1),
    gitBlobSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
    md5: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
  })
  .strict();
export const ItemSchema = z
  .object({
    id: AssetId,
    kind: Kind,
    title: z.string(),
    url: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().safe(),
    licence: z.string().min(1),
    format: z.string().regex(/^[a-z0-9]+$/),
    resolution: z.string(),
    tags: z.array(z.string()),
    dependencies: z.array(DependencySchema).optional(),
    sourcePage: z.string().url().optional(),
    attribution: z.string().optional(),
    licenceUrl: z.string().url().optional(),
    name: z.string().optional(),
    allowedCategory: z.string().optional(),
    allowedAssets: z.array(z.string()).optional(),
    md5: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    gitBlobSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .optional(),
  })
  .strict();
export const ManifestSchema = z
  .object({ version: z.literal(1), sources: z.array(SourceSchema), items: z.array(ItemSchema) })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of ["sources", "items"] as const) {
      const ids = value[key].map((entry) => entry.id);
      if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: `Duplicate ${key} ids` });
    }
    for (const item of value.items)
      if (!value.sources.some((source) => item.id.startsWith(`${source.id}:`) && source.kinds.includes(item.kind)))
        ctx.addIssue({ code: "custom", message: `Unknown source/kind: ${item.id}` });
  });
export const CollectionSchema = z
  .object({
    version: z.literal(1),
    name: Slug,
    status: z.enum(["proposed", "approved", "rejected"]),
    verified: z.boolean(),
    items: z.array(AssetId),
    notes: z.string(),
  })
  .strict();
export const Role = z.enum([
  "color",
  "roughness",
  "normal-gl",
  "normal-dx",
  "displacement",
  "ao",
  "metalness",
  "blend",
  "glb",
  "model",
  "hdri",
  "file",
]);
export const AssetFileSchema = z
  .object({ path: z.string().min(1), role: Role, system: z.literal(true).optional() })
  .strict();
export const AssetSchema = z
  .object({
    version: z.literal(1),
    id: AssetId,
    source: Slug,
    kind: Kind,
    title: z.string(),
    licence: z.string(),
    licenceUrl: z.string().url(),
    attribution: z.string(),
    sourcePage: z.string().url(),
    files: z.array(AssetFileSchema).min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    fetched: z.string().datetime(),
    consent: Consent,
    tags: z.array(z.string()),
    preview: z.string().optional(),
    blenderAssets: z.array(BlendAssetSchema).optional(),
    allowedCategory: z.string().optional(),
    allowedAssets: z.array(z.string()).optional(),
    blenderVersion: z.string().optional(),
  })
  .strict();
export const IndexSchema = z.object({ version: z.literal(1), assets: z.array(AssetSchema) }).strict();
export const UsageSchema = z
  .object({ id: AssetId, script: z.string(), time: z.string().datetime(), project: Slug.nullable() })
  .strict();
export type Source = z.infer<typeof SourceSchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
