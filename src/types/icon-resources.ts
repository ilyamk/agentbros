import { z } from "zod";

export const IconProviderSchema = z.enum(["phosphor", "lucide", "tabler", "simple-icons", "iconify", "svgl"]);
export type IconProvider = z.infer<typeof IconProviderSchema>;
export const IconRightsSchema = z
  .object({
    licence: z.string(),
    licenceUrl: z.string(),
    notice: z.string(),
    attribution: z.string(),
    commercialAllowed: z.union([z.boolean(), z.literal("unknown")]),
    brand: z.boolean(),
    guidelines: z.string().optional(),
  })
  .strict();
export const IconCandidateSchema = z
  .object({
    id: z.string().max(300),
    provider: IconProviderSchema,
    collection: z.string(),
    name: z.string(),
    title: z.string(),
    kind: z.enum(["icon", "brand"]),
    tags: z.array(z.string()).max(1000),
    variants: z.array(z.string()).min(1),
    version: z.string(),
    brandColour: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    source: z.string(),
    rights: IconRightsSchema,
    routes: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type IconCandidate = z.infer<typeof IconCandidateSchema>;
export const IconProfileSchema = z
  .object({
    version: z.literal(1).default(1),
    revision: z.number().int().nonnegative().default(0),
    provider: z.enum(["phosphor", "lucide", "tabler"]).default("phosphor"),
    variant: z.string().default("regular"),
    colour: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#111111"),
    size: z.number().int().min(16).max(4096).default(1024),
    padding: z.number().int().min(0).max(1024).default(0),
    background: z.union([z.literal("transparent"), z.string().regex(/^#[0-9a-f]{6}$/i)]).default("transparent"),
    strokeWidth: z.number().min(0.5).max(8).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    const variants =
      v.provider === "phosphor"
        ? ["thin", "light", "regular", "bold", "fill", "duotone"]
        : v.provider === "lucide"
          ? ["outline"]
          : ["outline", "filled"];
    if (v.provider === "phosphor" && v.strokeWidth !== undefined)
      c.addIssue({ code: "custom", message: "Phosphor uses filled paths; stroke width is not supported" });
    if (!variants.includes(v.variant))
      c.addIssue({ code: "custom", message: `${v.provider} supports ${variants.join(", ")}` });
    if (v.padding * 2 >= v.size) c.addIssue({ code: "custom", message: "Padding must leave a positive image area" });
  });
export type IconProfile = z.infer<typeof IconProfileSchema>;
export const IconExportOptionsSchema = z
  .object({
    format: z.enum(["svg", "png", "webp"]).default("png"),
    size: z.number().int().min(16).max(4096).default(1024),
    padding: z.number().int().min(0).max(1024).default(0),
    colour: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    background: z.union([z.literal("transparent"), z.string().regex(/^#[0-9a-f]{6}$/i)]).default("transparent"),
    strokeWidth: z.number().min(0.5).max(8).optional(),
    allowStyleOverride: z.boolean().default(false),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.padding * 2 >= v.size) c.addIssue({ code: "custom", message: "Padding must leave a positive image area" });
    if (v.allowStyleOverride && !v.reason) c.addIssue({ code: "custom", message: "Style override requires a reason" });
  });
export type IconExportOptions = z.infer<typeof IconExportOptionsSchema>;
export const IconAcquisitionSchema = z
  .object({
    id: z.string(),
    candidate: IconCandidateSchema,
    variant: z.string(),
    resourceId: z.string(),
    original: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    checkedAt: z.string().datetime(),
    metadataFile: z.string(),
  })
  .strict();
export const IconDerivativeSchema = z
  .object({
    id: z.string(),
    acquisitionId: z.string(),
    resourceId: z.string(),
    sourceHash: z.string(),
    file: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    options: IconExportOptionsSchema,
    exporter: z.string(),
    assetId: z.string().optional(),
    profile: IconProfileSchema.optional(),
  })
  .strict();
export const IconManifestSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    acquisitions: z.array(IconAcquisitionSchema),
    derivatives: z.array(IconDerivativeSchema),
  })
  .strict();
export type IconAcquisition = z.infer<typeof IconAcquisitionSchema>;
export type IconDerivative = z.infer<typeof IconDerivativeSchema>;
export const IconUsageSchema = z
  .object({ resourceId: z.string(), derivativeId: z.string(), src: z.string(), placementId: z.string().min(1) })
  .strict();

export const IconSourceStatusSchema = z
  .object({
    provider: IconProviderSchema,
    status: z.enum(["ok", "offline", "error"]),
    message: z.string().optional(),
    code: z.string().optional(),
  })
  .strict();
export const IconSearchResultSchema = z
  .object({
    results: z.array(IconCandidateSchema.extend({ score: z.number(), matchReasons: z.array(z.string()) })),
    queries: z.array(z.string()),
    synonymsVersion: z.literal(1),
    statuses: z.array(IconSourceStatusSchema),
    partial: z.boolean(),
    next: z.string(),
  })
  .strict();
