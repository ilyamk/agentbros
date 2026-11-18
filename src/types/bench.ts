import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const BenchPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
    "Expected a relative contained path",
  );
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const number = z.number().finite().nonnegative();
export const BenchSuiteSchema = z
  .object({
    version: z.number().int().positive(),
    protocolVersion: z.literal(1),
    split: z.enum(["public", "hidden"]),
    tasks: z.array(z.object({ id: slug, path: BenchPathSchema, sha256: hash }).strict()).min(1),
  })
  .strict()
  .refine((suite) => new Set(suite.tasks.map((task) => task.id)).size === suite.tasks.length, "Duplicate task");
export const BenchCriterionSchema = z
  .object({
    id: slug,
    kind: z.enum(["process", "technical"]),
    check: z.discriminatedUnion("type", [
      z.object({ type: z.literal("file"), path: BenchPathSchema, contains: z.string().optional() }).strict(),
      z.object({ type: z.literal("delivery") }).strict(),
      z.object({ type: z.literal("constraints") }).strict(),
      z.object({ type: z.literal("file-sensors") }).strict(),
      z.object({ type: z.literal("no-spend") }).strict(),
      z.object({ type: z.literal("script"), path: BenchPathSchema }).strict(),
    ]),
  })
  .strict();
export const BenchTaskSchema = z
  .object({
    version: z.literal(1),
    id: slug,
    playbook: slug,
    tier: z.enum(["no-spend", "paid"]),
    maxCostUsd: number.optional(),
    brief: z.string().min(1),
    material: z.array(
      z
        .object({
          path: BenchPathSchema.optional(),
          url: z.url().optional(),
          sha256: hash,
          licence: z.string().min(1),
        })
        .strict()
        .refine((item) => Boolean(item.path) !== Boolean(item.url), "Supply exactly one of path or url"),
    ),
    constraints: z
      .object({
        format: z.enum(["vertical", "square", "landscape"]),
        durationSec: z.tuple([number, number]).refine(([min, max]) => min <= max),
      })
      .strict(),
    answers: BenchPathSchema,
    criteria: z.array(BenchCriterionSchema),
  })
  .strict()
  .refine(
    (task) => task.tier !== "paid" || (task.maxCostUsd !== undefined && task.maxCostUsd > 0),
    "Paid tasks require positive maxCostUsd",
  );
export type BenchTask = z.infer<typeof BenchTaskSchema>;
export const BenchConfigSchema = z
  .object({
    version: z.literal(1),
    minRuns: z.number().int().min(3),
    limits: z
      .object({
        wallTimeSec: number.positive(),
        tokens: count.positive(),
        maxFileBytes: count.positive(),
        maxBundleBytes: count.positive(),
        maxTranscriptBytes: count.positive(),
      })
      .strict(),
    judging: z
      .object({
        monthlyCapUsd: number.nullable(),
        campaignCapUsd: number.positive(),
        models: z.array(z.object({ vendor: z.enum(["anthropic", "openai"]), model: z.string().min(1) }).strict()),
        calibration: z
          .object({
            originalWinRate: z.number().min(0).max(1).nullable(),
            humanAgreement: z.number().min(0).max(1).nullable(),
            minSamples: count.positive(),
          })
          .strict(),
      })
      .strict(),
    noise: z.object({ floor: number.nullable(), bootstrapSamples: count.positive(), seed: z.number().int() }).strict(),
  })
  .strict();
export type BenchConfig = z.infer<typeof BenchConfigSchema>;
export const BenchTokensSchema = z.object({ input: count, output: count }).strict();
export const BenchClaimsSchema = z
  .object({
    tokens: BenchTokensSchema.nullable(),
    toolCalls: count,
    spendUsd: number.nullable(),
    transcriptState: z.enum(["complete", "truncated", "invalid"]),
    delivery: z.enum(["passed", "failed", "unavailable"]),
    criteria: z.array(z.object({ id: slug, passed: z.boolean() }).strict()),
    technical: z.record(z.string(), z.number().finite()),
  })
  .strict();
export const BenchBundleSchema = z
  .object({
    version: z.literal(1),
    protocolVersion: z.literal(1),
    suiteVersion: z.number().int().positive(),
    taskSha256: hash,
    visibility: z.enum(["private", "public"]).optional(),
    publication: z
      .object({ policyVersion: z.literal(1), sourceManifestSha256: hash })
      .strict()
      .optional(),
    cell: z
      .object({
        task: slug,
        harness: z.enum(["claude-code", "codex"]),
        model: z.string().min(1),
        harnessCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
        run: count.positive(),
      })
      .strict(),
    files: z.array(z.object({ path: BenchPathSchema, sha256: hash, bytes: count }).strict()),
    omitted: z.array(z.object({ path: BenchPathSchema, sha256: hash, bytes: count }).strict()),
    env: z.object({ os: z.string(), arch: z.string(), node: z.string(), harnessVersion: z.string() }).strict(),
    tokens: BenchTokensSchema.nullable(),
    toolCalls: count,
    wallTimeSec: number,
    spendUsd: number.nullable(),
    transcript: BenchPathSchema.nullable(),
    status: z.enum(["completed", "failed", "timeout", "token-limit", "output-limit"]),
    exitCode: z.number().int().nullable(),
    claims: BenchClaimsSchema,
  })
  .strict()
  .refine(
    (bundle) =>
      new Set(bundle.files.map((file) => file.path)).size === bundle.files.length &&
      bundle.files.every((file) => !["manifest.json", "manifest.json.sig"].includes(file.path)),
    "Duplicate or reserved bundle path",
  )
  .refine(
    (bundle) =>
      bundle.publication ? bundle.visibility === "public" && bundle.transcript === null : bundle.transcript !== null,
    "Only public exports omit the transcript",
  );
export type BenchBundle = z.infer<typeof BenchBundleSchema>;
const picture = z
  .object({
    key: z.string().regex(/^[a-f0-9]{16}$/),
    stills: z
      .array(z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/))
      .min(1)
      .max(8),
    technical: z.partialRecord(
      z.enum(["durationSec", "fps", "width", "height", "integratedLufs", "truePeakDb"]),
      z.number().finite(),
    ),
  })
  .strict();
export const BenchPacketSchema = z
  .object({
    version: z.literal(1),
    protocolVersion: z.literal(1),
    task: slug,
    id: slug,
    modality: z.literal("picture"),
    left: picture,
    right: picture,
  })
  .strict()
  .refine((packet) => packet.left.key !== packet.right.key);
export type BenchPacket = z.infer<typeof BenchPacketSchema>;
export const BenchJudgementSchema = z
  .object({
    version: z.literal(1),
    protocolVersion: z.literal(1),
    task: slug,
    packetId: slug,
    judge: z.string().min(1),
    winner: z.enum(["left", "right", "tie"]),
    modality: z.literal("picture"),
  })
  .strict();
export type BenchJudgement = z.infer<typeof BenchJudgementSchema>;
export const BenchCalibrationSchema = z
  .object({
    version: z.literal(1),
    protocolVersion: z.literal(1),
    suiteVersion: z.number().int().positive(),
    judge: z.string().min(1),
    promptSha256: hash,
    originals: z.array(
      z
        .object({
          originalSha256: hash,
          degradedSha256: hash,
          source: z.literal("ref:degrade"),
          winner: z.enum(["original", "degraded", "tie"]),
        })
        .strict(),
    ),
    human: z.array(
      z
        .object({
          packetSha256: hash,
          human: z.enum(["left", "right", "tie"]),
          judge: z.enum(["left", "right", "tie"]),
        })
        .strict(),
    ),
  })
  .strict();
export const BenchRatingResultsSchema = z
  .object({
    version: z.literal(1),
    protocolVersion: z.literal(1),
    task: slug,
    noiseFloor: number,
    bootstrapSamples: count.positive(),
    seed: z.number().int(),
    ratings: z.array(
      z
        .object({
          id: z.string(),
          rating: z.number().finite(),
          interval95: z.tuple([z.number().finite(), z.number().finite()]),
          qualityPerUsd: z.number().finite().nullable(),
          qualityPerMinute: z.number().finite().nullable(),
        })
        .strict(),
    ),
    deltas: z.array(
      z
        .object({
          a: z.string(),
          b: z.string(),
          delta: z.number().finite(),
          interval95: z.tuple([z.number().finite(), z.number().finite()]),
          interpretation: z.enum(["no detectable change", "detectable change"]),
        })
        .strict(),
    ),
  })
  .strict();

export const BenchVerificationResultSchema = z
  .object({
    verified: z.literal(true),
    label: z.enum(["community", "community-export"]),
    signer: z.string().min(1).max(100),
    manifest: BenchBundleSchema,
    recomputed: BenchClaimsSchema.nullable(),
    limitations: z.array(z.string().max(2000)).max(20),
  })
  .strict();
export const BenchSubmissionReportSchema = z
  .object({
    version: z.literal(1),
    issue: z.number().int().positive(),
    author: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
    cells: z.string().min(1).max(10000),
    result: z.discriminatedUnion("verified", [
      z.object({ verified: z.literal(true), verification: BenchVerificationResultSchema }).strict(),
      z.object({ verified: z.literal(false), message: z.string().min(1).max(2000) }).strict(),
    ]),
  })
  .strict();
