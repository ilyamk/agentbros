import { z } from "zod";
// MCP input validation is privileged automation (contrib/protected.json); keep this file free of arsenal imports.
// Mirrors ASSET_KINDS in src/lib/blender-arsenal/paths.ts (tests/blender-arsenal.test.ts checks they agree).
export const LIVE_ASSET_KINDS = ["models", "materials", "hdri", "textures", "node-groups", "fonts", "decals"] as const;
const Kind = z.enum(LIVE_ASSET_KINDS);

export const LIVE_ACTIONS = [
  "start",
  "status",
  "stop",
  "kits",
  "inspect",
  "journal",
  "reset",
  "add",
  "delete",
  "material",
  "set",
  "run-kit",
  "append-asset",
  "apply-recipe",
  "enable-extension",
  "arsenal",
  "still",
  "strip",
  "save",
  "export",
  "export-recipe",
] as const;
const id = z
  .string()
  .regex(/^[a-z0-9-]+:[A-Za-z0-9_.:-]+$/)
  .max(240);
const name = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\/\\\x00-\x1f]/.test(value) && value !== "..", "A datablock name, never a path");
const vector = z.tuple([
  z.number().finite().min(-1e6).max(1e6),
  z.number().finite().min(-1e6).max(1e6),
  z.number().finite().min(-1e6).max(1e6),
]);
export const ArsenalParamsSchema = z
  .object({
    kind: Kind.optional(),
    filter: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const AppendAssetParamsSchema = z
  .object({
    id,
    kind: Kind.optional(),
    name: name.optional(),
    scale: z.number().positive().max(1e6).optional(),
    location: vector.optional(),
    material_scale: z.number().positive().max(1e6).optional(),
    target: name.optional(),
  })
  .strict();
export const ApplyRecipeParamsSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    params: z.record(z.string(), z.union([z.string().max(200), z.number().finite(), z.boolean()])),
  })
  .strict();
export const EnableExtensionParamsSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
      .max(128),
  })
  .strict();
export const ARSENAL_OP_SCHEMAS: Record<string, z.ZodType> = {
  "append-asset": AppendAssetParamsSchema,
  "apply-recipe": ApplyRecipeParamsSchema,
  "enable-extension": EnableExtensionParamsSchema,
  arsenal: ArsenalParamsSchema,
};
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const LivePinSchema = z
  .object({
    sha256,
    files: z.array(z.object({ path: z.string(), sha256 }).strict()).optional(),
    metadataSha256: sha256.optional(),
    version: z.string().optional(),
  })
  .strict();
export const LiveRecipeSchema = z
  .object({
    version: z.literal(1),
    blenderVersion: z.string(),
    base: z.union([
      z.object({ kind: z.literal("empty") }).strict(),
      z.object({ kind: z.literal("blend"), path: z.string(), sha256 }).strict(),
    ]),
    ops: z.array(
      z
        .object({
          op: z.enum([
            "add",
            "delete",
            "material",
            "set",
            "run-kit",
            "append-asset",
            "apply-recipe",
            "enable-extension",
          ]),
          params: z.record(z.string(), z.unknown()),
          pin: LivePinSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();
