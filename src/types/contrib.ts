import { z } from "zod";

const text = z.string().trim().min(1);
export const CategoryIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const SizeSchema = z.enum(["S", "M", "L"]);
export const HarnessSchema = z.enum(["claude-code", "codex", "other"]);
export const ChangePathSchema = z.string().regex(/^\.changes\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
export const CategorySchema = z
  .object({
    id: CategoryIdSchema,
    title: text,
    paths: z.array(text).min(1),
    gates: z.array(text),
    plannedGates: z.array(text).optional(),
    evidence: z.array(text),
    ownerReview: z.boolean(),
    defaultSize: SizeSchema,
    notWanted: z.array(text),
  })
  .strict();
export const CategoriesFileSchema = z
  .object({
    version: z.literal(1),
    categories: z.array(CategorySchema).min(1),
  })
  .strict()
  .refine(
    ({ categories }) => new Set(categories.map(({ id }) => id)).size === categories.length,
    "Duplicate category id",
  );
export const PrBlockSchema = z
  .object({
    category: CategoryIdSchema,
    size: SizeSchema,
    issue: z.number().int().positive().optional(),
    autonomy: z.enum(["autonomous", "assisted", "human"]),
    harness: HarnessSchema,
    model: text,
    owner: z.string().regex(/^@?[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/),
    change: ChangePathSchema,
  })
  .strict()
  .refine(({ size, issue }) => size === "S" || issue !== undefined, "Sizes M and L require an issue");
export const ChangeEntrySchema = z
  .object({
    category: CategoryIdSchema,
    bump: z.enum(["patch", "minor", "major"]),
    breaking: z.boolean(),
    pr: z.number().int().nonnegative(),
    authors: z.array(text).min(1),
    harness: HarnessSchema.optional(),
    deps: text.optional(),
    novelty: text.optional(),
    body: text,
  })
  .strict();
export const NoveltyConfigSchema = z
  .object({
    version: z.literal(1),
    text: z.object({ block: z.number().min(0).max(1), playbook: z.number().min(0).max(1) }).strict(),
    image: z.object({ maxHammingDistance: z.number().int().min(0).max(64) }).strict(),
  })
  .strict();
export const ProtectedPathsSchema = z.object({ version: z.literal(1), paths: z.array(text).min(1) }).strict();
export const TrustTierSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
export type TrustTier = z.infer<typeof TrustTierSchema>;
export type Category = z.infer<typeof CategorySchema>;
export type CategoriesFile = z.infer<typeof CategoriesFileSchema>;
export type PrBlock = z.infer<typeof PrBlockSchema>;
export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;
export type Size = z.infer<typeof SizeSchema>;

export const TIER_LIMITS: Record<
  TrustTier,
  {
    openPrs: number | null;
    sizes: readonly Size[];
    forbiddenCategories: readonly string[];
    largeNeedsApproval: boolean;
  }
> = {
  0: {
    openPrs: 2,
    sizes: ["S", "M"],
    forbiddenCategories: ["instructions", "harness", "test-ci"],
    largeNeedsApproval: false,
  },
  1: { openPrs: 5, sizes: ["S", "M", "L"], forbiddenCategories: [], largeNeedsApproval: true },
  2: { openPrs: 10, sizes: ["S", "M", "L"], forbiddenCategories: [], largeNeedsApproval: false },
  3: { openPrs: null, sizes: ["S", "M", "L"], forbiddenCategories: [], largeNeedsApproval: false },
};

export const ReleaseRouteSchema = z
  .object({
    version: z.literal(1),
    botLogins: z.array(z.string().min(1)).min(1),
    headBranch: z.string().min(1),
    modelsRefreshHeadBranch: z.literal("bot/models-refresh").optional(),
  })
  .strict();

/** contrib/agent-coauthors.json: agent identities whose `Co-authored-by` trailers count as the submitting human's Contribution (CLA, "Contributions made with automated agents"). */
export const AgentCoauthorSchema = z
  .object({
    tool: text,
    emails: z.array(z.string().regex(/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/, "lower-case email")),
    githubLogins: z.array(z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/)).optional(),
    reason: text,
  })
  .strict()
  .refine(
    ({ emails, githubLogins }) => emails.length + (githubLogins?.length ?? 0) > 0,
    "An agent needs an email or a GitHub login",
  );
export const AgentCoauthorsFileSchema = z
  .object({
    version: z.literal(1),
    agents: z.array(AgentCoauthorSchema).min(1),
  })
  .strict();
export type AgentCoauthorsFile = z.infer<typeof AgentCoauthorsFileSchema>;
