/**
 * A project's autonomy policy (`pipeline/policy.json`), its global limits, the decision ledger
 * (`pipeline/decisions.jsonl`) and the guard log (`pipeline/guard.jsonl`). Written by `film:policy`, `film:approve
 * --policy`, `film:revert`, `film:brief`, `film:done`, `film:approve` and `feedback --confirm`; read by film:next and
 * OperationStore. Imports nothing from src/lib, so the job store can read it without a cycle.
 */
import { z } from "zod";

const dollars = z.number().finite().nonnegative();
const words = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((answer) => !/^<.*>$/s.test(answer), "--answer still holds the placeholder: pass the user's own words.");

export const AUTONOMY_MODES = ["interactive", "autonomous"] as const;
/** Class (a) steps the policy may pass after their judge closed on the exact current artefact. */
export const AUTO_PASS_STEPS = ["concept", "script", "replica-spec", "material-free", "shorts"] as const;
export type AutoPassStep = (typeof AUTO_PASS_STEPS)[number];

/** Global limits: they apply with or without a policy file (defaults below); raising one needs the user's words. */
export const GlobalLimitsSchema = z
  .object({
    /** Sum over steps of each step's rounds (a step's rounds: its most-dispatched role and lane). */
    maxTotalRounds: z.number().int().positive().default(30),
    /** One step's rounds: dispatches of one role and lane on that step. */
    maxStepRounds: z.number().int().positive().default(6),
    /** Times one closed step was reopened (feedback, a changed input after its seal). */
    maxReentries: z.number().int().nonnegative().default(2),
    /** Active hours: gaps between logged events, each gap over 30 minutes left out. */
    maxActiveHours: z.number().positive().default(4),
    /** Provider spend (reserved plus settled, from operations.json); unset: only the job store's ceiling binds. */
    maxProviderSpendUsd: dollars.optional(),
    /** Advisory only: reported, never enforced. */
    maxAgentTokens: z.number().int().positive().optional(),
  })
  .strict();
export type GlobalLimits = z.output<typeof GlobalLimitsSchema>;
export const LIMIT_NAMES = [
  "maxTotalRounds",
  "maxStepRounds",
  "maxReentries",
  "maxActiveHours",
  "maxProviderSpendUsd",
  "maxAgentTokens",
] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];
/** The autonomous defaults (a standing autonomous policy): the schema's defaults. */
export const DEFAULT_LIMITS: GlobalLimits = GlobalLimitsSchema.parse({});
/** The interactive defaults (no autonomous policy): the user answers every gate, so more rounds and hours fit. */
export const INTERACTIVE_LIMITS: GlobalLimits = { ...DEFAULT_LIMITS, maxTotalRounds: 60, maxActiveHours: 12 };
/** A policy's own limits, without defaults: only what the user set, so the mode's defaults fill the rest. */
export const LimitOverridesSchema = z
  .object({
    maxTotalRounds: z.number().int().positive().optional(),
    maxStepRounds: z.number().int().positive().optional(),
    maxReentries: z.number().int().nonnegative().optional(),
    maxActiveHours: z.number().positive().optional(),
    maxProviderSpendUsd: dollars.optional(),
    maxAgentTokens: z.number().int().positive().optional(),
  })
  .strict();

export const PolicyBudgetSchema = z
  .object({
    ceilingUsd: dollars,
    maxJobUsd: dollars,
    /** Providers OperationStore admits under this policy; an empty list admits none. */
    allowedProviders: z.array(z.string().min(1)),
    /** A quote whose price the caller bound by hand (confidence user-bound) is refused while false. */
    allowUserBoundQuotes: z.boolean().default(false),
  })
  .strict();
export type PolicyBudget = z.output<typeof PolicyBudgetSchema>;

/** The user's answers given in advance; each turns one user gate into a recorded run when the artefact matches. */
export const PreAnswersSchema = z
  .object({
    filmType: z.string().min(1).optional(),
    musicRoute: z.enum(["silence", "user-supplied"]).optional(),
    /** With musicRoute user-supplied: the shortlist candidate id of the user's own track. */
    musicFile: z.string().min(1).optional(),
    silenceReason: z.string().min(1).optional(),
    proposition: z.string().min(1).optional(),
    /** Replica films: the spec's swaps (each swap's `what`) the user accepts at replica-spec, no more and no fewer. */
    swaps: z.array(z.string().min(1)).optional(),
    /** Footage projects: the caption profile id footage:next would ask for (src/lib/autonomy/pre-answers.ts checks it). */
    captionStyle: z.string().min(1).optional(),
    /** Footage projects: how many ranked shorts to approve, best first (2 to 30, a series' bounds). */
    shorts: z.number().int().positive().optional(),
    formats: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type PreAnswers = z.output<typeof PreAnswersSchema>;

export const PolicyRevisionSchema = z
  .object({
    revision: z.number().int().positive(),
    at: z.iso.datetime(),
    autonomy: z.enum(AUTONOMY_MODES),
    /** The user's own words for this revision; a revision that only lowers or narrows may carry the previous grant. */
    grantedBy: z
      .object({ answer: words, at: z.iso.datetime(), channel: z.enum(["cli", "console"]).optional() })
      .strict(),
    budget: PolicyBudgetSchema.optional(),
    preAnswers: PreAnswersSchema.default({}),
    autoPass: z.array(z.enum(AUTO_PASS_STEPS)).default([]),
    finalReviewOnly: z.boolean().default(false),
    /** Overrides of the mode's defaults (DEFAULT_LIMITS autonomous, INTERACTIVE_LIMITS otherwise). */
    limits: LimitOverridesSchema.default({}),
    /** Paid material the policy may approve on its own: the sum of autonomously approved items' bounds, in USD. */
    spendUsd: dollars.optional(),
    /** What this revision changed, for the record. */
    changes: z.array(z.string()).default([]),
  })
  .strict();
export type PolicyRevision = z.output<typeof PolicyRevisionSchema>;

export const ProjectPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1),
    /** Append-only; the last one is in force. */
    revisions: z.array(PolicyRevisionSchema).min(1),
  })
  .strict();
export type ProjectPolicy = z.output<typeof ProjectPolicySchema>;

/** One line of pipeline/decisions.jsonl: a decision made under the policy, or the user's revocation of one. */
export const DecisionEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().regex(/^d-\d{3,}$/),
      step: z.string().min(1),
      kind: z.enum(["preAnswer", "judge", "spend"]),
      /** The artefacts the decision covered, root-relative path to sha256. */
      artefactHashes: z.record(z.string(), z.string()),
      /** What it rests on: the pre-answer key and value, or the judge's file and target hash. */
      evidence: z.record(z.string(), z.string()),
      judgeVerdict: z.string().min(1),
      /** kind spend: the USD this approval authorised (its pending paid items' bounds). */
      amountUsd: dollars.optional(),
      scores: z.record(z.string(), z.number()).optional(),
      alternatives: z.array(z.string()).optional(),
      policyRevision: z.number().int().positive(),
      at: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      id: z.string().regex(/^d-\d{3,}$/),
      kind: z.literal("revoked"),
      revokes: z.string().regex(/^d-\d{3,}$/),
      step: z.string().min(1),
      answer: words,
      at: z.iso.datetime(),
    })
    .strict(),
]);
export type DecisionEntry = z.output<typeof DecisionEntrySchema>;

/** One line of pipeline/guard.jsonl: work the commands did, counted by the guard. Never rewritten. */
export const GuardEventSchema = z
  .object({
    kind: z.enum(["dispatch", "seal", "approval", "reentry", "raise"]),
    step: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    lane: z.string().min(1).optional(),
    /** Dispatch: what makes a repeat of the same brief the same round (the step's input hashes, the critic round). */
    key: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    at: z.iso.datetime(),
  })
  .strict();
export type GuardEvent = z.output<typeof GuardEventSchema>;
