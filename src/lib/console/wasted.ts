/**
 * Wasted spend (RFC 0004 §12): spend on outputs later superseded by a user rejection. Derived locally per project:
 *
 * - **Rejections**: the user's "ask for changes" at a step, with its time: feedback items routed to a step (verdict
 *   `revise`, not declined by the owner; `pipeline/feedback/`), the console's applied changes and another-round
 *   decisions (`pipeline/inbox/`), and `feedback --step … --answer` runs in the journal (the CLI's own path).
 * - **Spend at a step**: each job of the store (and each ledger row the store does not cover) is attributed to the
 *   chain step that made it: the leased step on its `job.state` journal lines, else its stage when that names a
 *   step (or a known alias such as `voiceover` → narration), else the folder its output was published to.
 * - **Superseded**: a rejection at step R after the output was made (the job's first `validated`/`published`
 *   transition, else its receipt; the ledger row's time) supersedes it when the spend's step is R or reads R's outputs,
 *   directly or through other steps (the chain's declared inputs and outputs: a new script remakes the takes, a new
 *   voice never remakes generated shots); outside the film route only the same step counts.
 *
 * Each spend item counts once, however many rejections follow it. A superseded item without a known price is counted
 * in `unknownPriced`, never as $0; a paid item whose step cannot be told, with a rejection after it, is counted in
 * `unattributed` (its spend may be wasted: unknown, not $0 and not wasted).
 */
import { FILM_CHAIN } from "../film/chain";
import { listFeedback } from "../feedback/store";
import type { ConsoleEvent, InboxDecisionFile } from "../../types/console";
import type { GenerationJob } from "../jobs/types";
import type { ProjectPaths } from "./view/files";
import { jobCostUsd, ledgerOperationId, openStore, readLedgerRows } from "./view/money";

export type Rejection = { step: string; at: number };
export type WastedSpend = {
  /** Settled USD on superseded outputs. */
  usd: number;
  /** Superseded jobs and ledger rows, priced or not. */
  items: number;
  /** Superseded items whose price is unknown: their spend is not in `usd`, and is not $0. */
  unknownPriced: number;
  /** Paid items followed by a rejection whose step cannot be told. */
  unattributed: number;
};

const CHAIN_IDS = new Set(FILM_CHAIN.map((step) => step.id));

/** For each film step, the steps that read its outputs, directly or transitively (built once from the chain). */
const DOWNSTREAM: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const owner = new Map<string, string>();
  for (const step of FILM_CHAIN) for (const output of step.outputs) owner.set(output.path, step.id);
  const readers = new Map<string, Set<string>>();
  for (const step of FILM_CHAIN)
    for (const input of step.inputs) {
      const from = owner.get(input.path);
      if (from && from !== step.id) (readers.get(from) ?? readers.set(from, new Set()).get(from)!).add(step.id);
    }
  const closure = new Map<string, Set<string>>();
  for (const step of FILM_CHAIN) {
    const seen = new Set<string>();
    const queue = [...(readers.get(step.id) ?? [])];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(readers.get(next) ?? []));
    }
    closure.set(step.id, seen);
  }
  return closure;
})();
/** Job stages that are not step ids but name one (scripts/generate-voiceover.ts writes `voiceover`). */
const STAGE_STEP: Readonly<Record<string, string>> = { voiceover: "narration", "talking-head": "build" };
/** Folders a published output lands in, by the step that owns them. */
const OUTPUT_STEP: readonly [RegExp, string][] = [
  [/(^|\/)voiceover\//, "narration"],
  [/(^|\/)music\//, "music"],
  [/(^|\/)sfx\//, "sound"],
];
/** Console options that ask for changes (actions.ts OPTION_ACTIONS: changes, another-round). */
export const CHANGE_CHOICES: ReadonlySet<string> = new Set([
  "changes",
  "reject",
  "revise",
  "another-round",
  "critic-round",
]);

const time = (iso: string | undefined) => {
  const value = Date.parse(iso ?? "");
  return Number.isFinite(value) ? value : undefined;
};

/** Every user rejection of a project, with the step it reopens and when. */
export function userRejections(
  paths: ProjectPaths,
  inbox: readonly InboxDecisionFile[],
  feedbackRuns: readonly { step?: string; at?: string }[],
): Rejection[] {
  const out: Rejection[] = [];
  for (const record of listFeedback(paths.projectDir)) {
    const at = time(record.source.at);
    if (at === undefined || record.verdict !== "revise") continue;
    for (const item of record.items)
      if (item.routedTo !== "ask" && item.status !== "declined") out.push({ step: item.routedTo, at });
  }
  for (const decision of inbox) {
    if (decision.status !== "applied" && decision.status !== "partial") continue;
    const at = time(decision.decidedAt);
    if (decision.step && at !== undefined && CHANGE_CHOICES.has(decision.choice ?? ""))
      out.push({ step: decision.step, at });
  }
  for (const run of feedbackRuns) {
    const at = time(run.at);
    if (run.step && at !== undefined) out.push({ step: run.step, at });
  }
  return out;
}

/** The leased step each job's `job.state` lines carry, by job id (the first line that names one). */
export function jobSteps(events: readonly ConsoleEvent[]): Map<string, string> {
  const steps = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "job.state" || !event.step) continue;
    const id = (event.data as { jobId?: unknown } | undefined)?.jobId;
    if (typeof id === "string" && !steps.has(id)) steps.set(id, event.step);
  }
  return steps;
}

/** The chain step that made a spend item, or undefined when nothing tells. */
export function spendStep(input: { journalStep?: string; stage?: string; output?: string }): string | undefined {
  if (input.journalStep) return input.journalStep;
  const stage = input.stage?.trim();
  if (stage && CHAIN_IDS.has(stage)) return stage;
  if (stage && STAGE_STEP[stage]) return STAGE_STEP[stage];
  const output = input.output?.replace(/\\/g, "/");
  return output ? OUTPUT_STEP.find(([pattern]) => pattern.test(output))?.[1] : undefined;
}

/** Whether a rejection at `rejected` reopens the output of `step`: the same step, or a film step that reads its outputs. */
export function reopens(rejected: string, step: string, film: boolean): boolean {
  if (rejected === step) return true;
  return film && (DOWNSTREAM.get(rejected)?.has(step) ?? false);
}

/**
 * When a job's output was made: its first `validated` or `published` transition (billing may be reconciled after the
 * user already rejected the output), else its receipt, else its last transition.
 */
const madeAt = (job: GenerationJob): number | undefined =>
  time(job.history.find((entry) => entry.state === "validated" || entry.state === "published")?.at) ??
  time(job.receipt?.confirmedAt) ??
  time(job.history.at(-1)?.at) ??
  time(job.updatedAt);

/** A job whose price is unknown until a receipt arrives (the money panel's rule: `user-bound` quotes). */
const unknownPrice = (job: GenerationJob) => job.quote.confidence === "user-bound" && !job.receipt;
/** States in which a job produced (or may have produced) a billed output. */
const PRODUCED = new Set(["validated", "published", "running", "queued", "unknown", "submitting"]);

/** Wasted spend of one project; throws only on a corrupt job store (the caller reports that as unreadable). */
export function wastedSpend(
  paths: ProjectPaths,
  input: {
    events: readonly ConsoleEvent[];
    inbox: readonly InboxDecisionFile[];
    feedbackRuns: readonly { step?: string; at?: string }[];
    film: boolean;
  },
): WastedSpend {
  const result: WastedSpend = { usd: 0, items: 0, unknownPriced: 0, unattributed: 0 };
  const rejections = userRejections(paths, input.inbox, input.feedbackRuns);
  if (!rejections.length) return result;
  const steps = jobSteps(input.events);
  const consider = (step: string | undefined, at: number | undefined, usd: number | null) => {
    if (at === undefined) return;
    const later = rejections.filter((rejection) => rejection.at > at);
    if (!later.length) return;
    if (!step) {
      if (usd === null || usd > 0) result.unattributed++;
      return;
    }
    if (!later.some((rejection) => reopens(rejection.step, step, input.film))) return;
    if (usd === null) {
      result.items++;
      result.unknownPriced++;
    } else if (usd > 0) {
      result.items++;
      result.usd += usd;
    }
  };

  const jobs = Object.values(openStore(paths)?.database.jobs ?? {});
  for (const job of jobs) {
    const step = spendStep({
      journalStep: steps.get(job.operationId),
      stage: job.stage,
      output: job.publication?.output,
    });
    if (job.receipt) consider(step, madeAt(job), jobCostUsd(job));
    else if (unknownPrice(job) && PRODUCED.has(job.state)) consider(step, madeAt(job), null);
  }
  const storeIds = new Set(jobs.map((job) => job.operationId));
  for (const row of readLedgerRows(paths)) {
    const id = ledgerOperationId(row);
    if (id !== undefined && storeIds.has(id)) continue;
    const usd =
      typeof row.actualUsd === "number"
        ? row.actualUsd
        : typeof row.estimatedUsd === "number"
          ? row.estimatedUsd
          : null;
    consider(spendStep({ stage: row.stage }), time(row.ts), usd);
  }
  result.usd = Math.round(result.usd * 1_000_000) / 1_000_000;
  return result;
}
