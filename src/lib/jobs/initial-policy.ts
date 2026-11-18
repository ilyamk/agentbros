import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { ceilingAuthorityMessage, maxAdmissibleUsdFor, type OperationStore } from "./store";
import type { OperationDatabase } from "./types";

/** The first automatic ceiling never exceeds this, whatever the brief allows; a larger one is the user's `pnpm budget --answer`. */
export const FIRST_AUTOMATIC_CEILING_USD = 10;

/**
 * Install a project's first durable policy from its brief, when none exists yet.
 * A numeric brief.budgetUsd is the user's answer, so it grants a first ceiling of at most USD 10.
 * A null or missing budgetUsd authorises nothing: paid work is refused until the user's words set a ceiling.
 */
export function ensureProjectPolicy(store: OperationStore, projectId: string): void {
  if (existsSync(store.file)) return;
  const first = briefFirstPolicy(projectId);
  if (!first)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `No spend ceiling: brief.budgetUsd is not set, which authorises nothing. ${ceilingAuthorityMessage(projectId, null, "<amount>")}`,
    });
  store.configure(first.policy, {
    by: "brief",
    source: `brief.budgetUsd ${first.budget} (first ceiling capped at USD ${FIRST_AUTOMATIC_CEILING_USD})`,
  });
}
/** The first policy a numeric brief.budgetUsd would install, or undefined when the brief authorises nothing. */
function briefFirstPolicy(projectId: string): { policy: OperationDatabase["policy"]; budget: number } | undefined {
  const briefPath = path.resolve("public/projects", projectId, "pipeline/brief.json");
  const brief = existsSync(briefPath) ? (JSON.parse(readFileSync(briefPath, "utf8")) as { budgetUsd?: unknown }) : {};
  const budget = brief.budgetUsd;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0) return undefined;
  const ceiling = Math.min(FIRST_AUTOMATIC_CEILING_USD, budget);
  return {
    budget,
    policy: { ceilingUsd: ceiling, maxJobUsd: ceiling, repairReserveFraction: 0.15, maxPaidAttemptsPerAsset: 2 },
  };
}
/**
 * The most a new production job of this project could reserve now: from its operation store, or, before one exists,
 * from the first policy its brief would install. Null when neither sets a ceiling. Read-only: writes nothing.
 */
export function projectMaxAdmissibleUsd(store: OperationStore, projectId: string): number | null {
  if (existsSync(store.file)) return store.maxAdmissibleUsd();
  const first = briefFirstPolicy(projectId);
  return first ? maxAdmissibleUsdFor({ version: 1, projectId, revision: 0, policy: first.policy, jobs: {} }) : null;
}
