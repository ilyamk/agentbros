import { z } from "zod";

/**
 * A step lease: which commands the current step of a film or footage project may run, written by the
 * next-step commands (`next`, `film:next`, `film:brief`, `footage:next`) to `pipeline/session/lease.json`
 * and checked by `runScript`, the MCP bridge and the optional Claude Code hook (docs/step-lease.md).
 */
export const LEASE_ROLES = ["orchestrator", "owner", "critic", "fixer"] as const;

export const StepLeaseSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.string().min(1),
  route: z.enum(["film", "footage"]),
  step: z.string().min(1),
  /** The agent (or `user`, `script`, `orchestrator`) the step belongs to now. */
  owner: z.string().min(1),
  role: z.enum(LEASE_ROLES),
  /** Fan-out lanes briefed for this step (concept teams, script variants). */
  lanes: z.array(z.string()),
  /** pnpm aliases the step may run, the fixed control set included. */
  allow: z.array(z.string()),
  /** Aliases in `allow` that may spend (registry `paid` or `may-spend`); without paid authority they run only with --dry-run. */
  spending: z.array(z.string()),
  /** The chain's own user approval for this step's spend is present (film: the user's yes on material.json). */
  paidAllowed: z.boolean(),
  /** Spend is also allowed once this durable user record exists (footage: a budget ceiling raised with the user's words). */
  paidWhen: z.enum(["budget-ceiling"]).optional(),
  /** Hash of the chain's receipts, approvals and skips (film) or goals and playbook binding (footage) at issue. */
  chainHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.string(),
  expiresAt: z.string(),
  /** The command that wrote it. */
  issuedBy: z.string(),
});
export type StepLease = z.infer<typeof StepLeaseSchema>;

/** `pnpm step:unlock`: a time-limited, reasoned exception to the lease, appended to pipeline/session/unlocks.jsonl. */
export const StepUnlockSchema = z.object({
  at: z.string(),
  until: z.string(),
  reason: z.string().min(1),
  /** The leased step when the unlock was written, if any. */
  step: z.string().optional(),
});
export type StepUnlock = z.infer<typeof StepUnlockSchema>;

/** One out-of-step run, appended to pipeline/session/violations.jsonl (warn and enforce alike). */
export const StepViolationSchema = z.object({
  at: z.string(),
  project: z.string(),
  step: z.string(),
  owner: z.string(),
  alias: z.string(),
  code: z.enum(["not-in-step", "paid", "stale", "expired"]),
  mode: z.enum(["warn", "enforce"]),
  /** Why that mode: AGENTBROS_STEP_GUARD, an autonomous policy, a benchmark run or the interactive default. */
  modeSource: z.enum(["env", "policy", "benchmark", "default"]).optional(),
  refused: z.boolean(),
  via: z.enum(["cli", "mcp"]),
  /** An active step:unlock admitted the run. */
  unlocked: z.boolean().optional(),
});
export type StepViolation = z.infer<typeof StepViolationSchema>;
