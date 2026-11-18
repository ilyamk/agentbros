import { z } from "zod";
import { CategoryIdSchema, SizeSchema, TrustTierSchema } from "./contrib";

/** Task contract v1 (RFC 0002 §3.4): what a contributor needs; contributor tasks never require spend. */
export const TASK_OS = ["macos", "linux"] as const;
export const TASK_TOOLS = ["ffmpeg", "blender", "python", "swift"] as const;
export const TASK_HARNESSES = ["claude-code", "codex"] as const;
export const TaskRequiresSchema = z
  .object({
    os: z.array(z.enum(TASK_OS)).min(1).optional(),
    gpu: z.boolean().optional(),
    tools: z.array(z.enum(TASK_TOOLS)).min(1).optional(),
    harnessSession: z.array(z.enum(TASK_HARNESSES)).min(1).optional(),
    signingKey: z.boolean().optional(),
    designApproval: z.boolean().optional(),
    paid: z.literal(false).default(false),
  })
  .strict();
export type TaskRequires = z.infer<typeof TaskRequiresSchema>;
export const TaskValueSchema = z
  .object({ metric: z.string().trim().min(1).optional(), rationale: z.string().trim().min(1) })
  .strict();
export const TaskPrioritySchema = z.number().int().min(0).max(3);
/** `curated`, `issue` or `scout:<scanner>`. */
export const TaskSourceSchema = z.string().regex(/^(?:curated|issue|scout:[a-z][a-z-]*)$/);
export const OpportunitySchema = z
  .object({
    id: z.string().min(1),
    category: CategoryIdSchema,
    size: SizeSchema,
    title: z.string().min(1),
    why: z.string().min(1),
    evidence: z.array(z.string()).min(1),
    definitionOfDone: z.array(z.string()).min(1),
    covering: z.array(z.string()),
    source: TaskSourceSchema,
    priority: TaskPrioritySchema,
    value: TaskValueSchema.optional(),
    requires: TaskRequiresSchema,
    read: z.array(z.string().min(1)),
    verify: z.array(z.string().min(1)),
  })
  .strict();
export type Opportunity = z.infer<typeof OpportunitySchema>;
/** contrib/opportunities.json: maintainer-curated scout rows; `key` derives the stable id. Priority defaults to 2 with `verify`, 1 without; a row without `verify` cannot claim 2 or more. */
export const CuratedOpportunitiesSchema = z
  .object({
    version: z.literal(1),
    opportunities: z.array(
      z
        .object({
          key: z.string().regex(/^[a-z0-9][a-z0-9._:/-]*$/),
          category: CategoryIdSchema,
          size: SizeSchema,
          title: z.string().trim().min(1),
          why: z.string().trim().min(1),
          evidence: z.array(z.string().min(1)).min(1),
          definitionOfDone: z.array(z.string().min(1)).min(1),
          priority: TaskPrioritySchema.optional(),
          value: TaskValueSchema.optional(),
          requires: TaskRequiresSchema.optional(),
          read: z.array(z.string().min(1)).optional(),
          verify: z.array(z.string().trim().min(1)).optional(),
        })
        .strict()
        .refine((row) => row.priority === undefined || row.priority < 2 || Boolean(row.verify?.length), {
          message: "A task without verify commands cannot have priority 2 or more",
          path: ["priority"],
        }),
    ),
  })
  .strict()
  .refine(
    ({ opportunities }) => new Set(opportunities.map((row) => row.key)).size === opportunities.length,
    "Duplicate curated opportunity key",
  );
export type CuratedOpportunities = z.infer<typeof CuratedOpportunitiesSchema>;
export const GateEvidenceSchema = z
  .object({
    name: z.string(),
    command: z.array(z.string()),
    exitCode: z.number().int(),
    durationMs: z.number().nonnegative(),
    summary: z.string(),
  })
  .strict();
export const ContributionEvidenceSchema = z
  .object({
    version: z.literal(1),
    base: z.string(),
    head: z.string(),
    categories: z.array(z.string()),
    gates: z.array(GateEvidenceSchema),
    notVerified: z.array(z.string()),
    dirtyPaths: z.array(z.string()).optional(),
  })
  .strict();
export type GateEvidence = z.infer<typeof GateEvidenceSchema>;
export type ContributionEvidence = z.infer<typeof ContributionEvidenceSchema>;
export const TrustOverridesSchema = z
  .object({
    version: z.literal(1),
    overrides: z.array(
      z
        .object({
          handle: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/),
          tier: TrustTierSchema,
          reason: z.string().trim().min(1),
          until: z.string().datetime({ offset: true }).optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .refine(
    ({ overrides }) => new Set(overrides.map((row) => row.handle.toLowerCase())).size === overrides.length,
    "Duplicate trust handle",
  );
