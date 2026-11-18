/**
 * The decision ledger, `pipeline/decisions.jsonl`: every gate the harness passed under the user's policy, with the
 * artefact hashes it covered and what it rested on, and every revocation the user made (`film:revert`). Append-only.
 * Autonomous decisions live here, in the project; never in memory/decisions, which holds only the user's words.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DecisionEntrySchema, type DecisionEntry } from "../../types/policy";

export const decisionsPath = (projectDir: string) => path.join(projectDir, "pipeline", "decisions.jsonl");

export function readDecisions(projectDir: string): DecisionEntry[] {
  const file = decisionsPath(projectDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed = DecisionEntrySchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

export const nextDecisionId = (entries: readonly DecisionEntry[]) => {
  const top = Math.max(0, ...entries.map((entry) => Number(entry.id.slice(2))));
  return `d-${String(top + 1).padStart(3, "0")}`;
};

type NewDecision = DecisionEntry extends infer Entry
  ? Entry extends DecisionEntry
    ? Omit<Entry, "id">
    : never
  : never;

/** Appends one entry with the next id; returns it. */
export function appendDecision(projectDir: string, entry: NewDecision): DecisionEntry {
  const value = DecisionEntrySchema.parse({ ...entry, id: nextDecisionId(readDecisions(projectDir)) });
  mkdirSync(path.dirname(decisionsPath(projectDir)), { recursive: true });
  appendFileSync(decisionsPath(projectDir), `${JSON.stringify(value)}\n`);
  return value;
}

export function revokedDecisionIds(entries: readonly DecisionEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => (entry.kind === "revoked" ? [entry.revokes] : [])));
}

/** Decisions still standing, grouped by step, as lines for the user's final question. */
export function ledgerLines(projectDir: string): string[] {
  const entries = readDecisions(projectDir);
  const revoked = revokedDecisionIds(entries);
  const byStep = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.kind === "revoked" || revoked.has(entry.id)) continue;
    const basis = Object.entries(entry.evidence)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    const line = `${entry.id} ${entry.kind} (${entry.judgeVerdict}${basis ? `; ${basis}` : ""})`;
    byStep.set(entry.step, [...(byStep.get(entry.step) ?? []), line]);
  }
  return [...byStep].map(([step, lines]) => `${step}: ${lines.join("; ")}`);
}
