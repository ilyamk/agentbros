import { z } from "zod";
import { PlaybookIdSchema, PlaybookPlatformSchema } from "./playbook";

/**
 * A user's local memory: what agents learned from this user's projects, comments and results. One file per entry under
 * `memory/<type>/<id>.md` (front matter is this schema, the body is free text), plus the append-only `memory/metrics.jsonl`.
 * The folder is git-ignored except `memory/AGENTS.md`: the content is personal to each checkout. Rules: memory/AGENTS.md.
 */
export const MEMORY_TYPES = ["preference", "decision", "lesson", "observation", "episode", "gap", "proposal"] as const;
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

/** Folder of each type under memory/. */
export const MEMORY_DIRS: Record<MemoryType, string> = {
  preference: "preferences",
  decision: "decisions",
  lesson: "lessons",
  observation: "observations",
  episode: "episodes",
  gap: "gaps",
  proposal: "proposals",
};

/** Types only the user's own words can create: `source.kind` must be `user`, with a verbatim quote. */
export const USER_CONFIRMED_TYPES: readonly MemoryType[] = ["preference", "decision", "lesson"];

/** `<type>-<yyyymmdd>-<slug>`; unique across the store. */
export const MemoryIdSchema = z
  .string()
  .regex(/^(preference|decision|lesson|observation|episode|gap|proposal)-\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(96);

export const MemoryScopeSchema = z
  .object({
    /** Playbooks the entry bears on; empty means any. */
    playbooks: z.array(PlaybookIdSchema).default([]),
    /** Chain or footage steps (film:next / footage:next step ids); empty means any. */
    steps: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).default([]),
    platforms: z.array(PlaybookPlatformSchema).default([]),
    /** Creative rubric axes (see creative-postmortem), for lessons. */
    axes: z.array(z.string().regex(/^[a-zA-Z]+$/)).default([]),
    /** The project it came from; an episode always has one. */
    project: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
  })
  .strict();

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** What a proposal changes in the tracked harness; `retire` removes a rule or sensor that did not help. */
export const PROPOSAL_CHANGES = ["sensor", "rule", "playbook", "tool", "chain", "critic", "retire"] as const;
/**
 * Lifecycle: proposed (agent) -> approved (the user's words) -> applied (commits) -> verified or ineffective (recurrence of
 * its causes after `appliedAt`); rejected and retired close it. Only the user moves it to approved; ineffective changes
 * are proposed for retirement, never silently reverted.
 */
export const PROPOSAL_STATES = [
  "proposed",
  "approved",
  "applied",
  "verified",
  "ineffective",
  "rejected",
  "retired",
] as const;
const APPROVED_OR_LATER = new Set(["approved", "applied", "verified", "ineffective"]);
const APPLIED_OR_LATER = new Set(["applied", "verified", "ineffective"]);

export const MemoryProposalSchema = z
  .object({
    change: z.enum(PROPOSAL_CHANGES),
    /** Repository paths the change touches (tracked harness files only). */
    targets: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "a repository-relative path"),
      )
      .min(1),
    /** The repeated observations, gaps or lessons it answers; their sightings after `appliedAt` measure it. */
    causes: z.array(z.lazy(() => MemoryIdSchema)).min(1),
    state: z.enum(PROPOSAL_STATES).default("proposed"),
    /** The user's go-ahead, verbatim; required from approved on. */
    approval: z
      .object({ quote: z.string().min(2), at: DateSchema })
      .strict()
      .optional(),
    /** The test that guards the change, e.g. tests/x.test.ts. */
    test: z.string().min(1).optional(),
    commits: z.array(z.string().regex(/^[0-9a-f]{7,40}$/)).default([]),
    appliedAt: DateSchema.optional(),
    /** Why it was verified, judged ineffective, rejected or retired. */
    verdict: z.string().min(2).max(300).optional(),
    /** The user's words confirming a verified or ineffective verdict, or turning down an approved proposal. */
    confirmation: z
      .object({ quote: z.string().min(2), at: DateSchema })
      .strict()
      .optional(),
  })
  .strict();
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;

export const MemorySourceSchema = z.discriminatedUnion("kind", [
  /** The user said it: `quote` verbatim, in their language. */
  z
    .object({
      kind: z.literal("user"),
      quote: z.string().min(2),
      at: z.string().datetime({ offset: true }).optional(),
      /** `console` when the studio console recorded the user's words (RFC 0004 D9). */
      channel: z.enum(["cli", "console"]).optional(),
    })
    .strict(),
  /** An agent saw it: what it saw, with an artefact path or a command. Never a lesson, preference or decision. */
  z.object({ kind: z.literal("agent"), agent: z.string().min(2), evidence: z.string().min(2) }).strict(),
  /** Written by a command from measured data (episodes, gaps from a recorded workaround). */
  z.object({ kind: z.literal("measured"), evidence: z.string().min(2) }).strict(),
]);

export const MemoryEntrySchema = z
  .object({
    version: z.literal(1),
    id: MemoryIdSchema,
    type: MemoryTypeSchema,
    /** One line, at most 160 characters: what a next-step answer shows. */
    summary: z.string().min(8).max(160),
    scope: MemoryScopeSchema,
    source: MemorySourceSchema,
    status: z.enum(["active", "superseded", "retired"]).default("active"),
    /** Ids this entry replaces; they become `superseded`. */
    supersedes: z.array(MemoryIdSchema).default([]),
    /** Observations and gaps: how many times it was seen (repeat >= 2 is a trigger for an improvement proposal). */
    occurrences: z.number().int().min(1).default(1),
    /** Dates of each sighting after the first (markSeen appends); a proposal's effect is measured against them. */
    sightings: z.array(DateSchema).default([]),
    createdAt: DateSchema,
    reviewedAt: DateSchema.optional(),
    /** Required for, and only for, a proposal. */
    proposal: MemoryProposalSchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (!entry.id.startsWith(`${entry.type}-`))
      ctx.addIssue({ code: "custom", path: ["id"], message: `id must start with "${entry.type}-"` });
    if (USER_CONFIRMED_TYPES.includes(entry.type) && entry.source.kind !== "user")
      ctx.addIssue({
        code: "custom",
        path: ["source"],
        message: `a ${entry.type} comes only from the user's own words (source.kind "user" with a verbatim quote)`,
      });
    if (entry.type === "episode" && !entry.scope.project)
      ctx.addIssue({ code: "custom", path: ["scope", "project"], message: "an episode names its project" });
    if (entry.supersedes.includes(entry.id))
      ctx.addIssue({ code: "custom", path: ["supersedes"], message: "an entry cannot supersede itself" });
    if (entry.type === "proposal" && !entry.proposal)
      ctx.addIssue({
        code: "custom",
        path: ["proposal"],
        message: "a proposal carries its change, targets, causes and state",
      });
    if (entry.type !== "proposal" && entry.proposal)
      ctx.addIssue({ code: "custom", path: ["proposal"], message: "only a proposal carries a proposal block" });
    const proposal = entry.proposal;
    if (proposal) {
      if (entry.source.kind === "measured")
        ctx.addIssue({
          code: "custom",
          path: ["source"],
          message: "a proposal comes from an agent or the user, not a command",
        });
      if (APPROVED_OR_LATER.has(proposal.state) && !proposal.approval)
        ctx.addIssue({
          code: "custom",
          path: ["proposal", "approval"],
          message: `a ${proposal.state} proposal needs the user's go-ahead, verbatim`,
        });
      if (APPLIED_OR_LATER.has(proposal.state) && (!proposal.appliedAt || proposal.commits.length === 0))
        ctx.addIssue({
          code: "custom",
          path: ["proposal"],
          message: `a ${proposal.state} proposal names its commits and appliedAt`,
        });
      if (
        (proposal.state === "verified" ||
          proposal.state === "ineffective" ||
          (proposal.state === "rejected" && proposal.approval)) &&
        !proposal.confirmation
      )
        ctx.addIssue({
          code: "custom",
          path: ["proposal", "confirmation"],
          message: `a ${proposal.state} proposal${proposal.state === "rejected" ? " the user had approved" : ""} needs the user's own words (confirmation)`,
        });
      if (proposal.causes.includes(entry.id))
        ctx.addIssue({ code: "custom", path: ["proposal", "causes"], message: "a proposal cannot cause itself" });
    }
  });
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

/** One line of memory/metrics.jsonl. */
export const MemoryMetricSchema = z
  .object({
    at: z.string().datetime({ offset: true }),
    project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    playbook: PlaybookIdSchema.optional(),
    step: z.string().optional(),
    /** `removed`: a tombstone written when the project is deleted; readMetrics ignores the id's earlier lines. */
    event: z.enum([
      "approved",
      "rejected",
      "round",
      "sensor-fail",
      "spend",
      "delivered",
      "accepted",
      "workaround",
      "removed",
    ]),
    value: z.number().optional(),
    detail: z.string().max(200).optional(),
  })
  .strict();
export type MemoryMetric = z.infer<typeof MemoryMetricSchema>;

/** What a next-step answer carries: the few entries relevant to this playbook, step and platform. */
export const MemoryRefSchema = z.object({ id: MemoryIdSchema, type: MemoryTypeSchema, summary: z.string() }).strict();
export type MemoryRef = z.infer<typeof MemoryRefSchema>;
