/**
 * The console's interaction metrics (RFC 0004 §12, A19, D20): the shape `GET /api/metrics` returns and
 * `out/console/metrics.json` holds. Zod only (no Node imports): the console UI parses replies with it. Proposed for
 * src/types/console.ts at the next contract amendment (WP12); kept here while the contract is frozen.
 */
import { z } from "zod";

const Count = z.number().int().nonnegative();
const Usd = z.number().finite().nonnegative();
const Ms = z.number().finite().nonnegative();
const Name = (max: number) => z.string().min(1).max(max);
const Iso = z.iso.datetime({ offset: true });

/** Median and 90th percentile of a set of durations; absent when the set is empty. */
export const DurationStatsSchema = z.strictObject({ count: Count, medianMs: Ms.optional(), p90Ms: Ms.optional() });
export type DurationStats = z.infer<typeof DurationStatsSchema>;

export const MetricsStepSchema = z.strictObject({
  step: Name(64),
  /** Gates decided at this step (approvals and choices). */
  decided: Count,
  /** Rounds: changes asked at this step (feedback), each one a reopening. */
  rounds: Count,
  refused: Count,
  timeToDecision: DurationStatsSchema,
  /** Agent time spent at this step (hooks, dispatches and CLI runs). */
  agentMs: Ms,
});

export const MetricsProjectSchema = z.strictObject({
  project: Name(64),
  route: Name(32).optional(),
  playbook: Name(64).optional(),
  decided: Count,
  waiting: Count,
  refused: Count,
  spentUsd: Usd,
  reservedUsd: Usd,
  /** Jobs and ledger rows whose price is unknown: never counted as 0 in `spentUsd`. */
  unknownPriced: Count,
  /** Its job store or ledger could not be read: `spentUsd` is unknown, not $0. */
  spendUnreadable: z.boolean(),
  /** Spend on outputs a later user rejection superseded (§12); absent when the job store cannot be read. */
  wastedUsd: Usd.optional(),
  /** Superseded items whose price is unknown: not in `wastedUsd`, and not $0. */
  wastedUnknownPriced: Count.optional(),
  ceilingUsd: Usd.optional(),
  /** The journal was read only from its tail (see the response's `truncated`). */
  truncated: z.boolean(),
});

export const ConsoleMetricsSchema = z.strictObject({
  v: z.literal(1),
  generatedAt: Iso,
  /** Sum of the projects' view revisions the metrics were derived from (cache key). */
  revision: Count,
  /** Some journal was longer than the bytes read from its end: older events are not counted. */
  truncated: z.boolean(),
  decisions: z.strictObject({
    /** User decisions applied (console spawns and the CLI's own decision commands). */
    decided: Count,
    console: Count,
    cli: Count,
    /** console / decided; absent when nothing was decided. */
    consoleShare: z.number().min(0).max(1).optional(),
    refused: Count,
    /** Gate ready (the decision's createdAt) → decided (decidedAt), console decisions. */
    timeToDecision: DurationStatsSchema,
    /** Decisions waiting now and for how long. */
    waiting: z.strictObject({ count: Count, oldestMs: Ms.optional(), medianMs: Ms.optional() }),
  }),
  rework: z.strictObject({
    /** Steps reopened after the user asked for changes. */
    reopened: Count,
    /** Gates decided. */
    gates: Count,
    rate: z.number().min(0).optional(),
  }),
  /** Refusals by error code (a refused decision, a paused command, a budget or a validation refusal). */
  refusals: z.array(z.strictObject({ code: Name(64), count: Count })).max(32),
  steps: z.array(MetricsStepSchema).max(200),
  spend: z.strictObject({
    spentUsd: Usd,
    reservedUsd: Usd,
    unknownPriced: Count,
    /** Projects whose job store or ledger could not be read: the sums leave them out, so spend is unknown, not $0. */
    unreadable: Count,
    /**
     * Wasted spend (§12): settled spend on outputs a later user rejection superseded (the rejected step, or a later
     * film step). `unknownPriced` superseded items are not in `usd`; `unattributed` paid items followed by a rejection
     * could not be tied to a step. Optional only so older metrics files still parse; computeMetrics always writes it.
     */
    wasted: z.strictObject({ usd: Usd, items: Count, unknownPriced: Count, unattributed: Count }).optional(),
    /** Calendar months (UTC), newest first; `unreadable` as above, for that month. */
    months: z
      .array(
        z.strictObject({
          month: z.string().regex(/^\d{4}-\d{2}$/),
          spentUsd: Usd,
          unknownPriced: Count,
          unreadable: Count,
        }),
      )
      .max(12),
  }),
  agents: z.strictObject({
    runs: Count,
    totalMs: Ms,
    byAgent: z.array(z.strictObject({ name: Name(128), runs: Count, totalMs: Ms })).max(50),
  }),
  verdicts: z.strictObject({
    /** Projects with a passed delivery check. */
    delivered: Count,
    /** Of those, with a recorded final verdict. */
    withVerdict: Count,
    byPlaybook: z
      .array(z.strictObject({ playbook: Name(64), count: Count, meanScore: z.number().min(1).max(10) }))
      .max(50),
  }),
  projects: z.array(MetricsProjectSchema).max(500),
});
export type ConsoleMetrics = z.infer<typeof ConsoleMetricsSchema>;
