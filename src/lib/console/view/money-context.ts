/**
 * One money context for the view and for `deriveWaiting` (RFC 0004 §6.2, FR4): the job store's money, with the policy's
 * ceiling when the store has none, and the store's admissible maximum. Both callers build quotes from it, so a
 * quote's hash is the same whichever of them derived the decision.
 */
import type { QuoteContext } from "./film";
import type { ProjectPaths } from "./files";
import { emptyMoney, readMoney, type Money, type MoneyRead } from "./money";
import { readAutonomy, type Section } from "./sections";
import type { ProjectView } from "../../../types/console";

export type MoneyContext = {
  money: Money;
  quote: QuoteContext;
  autonomy: Section<ProjectView["autonomy"]>;
  advisories: string[];
};

export function readMoneyContext(paths: ProjectPaths): MoneyContext {
  const advisories: string[] = [];
  let read: MoneyRead;
  try {
    read = readMoney(paths);
  } catch (error) {
    advisories.push(`money: ${(error as Error).message ?? String(error)}`);
    read = { money: emptyMoney(), maxAdmissibleUsd: null, advisories: [] };
  }
  advisories.push(...read.advisories);
  const autonomy = readAutonomy(paths, read.money.ceilingUsd);
  const money = { ...read.money };
  if (money.ceilingUsd === undefined && autonomy.value.ceilingUsd !== undefined)
    money.ceilingUsd = autonomy.value.ceilingUsd;
  return { money, quote: { ...money, maxAdmissibleUsd: read.maxAdmissibleUsd }, autonomy, advisories };
}
