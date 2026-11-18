import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CeilingGrant } from "../../src/lib/jobs/types";

/** Fixtures stand in for the user's own words when a test raises or first sets a durable ceiling. */
export const USER_GRANT: CeilingGrant = { by: "user", answer: "Test fixture: the user authorised this ceiling." };

/** A brief whose budgetUsd is the user's answer, so paid commands may install the first (capped) ceiling. */
export function writeBudgetBrief(projectDir: string, budgetUsd = 10): void {
  mkdirSync(path.join(projectDir, "pipeline"), { recursive: true });
  writeFileSync(path.join(projectDir, "pipeline/brief.json"), JSON.stringify({ budgetUsd }));
}
