import { TIER_LIMITS, TrustTierSchema, type TrustTier } from "../../types/contrib";

export { TIER_LIMITS };
/** `closedAsSlop` counts `closed:slop` closures in the last 90 days (history.ts); `closed:process` never counts. */
export type HistorySummary = {
  merged: number;
  closedAsSlop: number;
  slopClosuresLast30Days: number;
  grant?: TrustTier;
};
export function computeTier(history: HistorySummary): TrustTier {
  for (const count of [history.merged, history.closedAsSlop, history.slopClosuresLast30Days]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("History counts must be non-negative integers");
  }
  if (history.grant !== undefined) TrustTierSchema.parse(history.grant);
  const share = history.closedAsSlop / Math.max(1, history.merged + history.closedAsSlop);
  let tier: TrustTier = history.merged >= 3 && share < 0.2 ? 1 : 0;
  if (history.grant === 3) tier = 3;
  else if (history.grant === 2 && history.merged >= 10) tier = 2;
  else if (history.grant !== undefined && history.grant !== 2) tier = history.grant;
  return (history.slopClosuresLast30Days >= 2 ? Math.max(0, tier - 1) : tier) as TrustTier;
}
