/**
 * A project's autonomy policy: `pipeline/policy.json`, its own file (never in brief.json, never a step input, so it
 * reopens nothing). Interactive is the default and the absence of the file. Revisions are appended; any change that
 * widens what the harness may do without asking needs the user's own words (`--answer`); narrowing needs none.
 * Read by film:next (src/lib/film/state.ts), the guard (src/lib/film/guard.ts) and OperationStore (src/lib/jobs/store.ts).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { wordsChannel } from "../cli/channel";
import {
  DEFAULT_LIMITS,
  INTERACTIVE_LIMITS,
  LIMIT_NAMES,
  PolicyRevisionSchema,
  ProjectPolicySchema,
  type AutoPassStep,
  type GlobalLimits,
  type LimitName,
  type PolicyBudget,
  type PolicyRevision,
  type PreAnswers,
  type ProjectPolicy,
} from "../../types/policy";

export class PolicyRefusal extends Error {}

/** The policy beside a pipeline directory's other files (`<project>/pipeline/policy.json`). */
export const policyPath = (pipelineDir: string) => path.join(pipelineDir, "policy.json");
export const projectPolicyPath = (projectDir: string) => policyPath(path.join(projectDir, "pipeline"));

export function readPolicyFile(file: string): ProjectPolicy | undefined {
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new PolicyRefusal(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ProjectPolicySchema.safeParse(raw);
  if (!parsed.success)
    throw new PolicyRefusal(
      `${file} does not match ProjectPolicySchema: ${parsed.error.issues[0]?.path.join(".") || "root"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  return parsed.data;
}

/** The revision in force, or undefined when the project has no policy (interactive, default limits). */
export function currentPolicy(projectDir: string): PolicyRevision | undefined {
  return readPolicyFile(projectPolicyPath(projectDir))?.revisions.at(-1);
}

export const isAutonomous = (policy: PolicyRevision | undefined): policy is PolicyRevision =>
  policy?.autonomy === "autonomous";

/** The mode's defaults: an autonomous policy keeps the tighter DEFAULT_LIMITS, interactive (or no policy) INTERACTIVE_LIMITS. */
export const modeLimits = (policy: PolicyRevision | undefined): GlobalLimits =>
  isAutonomous(policy) ? DEFAULT_LIMITS : INTERACTIVE_LIMITS;

/** The limits in force: the mode's defaults, overridden by the limits the user set in the policy. */
export function effectiveLimits(
  policy: PolicyRevision | undefined,
  base: GlobalLimits = modeLimits(policy),
): GlobalLimits {
  const limits: GlobalLimits = { ...base, ...(policy?.limits ?? {}) };
  if (limits.maxProviderSpendUsd === undefined && policy?.budget) limits.maxProviderSpendUsd = policy.budget.ceilingUsd;
  return limits;
}

export type PolicyChange = {
  autonomy?: PolicyRevision["autonomy"];
  budget?: Partial<PolicyBudget>;
  preAnswers?: PreAnswers;
  /** Keys of preAnswers to drop. */
  dropPreAnswers?: (keyof PreAnswers)[];
  autoPass?: AutoPassStep[];
  finalReviewOnly?: boolean;
  limits?: Partial<Record<LimitName, number>>;
  /** Paid material the policy may approve on its own, in USD; 0 removes it. */
  spendUsd?: number;
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every way the next revision widens the previous one; each needs the user's words. */
export function widenings(previous: PolicyRevision | undefined, next: PolicyRevision): string[] {
  const out: string[] = [];
  if (next.autonomy === "autonomous" && previous?.autonomy !== "autonomous") out.push("autonomy autonomous");
  const before = previous?.budget;
  if (next.budget) {
    if (!before) out.push(`budget ceiling USD ${next.budget.ceilingUsd}`);
    else {
      if (next.budget.ceilingUsd > before.ceilingUsd) out.push(`budget ceiling USD ${next.budget.ceilingUsd}`);
      if (next.budget.maxJobUsd > before.maxJobUsd) out.push(`max job USD ${next.budget.maxJobUsd}`);
      for (const provider of next.budget.allowedProviders)
        if (!before.allowedProviders.includes(provider)) out.push(`provider ${provider}`);
      if (next.budget.allowUserBoundQuotes && !before.allowUserBoundQuotes) out.push("user-bound quotes");
    }
  }
  for (const step of next.autoPass) if (!previous?.autoPass.includes(step)) out.push(`auto-pass ${step}`);
  for (const [key, value] of Object.entries(next.preAnswers))
    if (!sameJson(value, previous?.preAnswers[key as keyof PreAnswers])) out.push(`pre-answer ${key}`);
  if (next.finalReviewOnly && !previous?.finalReviewOnly) out.push("final review only");
  if (next.spendUsd !== undefined && next.spendUsd > (previous?.spendUsd ?? 0))
    out.push(`autonomous spend USD ${next.spendUsd}`);
  // Both sides on the next revision's mode defaults: a mode change alone (more rounds when interactive) widens nothing.
  const base = modeLimits(next);
  const was = effectiveLimits(previous, base);
  const now = effectiveLimits(next, base);
  for (const name of LIMIT_NAMES) {
    const a = was[name];
    const b = now[name];
    if (b === undefined) {
      if (a !== undefined && name !== "maxAgentTokens") out.push(`${name} unlimited`);
      continue;
    }
    if (a !== undefined && b > a) out.push(`${name} ${a} -> ${b}`);
  }
  return out;
}

/**
 * Appends a revision. Refuses a widening without the user's words; a narrowing keeps the previous grant.
 * Counters (guard.jsonl, decisions.jsonl) are never touched: raising a limit resumes, it does not reset.
 */
export function revisePolicy(
  projectDir: string,
  projectId: string,
  change: PolicyChange,
  answer: string | undefined,
  at: string = new Date().toISOString(),
): { policy: ProjectPolicy; revision: PolicyRevision; widened: string[] } {
  const file = projectPolicyPath(projectDir);
  const existing = readPolicyFile(file);
  const previous = existing?.revisions.at(-1);
  const preAnswers: PreAnswers = { ...(previous?.preAnswers ?? {}), ...(change.preAnswers ?? {}) };
  for (const key of change.dropPreAnswers ?? []) delete preAnswers[key];
  const ceilingUsd = change.budget?.ceilingUsd ?? previous?.budget?.ceilingUsd ?? 0;
  const budget = change.budget
    ? {
        ceilingUsd,
        // Unset, the per-job limit stays, and a lowered ceiling pulls it down with it.
        maxJobUsd: change.budget.maxJobUsd ?? Math.min(previous?.budget?.maxJobUsd ?? ceilingUsd, ceilingUsd),
        allowedProviders: change.budget.allowedProviders ?? previous?.budget?.allowedProviders ?? [],
        allowUserBoundQuotes: change.budget.allowUserBoundQuotes ?? previous?.budget?.allowUserBoundQuotes ?? false,
      }
    : previous?.budget;
  if (budget && budget.maxJobUsd > budget.ceilingUsd)
    throw new PolicyRefusal(`The per-job limit USD ${budget.maxJobUsd} is above the ceiling USD ${budget.ceilingUsd}.`);
  const limits = { ...(previous?.limits ?? {}), ...(change.limits ?? {}) };
  const spendUsd = change.spendUsd ?? previous?.spendUsd;
  const spend = spendUsd ? { spendUsd } : {};
  const words = answer?.trim();
  const draft = {
    revision: (previous?.revision ?? 0) + 1,
    at,
    autonomy: change.autonomy ?? previous?.autonomy ?? "interactive",
    grantedBy: words ? { answer: words, at, ...wordsChannel() } : (previous?.grantedBy ?? { answer: "-", at }),
    ...(budget ? { budget } : {}),
    preAnswers,
    autoPass: change.autoPass ?? previous?.autoPass ?? [],
    finalReviewOnly: change.finalReviewOnly ?? previous?.finalReviewOnly ?? false,
    limits,
    ...spend,
    changes: [] as string[],
  };
  const parsed = PolicyRevisionSchema.safeParse(draft);
  if (!parsed.success)
    throw new PolicyRefusal(
      `The policy change does not validate: ${parsed.error.issues[0]?.path.join(".") || "root"}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  const revision = parsed.data;
  const widened = widenings(previous, revision);
  if (widened.length && !words)
    throw new PolicyRefusal(
      `This change widens what runs without asking (${widened.join("; ")}): it needs the user's own words. Ask them, then pass --answer "<the user's words>". Lowering or removing needs no answer.`,
    );
  if (!previous && !words)
    throw new PolicyRefusal("The first policy needs the user's own words: --answer \"<the user's words>\".");
  revision.changes = widened.length ? widened : ["narrowed or unchanged"];
  const policy: ProjectPolicy = {
    schemaVersion: 1,
    projectId,
    revisions: [...(existing?.revisions ?? []), revision],
  };
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`);
  renameSync(temporary, file);
  return { policy, revision, widened };
}
