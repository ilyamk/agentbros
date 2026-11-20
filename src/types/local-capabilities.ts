import { z } from "zod";

export const AppleDomainSchema = z.enum(["speech", "text", "translation", "tts", "audio", "vision", "foundation"]);
export type AppleDomain = z.infer<typeof AppleDomainSchema>;
export const LocalTaskSchema = z.enum([
  "speech.transcribe",
  "text.analyse",
  "text.translate",
  "speech.synthesise",
  "audio.events",
  "vision.faces",
  "vision.people",
  "vision.pose",
  "vision.saliency",
  "vision.quality",
  "vision.flow",
  "vision.tracking",
  "text.assist",
  "image.describe",
  "vision.ocr",
  "vision.similarity",
  "vision.classify",
  "vision.matte",
]);
export type LocalTask = z.infer<typeof LocalTaskSchema>;
export const AvailabilitySchema = z.enum([
  "ready",
  "needs_prepare",
  "needs_download",
  "needs_user_action",
  "unsupported",
  "temporarily_unavailable",
  "unknown",
]);
export type Availability = z.infer<typeof AvailabilitySchema>;
export const LocalPolicySchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["interactive", "autonomous"]).default("interactive"),
    downloads: z.enum(["task", "ask", "never"]).default("task"),
  })
  .strict();
export type LocalPolicy = z.infer<typeof LocalPolicySchema>;
export const LocalTaskRequestSchema = z
  .object({
    task: LocalTaskSchema,
    language: z.string().min(2).max(35).optional(),
    targetLanguage: z.string().min(2).max(35).optional(),
    voice: z.string().min(1).max(500).optional(),
    purpose: z.enum(["draft", "production"]).default("draft"),
    assistTask: z.enum(["summarise", "tags", "chapters", "shot-notes"]).optional(),
    operations: z.array(z.enum(["language", "sentences", "tokens", "entities", "lemmas"])).optional(),
    requirements: z
      .object({
        wordTiming: z.boolean().optional(),
        verbatim: z.boolean().optional(),
        speakers: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LocalTaskRequest = z.input<typeof LocalTaskRequestSchema>;
export const NativeIssueSchema = z
  .object({
    state: AvailabilitySchema.exclude(["ready"]),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(2000),
    userAction: z.string().max(2000).optional(),
  })
  .strict();
export type NativeIssue = z.infer<typeof NativeIssueSchema>;
export const NativeProbeSchema = z
  .object({
    operations: z.array(z.string().min(1).max(100)).max(100),
    languages: z.array(z.string().min(2).max(100)).max(300),
    installedLanguages: z.array(z.string().min(2).max(100)).max(300),
    voices: z
      .array(
        z
          .object({ id: z.string().min(1).max(500), name: z.string().max(200), language: z.string().min(2).max(100) })
          .strict(),
      )
      .max(1000)
      .optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type NativeProbe = z.infer<typeof NativeProbeSchema>;
export const LocalCapabilitySchema = z
  .object({
    task: LocalTaskSchema,
    backend: z.string().min(1),
    state: AvailabilitySchema,
    reason: z.string(),
    checkedAt: z.string().datetime(),
    identity: z.string().optional(),
    languages: z.array(z.string()).optional(),
    quality: z.enum(["unverified", "smoke", "qualified"]),
    command: z.array(z.string()).optional(),
    prepare: z.array(z.string()).optional(),
    userAction: z.string().optional(),
  })
  .strict();
export type LocalCapability = z.infer<typeof LocalCapabilitySchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const LocalResultReceiptSchema = z
  .object({
    version: z.literal(1),
    task: LocalTaskSchema,
    backend: z.string().min(1),
    operationId: hash,
    createdAt: z.string().datetime(),
    identity: hash,
    systemModelsHashPinned: z.literal(false),
    modelPins: z.array(z.object({ name: z.string().min(1), sha256: hash }).strict()).optional(),
    requestHash: hash,
    inputs: z.array(z.object({ file: z.string(), sha256: hash }).strict()),
    outputs: z.array(z.object({ file: z.string(), sha256: hash }).strict()),
    purpose: z.enum(["draft", "production"]),
    checks: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();
export type LocalResultReceipt = z.infer<typeof LocalResultReceiptSchema>;
export const LocalQualificationSchema = z
  .object({
    version: z.literal(1),
    task: LocalTaskSchema,
    language: z.string(),
    identity: hash,
    checkedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    suite: z.enum(["smoke", "quality"]),
    passed: z.boolean(),
    metrics: z.record(z.string(), z.number().finite()),
    evidenceHash: hash,
    evidenceFile: z
      .string()
      .min(1)
      .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..")),
  })
  .strict();
export const LocalTextUnitSchema = z
  .object({
    id: z
      .string()
      .regex(/^[\w-]+$/)
      .max(128),
    text: z.string().max(200000),
    startMs: z.number().finite().nonnegative().optional(),
    endMs: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .refine((v) => v.endMs === undefined || (v.startMs !== undefined && v.endMs >= v.startMs));
export const LocalTextRequestSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["text", "scenes", "captions"]).default("text"),
    sourceLanguage: z.string().min(2).max(35),
    targetLanguage: z.string().min(2).max(35).optional(),
    units: z.array(LocalTextUnitSchema).min(1).max(1000),
    protectedTerms: z.array(z.string().min(1).max(200)).max(100).default([]),
  })
  .strict()
  .refine((v) => new Set(v.units.map((u) => u.id)).size === v.units.length, "Unit IDs must be unique");
export const AppleWordsSchema = z
  .object({
    language: z.string(),
    timing: z.enum(["native", "estimated"]),
    verbatim: z.literal(false),
    words: z
      .array(
        z
          .object({
            text: z.string().min(1).max(10000),
            startSec: z.number().finite().nonnegative(),
            endSec: z.number().finite().nonnegative(),
            confidence: z.number().finite().min(0).max(1).nullable(),
          })
          .strict()
          .refine((w) => w.endSec >= w.startSec),
      )
      .max(200000),
  })
  .strict();
