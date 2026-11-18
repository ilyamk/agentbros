import { z } from "zod";
import { TrustOverridesSchema } from "../../types/contrib-tools";
import type { HistorySummary } from "./tiers";

const PullRequestsSchema = z.array(
  z.object({
    state: z.enum(["open", "closed"]),
    merged_at: z.string().datetime({ offset: true }).nullable(),
    closed_at: z.string().datetime({ offset: true }).nullable(),
    labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  }),
);

/**
 * Added by autoclose rules 3 (duplicate) and 5 (media/leak) or by a maintainer's manual slop closure, never by LLM triage.
 * Only this label lowers a trust tier, and only for closures within SLOP_WINDOW_DAYS.
 */
export const SLOP_CLOSURE_LABEL = "closed:slop";
/** Added by autoclose rules 1, 2, 4, 6 and 7: a procedural step was missing. Never affects the trust tier. */
export const PROCESS_CLOSURE_LABEL = "closed:process";
export const SLOP_WINDOW_DAYS = 90;
const DAY = 86400000;

/** Input must already be scoped to this author and repository by the trusted API caller. */
export function historySummary(
  input: unknown,
  now: Date,
  overrides: unknown = { version: 1, overrides: [] },
  handle = "",
): HistorySummary {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid current timestamp");
  const prs = PullRequestsSchema.parse(input);
  const isSlop = (pr: (typeof prs)[number]) =>
    pr.state === "closed" &&
    !pr.merged_at &&
    pr.labels.some((label) => (typeof label === "string" ? label : label.name) === SLOP_CLOSURE_LABEL);
  const grant = TrustOverridesSchema.parse(overrides).overrides.find(
    (row) => row.handle.toLowerCase() === handle.toLowerCase() && (!row.until || Date.parse(row.until) > now.getTime()),
  )?.tier;
  const within = (pr: (typeof prs)[number], days: number) =>
    isSlop(pr) &&
    pr.closed_at !== null &&
    Date.parse(pr.closed_at) <= now.getTime() &&
    now.getTime() - Date.parse(pr.closed_at) < days * DAY;
  return {
    merged: prs.filter((pr) => pr.merged_at !== null).length,
    // The slop share counts recent closures only, so an old mistake stops weighing on the tier.
    closedAsSlop: prs.filter((pr) => within(pr, SLOP_WINDOW_DAYS)).length,
    slopClosuresLast30Days: prs.filter((pr) => within(pr, 30)).length,
    ...(grant === undefined ? {} : { grant }),
  };
}
