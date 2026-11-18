import { z } from "zod";
export const ResourceMetadataSchema = z
  .object({
    source: z.string().min(1),
    licence: z.string().min(1),
    licenceEvidence: z.string().min(1),
    licenceText: z.string().min(1),
    attribution: z.string().min(1),
    checkedAt: z.string().datetime(),
  })
  .strict();
export const FontRecordSchema = ResourceMetadataSchema.extend({
  id: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  original: z.string(),
  kind: z.literal("font"),
  family: z.string(),
  style: z.enum(["normal", "italic"]),
  weight: z.number().int().min(1).max(1000),
  subset: z.string().min(1),
  testedText: z.string(),
  licenceFile: z.string(),
}).strict();
export const IconRecordSchema = ResourceMetadataSchema.extend({
  id: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  original: z.string(),
  kind: z.literal("svg-icon"),
  provider: z.enum(["manual", "lucide", "iconify", "phosphor", "tabler", "simple-icons", "svgl"]),
  collection: z.string(),
  name: z.string(),
  licenceFile: z.string(),
}).strict();
export const ResourceRegistrySchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    records: z.array(z.union([FontRecordSchema, IconRecordSchema])),
  })
  .strict();
export type FontRecord = z.infer<typeof FontRecordSchema>;
export type ResourceMetadata = z.infer<typeof ResourceMetadataSchema>;
