/**
 * The global safeguard. Commands that do work append to `pipeline/guard.jsonl` (film:brief a dispatch, film:done a
 * seal or a re-entry, film:approve an approval, feedback --confirm a re-entry, film:policy --raise a raise); the guard
 * counts that log and reads spend live from operations.json. Counts never come from critiques or receipts, so
 * deleting them lowers nothing, and nothing ever rewrites the log: raising a limit resumes, it does not reset.
 * The limits hold with or without a policy: INTERACTIVE_LIMITS (60 rounds, 12 hours) unless an autonomous policy stands,
 * then DEFAULT_LIMITS (30 rounds, 4 hours); limits the user set win. film:next and next stop at a crossed one, and
 * film:brief refuses to dispatch. A film:revert is a re-entry of the revoked decision's step.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { OperationDatabaseSchema } from "../jobs/types";
import { committedSpendUsd } from "../jobs/store";
import { currentPolicy, effectiveLimits } from "../autonomy/policy";
import { GuardEventSchema, type GlobalLimits, type GuardEvent, type LimitName } from "../../types/policy";

/** A gap between two logged events longer than this is idle time, not work. */
export const IDLE_GAP_MS = 30 * 60 * 1000;

export const guardPath = (projectDir: string) => path.join(projectDir, "pipeline", "guard.jsonl");

export function readGuardEvents(projectDir: string): GuardEvent[] {
  const file = guardPath(projectDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const parsed = GuardEventSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

export function appendGuardEvent(projectDir: string, event: GuardEvent): void {
  const value = GuardEventSchema.parse(event);
  mkdirSync(path.dirname(guardPath(projectDir)), { recursive: true });
  appendFileSync(guardPath(projectDir), `${JSON.stringify(value)}\n`);
}

/** What makes printing the same brief again the same round: the step's input and output hashes and its critic round. */
export function dispatchKey(state: {
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  critic?: { round: number };
}): string {
  const text = JSON.stringify([
    Object.entries(state.inputs).sort(),
    Object.entries(state.outputs).sort(),
    state.critic?.round ?? 0,
  ]);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Logs a seal; when the step had been sealed before and an input changed since, also a re-entry, unless one is already logged since its last seal (feedback logs its own). */
export function recordSeal(
  projectDir: string,
  step: string,
  reopened: boolean,
  at: string = new Date().toISOString(),
): void {
  const events = readGuardEvents(projectDir);
  const lastSeal = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === "seal" && event.step === step)
    .at(-1);
  const logged = events
    .slice(lastSeal ? lastSeal.index + 1 : 0)
    .some((event) => event.kind === "reentry" && event.step === step);
  if (reopened && !logged) appendGuardEvent(projectDir, { kind: "reentry", step, source: "film:done", at });
  appendGuardEvent(projectDir, { kind: "seal", step, at });
}

export type GuardUsage = {
  totalRounds: number;
  /** Rounds per step: the most-dispatched role and lane on it. */
  stepRounds: Record<string, number>;
  reentries: Record<string, number>;
  activeHours: number;
  providerSpendUsd: number;
};

/** Hours of work: the gaps between consecutive logged events, each gap over IDLE_GAP_MS left out. */
export function activeHours(events: readonly GuardEvent[]): number {
  const times = events
    .map((event) => Date.parse(event.at))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let total = 0;
  for (let index = 1; index < times.length; index++) {
    const gap = times[index]! - times[index - 1]!;
    if (gap <= IDLE_GAP_MS) total += gap;
  }
  return total / 3_600_000;
}

function providerSpend(projectDir: string): number {
  const file = path.join(projectDir, "pipeline", "operations.json");
  if (!existsSync(file)) return 0;
  try {
    const parsed = OperationDatabaseSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? committedSpendUsd(parsed.data) : 0;
  } catch {
    return 0;
  }
}

export function guardUsage(
  projectDir: string,
  events: readonly GuardEvent[] = readGuardEvents(projectDir),
): GuardUsage {
  const lanes = new Map<string, number>();
  const reentries: Record<string, number> = {};
  for (const event of events) {
    if (event.kind === "dispatch" && event.step) {
      const key = JSON.stringify([event.step, event.role ?? "owner", event.lane ?? ""]);
      lanes.set(key, (lanes.get(key) ?? 0) + 1);
    }
    if (event.kind === "reentry" && event.step) reentries[event.step] = (reentries[event.step] ?? 0) + 1;
  }
  const stepRounds: Record<string, number> = {};
  for (const [key, count] of lanes) {
    const [step] = JSON.parse(key) as [string];
    stepRounds[step] = Math.max(stepRounds[step] ?? 0, count);
  }
  return {
    totalRounds: Object.values(stepRounds).reduce((sum, count) => sum + count, 0),
    stepRounds,
    reentries,
    activeHours: Math.round(activeHours(events) * 100) / 100,
    providerSpendUsd: providerSpend(projectDir),
  };
}

/**
 * A crossed limit. `blocks: "dispatch"`: a round limit is reached (used = max), so no further dispatch fits, but the
 * round in flight may still be sealed and the user asked. `blocks: "all"`: re-entries, active hours or spend went
 * past their limit, and the chain stops whatever it would do next.
 */
export type CrossedLimit = { name: LimitName; used: number; max: number; where?: string; blocks: "dispatch" | "all" };
export type GuardCheck = { limits: GlobalLimits; usage: GuardUsage; crossed: CrossedLimit[] };

const busiest = (counts: Record<string, number>): [string, number] | undefined =>
  Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

/** Which limits this project has reached. */
export function guardCheck(projectDir: string): GuardCheck {
  const limits = effectiveLimits(currentPolicy(projectDir));
  const usage = guardUsage(projectDir);
  const crossed: CrossedLimit[] = [];
  if (usage.totalRounds >= limits.maxTotalRounds)
    crossed.push({ name: "maxTotalRounds", used: usage.totalRounds, max: limits.maxTotalRounds, blocks: "dispatch" });
  const step = busiest(usage.stepRounds);
  if (step && step[1] >= limits.maxStepRounds)
    crossed.push({
      name: "maxStepRounds",
      used: step[1],
      max: limits.maxStepRounds,
      where: step[0],
      blocks: "dispatch",
    });
  const reentry = busiest(usage.reentries);
  if (reentry && reentry[1] > limits.maxReentries)
    crossed.push({
      name: "maxReentries",
      used: reentry[1],
      max: limits.maxReentries,
      where: reentry[0],
      blocks: "all",
    });
  if (usage.activeHours >= limits.maxActiveHours)
    crossed.push({ name: "maxActiveHours", used: usage.activeHours, max: limits.maxActiveHours, blocks: "all" });
  if (limits.maxProviderSpendUsd !== undefined && usage.providerSpendUsd > limits.maxProviderSpendUsd)
    crossed.push({
      name: "maxProviderSpendUsd",
      used: usage.providerSpendUsd,
      max: limits.maxProviderSpendUsd,
      blocks: "all",
    });
  return { limits, usage, crossed };
}

/** The limits that stop this action: every `all` limit, and the round limits when the action dispatches. */
export function stopping(check: GuardCheck, action: string | undefined): CrossedLimit[] {
  return check.crossed.filter((limit) => limit.blocks === "all" || action === "dispatch");
}

/** The command that raises one crossed limit; it needs the user's own words. */
export const raiseCommand = (projectId: string, limit: CrossedLimit) => {
  const next =
    limit.name === "maxActiveHours" || limit.name === "maxProviderSpendUsd"
      ? Math.ceil(Math.max(limit.used, limit.max) * 1.5 * 100) / 100
      : Math.max(limit.used, limit.max) + Math.max(1, Math.ceil(limit.max / 2));
  return `pnpm film:policy --project ${projectId} --raise ${limit.name}=${next} --answer "<the user's words>"`;
};
