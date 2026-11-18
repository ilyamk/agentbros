import { z } from "zod";

export const MediaProviderSchema = z.enum(["auto", "rapidapi", "apify-easyapi", "apify-wilcode"]);
export const MediaFetchOptionsSchema = z
  .object({
    urls: z.array(z.string().url().max(8192)).min(1).max(100),
    project: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
      .optional(),
    outputDir: z.string().min(1).optional(),
    provider: MediaProviderSchema.default("auto"),
    kind: z.enum(["auto", "video", "audio", "image", "all"]).default("auto"),
    preset: z.enum(["original", "edit"]).default("original"),
    height: z.number().int().min(144).max(4320).optional(),
    audioFormat: z.enum(["original", "mp3", "wav"]).default("original"),
    includeAssociatedAudio: z.boolean().default(false),
    concurrency: z.number().int().min(1).max(16).default(4),
    maxFileMb: z.number().positive().max(16384).default(2048),
    maxTotalMb: z.number().positive().max(1048576).default(10240),
    timeoutSec: z.number().int().min(1).max(3600).default(600),
    maxCostUsd: z.number().positive().optional(),
    maxTotalCostUsd: z.number().positive().optional(),
  })
  .strict()
  .refine((x) => x.project || x.outputDir, "Provide project or outputDir.");
export type MediaFetchOptions = z.output<typeof MediaFetchOptionsSchema>;
export type MediaProvider = Exclude<z.infer<typeof MediaProviderSchema>, "auto">;
export type MediaKind = "video" | "audio" | "image";
export interface MediaVariant {
  url: string;
  kind: MediaKind;
  group: string;
  extension?: string;
  height?: number;
  quality?: string;
  associated?: boolean;
  preview?: boolean;
}
export const MediaFileSchema = z
  .object({
    sourceKey: z.string().optional(),
    path: z.string(),
    hash: z.string(),
    bytes: z.number(),
    kind: z.enum(["video", "audio", "image"]),
    assetId: z.string().optional(),
    derivedFrom: z.string().optional(),
    preview: z.boolean().optional(),
    media: z.record(z.string(), z.unknown()),
  })
  .strict();
export const MediaIssueSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    action: z.string(),
    retryAfterMs: z.number().optional(),
  })
  .strict();
export const MediaFetchItemSchema = z
  .object({
    url: z.string(),
    resolvedUrl: z.string().optional(),
    platform: z.string().optional(),
    state: z
      .enum(["pending", "resolving", "submitting", "running", "downloading", "completed", "failed", "unknown"])
      .default("pending"),
    provider: z.enum(["rapidapi", "apify-easyapi", "apify-wilcode"]).optional(),
    operationId: z.string().optional(),
    runId: z.string().optional(),
    candidates: z.array(z.enum(["rapidapi", "apify-easyapi", "apify-wilcode"])).default([]),
    attempt: z.number().default(0),
    files: z.array(MediaFileSchema).default([]),
    issue: MediaIssueSchema.optional(),
    duplicateOf: z.number().optional(),
  })
  .strict();
export const MediaFetchJobSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    options: MediaFetchOptionsSchema,
    state: z.enum(["pending", "running", "completed", "partial", "failed"]),
    pid: z.number().optional(),
    heartbeat: z.string().optional(),
    directory: z.string(),
    items: z.array(MediaFetchItemSchema),
    committedUsd: z.number().default(0),
    downloadedBytes: z.number().default(0),
  })
  .strict();
export type MediaFetchJob = z.output<typeof MediaFetchJobSchema>;
export type MediaFetchItem = z.output<typeof MediaFetchItemSchema>;
export type MediaIssue = z.output<typeof MediaIssueSchema>;
