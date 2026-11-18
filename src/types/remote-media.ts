import { z } from "zod";
import { AssetRecordSchema } from "./assets";

export const RemoteMediaBindingSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RemoteMediaBinding = z.infer<typeof RemoteMediaBindingSchema>;
export const RemoteMediaUrlSchema = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash;
}, "Use an HTTP(S) media URL without credentials or a fragment.");
export const RemoteMediaReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: RemoteMediaBindingSchema.shape.id,
    projectId: RemoteMediaBindingSchema.shape.id,
    sourceUrl: RemoteMediaUrlSchema,
    mediaUrl: RemoteMediaUrlSchema,
    acquiredAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    assetId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
    kind: z.enum(["image", "video", "audio"]),
    contentType: z.string().min(1),
    media: AssetRecordSchema.shape.media,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.assetId !== `sha256:${value.sha256}`)
      ctx.addIssue({ code: "custom", message: "Remote asset ID must match its bytes." });
    if (value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.acquiredAt))
      ctx.addIssue({ code: "custom", message: "Remote URL has already expired." });
  });
export type RemoteMediaReceipt = z.infer<typeof RemoteMediaReceiptSchema>;
