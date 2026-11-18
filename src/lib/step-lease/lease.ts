/**
 * Step lease core: paths, reading and writing, the chain hash and the admission predicate shared by
 * runScript, the MCP bridge and the reports. It imports neither the film chain nor the command registry,
 * so every CLI can load it cheaply (docs/step-lease.md).
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  StepLeaseSchema,
  StepUnlockSchema,
  StepViolationSchema,
  type StepLease,
  type StepUnlock,
  type StepViolation,
} from "../../types/step-lease";

export const LEASE_TTL_MS = 2 * 60 * 60 * 1000;
export const UNLOCK_MAX_MINUTES = 240;
export const SESSION_DIR = "pipeline/session";

/**
 * Next-step, status and sealing commands: always admitted, even on a stale or expired lease, so "run pnpm next"
 * can be followed (film:done checks its own step against the files).
 */
export const ALWAYS_ADMITTED = [
  "next",
  "film:next",
  "film:status",
  "film:brief",
  "film:done",
  "footage:next",
  "step:unlock",
  "step:violations",
  // The user's own controls over an autonomous run: narrowing the policy or revoking a decision is never out of step.
  "film:policy",
  "film:revert",
  // Studio console (RFC 0004): the user's pause/stop and the agent's wait for the user are never out of step.
  "console",
  "console:wait",
  "console:control",
  // The user's per-job cancel after a stop (D12): never out of step, and admitted while stopped.
  "job:cancel",
] as const;

/** Every lease also allows these: reading, the user's feedback, memory, the library and code checks. */
export const CONTROL_ALIASES = [
  ...ALWAYS_ADMITTED,
  "film:route",
  "feedback",
  "memory",
  // The user's rating of a styleframe or reference (RFC 0004 WP9): their own record, like feedback.
  "ref:rate",
  "library:list",
  "library:preview",
  "playbook",
  "commands",
  "budget",
  "cost:report",
  "lint",
  "typecheck",
  "console:card",
  // A read-only static snapshot of the console view (RFC 0004 WP15, D18).
  "console:snapshot",
] as const;

export type GuardMode = "off" | "warn" | "enforce";
/** Why the guard runs in its mode: the explicit variable, the project's autonomous policy, a benchmark run, or the default. */
export type GuardModeSource = "env" | "policy" | "benchmark" | "default";

/** `AGENTBROS_STEP_GUARD=warn|enforce|off` when set to one of those, else undefined (the project decides). */
export function explicitGuardMode(env: NodeJS.ProcessEnv = process.env): GuardMode | undefined {
  const value = (env.AGENTBROS_STEP_GUARD ?? "").trim().toLowerCase();
  return value === "off" || value === "enforce" || value === "warn" ? value : undefined;
}

/** The variable alone, without a project: unset is warn. The guard itself resolves effectiveGuardMode (guard.ts). */
export const guardMode = (env: NodeJS.ProcessEnv = process.env): GuardMode => explicitGuardMode(env) ?? "warn";

const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const projectDirOf = (rootDir: string, project: string) => path.join(rootDir, "public", "projects", project);
export const leaseFile = (projectDir: string) => path.join(projectDir, SESSION_DIR, "lease.json");
export const unlocksFile = (projectDir: string) => path.join(projectDir, SESSION_DIR, "unlocks.jsonl");
export const violationsFile = (projectDir: string) => path.join(projectDir, SESSION_DIR, "violations.jsonl");

/** The project a CLI operates on: `--project X` or `--project=X`; undefined without one or with an invalid id. */
export function projectFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const value = token === "--project" ? argv[i + 1] : token.startsWith("--project=") ? token.slice(10) : undefined;
    if (value !== undefined) return PROJECT_ID.test(value) && value.length <= 128 ? value : undefined;
  }
  return undefined;
}

/** A planning run: --dry-run, --dry-run=true or --dry-run=1 (the MCP bridge passes --dry-run=true). */
export const isDryRun = (argv: readonly string[]): boolean =>
  argv.some((token) => token === "--dry-run" || token === "--dry-run=true" || token === "--dry-run=1");

/** The pnpm aliases a command line names: `pnpm x`, `pnpm run x`, across `&&`, `;`, pipes and labels like "Scribe: ". */
export function aliasesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s;&|(`"'])pnpm\s+(?:run\s+)?([a-z][a-z0-9]*(?:[:-][a-z0-9]+)*)/g)) {
    const alias = match[1]!;
    if (!["exec", "dlx", "install", "add", "i"].includes(alias) && !found.includes(alias)) found.push(alias);
  }
  return found;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * What a lease is bound to. Film: the chain's receipts (pipeline/chain, without fixer-rounds.json), approvals and
 * skips, so an approval, a seal or a skip makes the lease stale. Footage: the goals and the playbook binding.
 */
export function chainHash(projectDir: string, route: StepLease["route"]): string {
  const pipeline = path.join(projectDir, "pipeline");
  const files =
    route === "film"
      ? ["chain", "approvals", "skips"].flatMap((dir) => {
          const full = path.join(pipeline, dir);
          if (!existsSync(full)) return [];
          return readdirSync(full)
            .filter((name) => name.endsWith(".json") && name !== "fixer-rounds.json")
            .map((name) => `${dir}/${name}`);
        })
      : ["footage-goals.json", "playbook.json"].filter((name) => existsSync(path.join(pipeline, name)));
  const lines = files.sort().map((file) => `${file}\0${sha256(readFileSync(path.join(pipeline, file)))}`);
  return sha256(`${route}\n${lines.join("\n")}`);
}

const readJsonl = <T>(file: string, parse: (value: unknown) => T | undefined): T[] => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const value = parse(JSON.parse(line));
        return value === undefined ? [] : [value];
      } catch {
        return [];
      }
    });
};

export type LoadedLease = { lease: StepLease; hash: string } | { invalid: string; hash: string };

/** The lease and the hash of its bytes, an unreadable one as `invalid` (fails closed), or undefined without a file. */
export function readLease(projectDir: string): LoadedLease | undefined {
  const file = leaseFile(projectDir);
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  const hash = sha256(bytes);
  try {
    const parsed = StepLeaseSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    return parsed.success ? { lease: parsed.data, hash } : { invalid: parsed.error.message, hash };
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error), hash };
  }
}

/** Atomic write: parallel fan-out briefs never see a half-written lease. */
export function writeLease(projectDir: string, lease: StepLease): string {
  const file = leaseFile(projectDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const parsed = StepLeaseSchema.parse(lease);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`);
  renameSync(temp, file);
  return file;
}

/** Removes the lease, only when it is for `step` (when given). Returns whether one was removed. */
export function clearLease(projectDir: string, step?: string): boolean {
  const loaded = readLease(projectDir);
  if (!loaded) return false;
  if (step !== undefined && "lease" in loaded && loaded.lease.step !== step) return false;
  rmSync(leaseFile(projectDir), { force: true });
  return true;
}

export const readUnlocks = (projectDir: string): StepUnlock[] =>
  readJsonl(unlocksFile(projectDir), (value) => {
    const parsed = StepUnlockSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });

export const activeUnlock = (projectDir: string, now: Date = new Date()): StepUnlock | undefined =>
  readUnlocks(projectDir)
    .filter((unlock) => Date.parse(unlock.at) <= now.getTime() && now.getTime() < Date.parse(unlock.until))
    .at(-1);

export function writeUnlock(projectDir: string, options: { reason: string; minutes: number; now?: Date }): StepUnlock {
  const reason = options.reason.trim();
  if (!reason) throw new Error("An unlock needs a reason.");
  if (!Number.isFinite(options.minutes) || options.minutes <= 0 || options.minutes > UNLOCK_MAX_MINUTES)
    throw new Error(`--minutes must be between 1 and ${UNLOCK_MAX_MINUTES}.`);
  const now = options.now ?? new Date();
  const loaded = readLease(projectDir);
  const unlock: StepUnlock = StepUnlockSchema.parse({
    at: now.toISOString(),
    until: new Date(now.getTime() + options.minutes * 60_000).toISOString(),
    reason,
    ...(loaded && "lease" in loaded ? { step: loaded.lease.step } : {}),
  });
  mkdirSync(path.dirname(unlocksFile(projectDir)), { recursive: true });
  appendFileSync(unlocksFile(projectDir), `${JSON.stringify(unlock)}\n`);
  return unlock;
}

export const readViolations = (projectDir: string): StepViolation[] =>
  readJsonl(violationsFile(projectDir), (value) => {
    const parsed = StepViolationSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });

export function recordViolation(projectDir: string, violation: StepViolation): void {
  try {
    mkdirSync(path.dirname(violationsFile(projectDir)), { recursive: true });
    appendFileSync(violationsFile(projectDir), `${JSON.stringify(StepViolationSchema.parse(violation))}\n`);
  } catch {
    // A record that cannot be written never stops the command; the guard's verdict stands.
  }
}

export type ViolationCount = { count: number; outOfStep: number; refused: number };
export type ViolationsSummary = {
  total: number;
  /** Runs no step:unlock covered: the number that decides `clean`. */
  outOfStep: number;
  unlocked: number;
  refused: number;
  /** No out-of-step run without an unlock: the allow lists fit how the project was really run. */
  clean: boolean;
  first?: string;
  last?: string;
  byMode: Record<"warn" | "enforce", number>;
  byStep: ({ step: string } & ViolationCount)[];
  byCommand: ({ alias: string } & ViolationCount)[];
  byCode: ({ code: StepViolation["code"] } & ViolationCount)[];
  /** One row per step, command and code, most frequent first. */
  rows: ({ step: string; alias: string; code: StepViolation["code"]; last: string } & ViolationCount)[];
};

/** violations.jsonl summed by step, command and code (step:violations); `since` keeps runs at or after an ISO time. */
export function summariseViolations(violations: readonly StepViolation[], since?: string): ViolationsSummary {
  const from = since ? Date.parse(since) : Number.NaN;
  const kept = Number.isNaN(from) ? violations : violations.filter((entry) => Date.parse(entry.at) >= from);
  const group = (key: (entry: StepViolation) => string) => {
    const groups = new Map<string, ViolationCount & { last: string; sample: StepViolation }>();
    for (const entry of kept) {
      const id = key(entry);
      const row = groups.get(id) ?? { count: 0, outOfStep: 0, refused: 0, last: entry.at, sample: entry };
      row.count += 1;
      if (!entry.unlocked) row.outOfStep += 1;
      if (entry.refused) row.refused += 1;
      if (entry.at > row.last) row.last = entry.at;
      groups.set(id, row);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
  };
  const counts = ({ count, outOfStep, refused }: ViolationCount): ViolationCount => ({ count, outOfStep, refused });
  const outOfStep = kept.filter((entry) => !entry.unlocked).length;
  const times = kept.map((entry) => entry.at).sort();
  return {
    total: kept.length,
    outOfStep,
    unlocked: kept.length - outOfStep,
    refused: kept.filter((entry) => entry.refused).length,
    clean: outOfStep === 0,
    ...(times.length ? { first: times[0], last: times.at(-1) } : {}),
    byMode: {
      warn: kept.filter((entry) => entry.mode === "warn").length,
      enforce: kept.filter((entry) => entry.mode === "enforce").length,
    },
    byStep: group((entry) => entry.step).map((row) => ({ step: row.sample.step, ...counts(row) })),
    byCommand: group((entry) => entry.alias).map((row) => ({ alias: row.sample.alias, ...counts(row) })),
    byCode: group((entry) => entry.code).map((row) => ({ code: row.sample.code, ...counts(row) })),
    rows: group((entry) => JSON.stringify([entry.step, entry.alias, entry.code])).map((row) => ({
      step: row.sample.step,
      alias: row.sample.alias,
      code: row.sample.code,
      last: row.last,
      ...counts(row),
    })),
  };
}

/** Out-of-step runs no unlock covered, for film:status and reviews. */
export function stepGuardReport(projectDir: string): { outOfStep: number; recent: StepViolation[] } | undefined {
  const uncovered = readViolations(projectDir).filter((violation) => !violation.unlocked);
  return uncovered.length ? { outOfStep: uncovered.length, recent: uncovered.slice(-5) } : undefined;
}

// --- Admission ---

export type AdmissionInput = {
  lease: StepLease;
  leaseHash: string;
  /** The aliases the running script answers to (several aliases may share one script). */
  aliases: readonly string[];
  /** The registry's spend for that script: the highest of its aliases. */
  spend: "none" | "may-spend" | "paid";
  dryRun: boolean;
  /** The chain hash now. */
  currentHash: string;
  now: Date;
  /** AGENTBROS_STEP_ADMITTED from an admitted parent. */
  nested?: string;
  unlock?: StepUnlock;
  /** A budget ceiling exists now (for leases with paidWhen: budget-ceiling). */
  budgetCeiling?: boolean;
};

export type Admission =
  | { admitted: true; via: "control" | "nested" | "lease"; alias: string }
  | { admitted: true; via: "unlock"; alias: string; code: StepViolation["code"] }
  | { admitted: false; code: StepViolation["code"]; alias: string; reason: string };

const may = (lease: StepLease, budgetCeiling?: boolean) =>
  lease.paidAllowed || (lease.paidWhen === "budget-ceiling" && budgetCeiling === true);

/** The step guard's predicate. Order: control set, nested admission, expiry, staleness, the allow list, spend; an active unlock admits all but spend. */
export function admit(input: AdmissionInput): Admission {
  const { lease } = input;
  const always = input.aliases.find((alias) => (ALWAYS_ADMITTED as readonly string[]).includes(alias));
  if (always) return { admitted: true, via: "control", alias: always };
  const allowed = input.aliases.find((alias) => lease.allow.includes(alias));
  const alias = allowed ?? input.aliases[0] ?? "unknown";
  if (input.nested && input.nested === input.leaseHash) return { admitted: true, via: "nested", alias };
  const spendRefused = input.spend !== "none" && !input.dryRun && !may(lease, input.budgetCeiling);
  if (spendRefused)
    return {
      admitted: false,
      code: "paid",
      alias,
      reason: `\`pnpm ${alias}\` may spend, and step ${lease.step} has no user approval for spending (${lease.paidWhen === "budget-ceiling" ? "no budget ceiling raised with the user's words" : lease.step === "material" ? "the user has not approved this material.json" : "this step's chain has no spend approval"}); run it with --dry-run to plan`,
    };
  const problem: { code: StepViolation["code"]; reason: string } | undefined =
    input.now.getTime() >= Date.parse(lease.expiresAt)
      ? { code: "expired", reason: `the lease for step ${lease.step} expired at ${lease.expiresAt}` }
      : input.currentHash !== lease.chainHash
        ? {
            code: "stale",
            reason: `the chain changed since the lease for step ${lease.step} was issued (a step was sealed, approved or skipped)`,
          }
        : !allowed
          ? { code: "not-in-step", reason: `\`pnpm ${alias}\` is not a tool of step ${lease.step}` }
          : undefined;
  if (!problem) return { admitted: true, via: "lease", alias };
  if (input.unlock) return { admitted: true, via: "unlock", alias, code: problem.code };
  return { admitted: false, alias, ...problem };
}

const SOURCE_LABEL: Partial<Record<GuardModeSource, string>> = {
  policy: "the project's autonomous policy",
  benchmark: "a benchmark run",
};

/** "warn", or "enforce, the project's autonomous policy": the mode and, when the project set it, why. */
export const modeLabel = (mode: GuardMode, source?: GuardModeSource): string =>
  source && SOURCE_LABEL[source] ? `${mode}, ${SOURCE_LABEL[source]}` : mode;

/** The refusal or warning text: step, owner, what is allowed, the next command and the escape hatch. */
export function guardMessage(
  lease: StepLease,
  admission: { reason: string },
  mode: GuardMode,
  source?: GuardModeSource,
): string {
  const allowed = lease.allow.filter((alias) => !(CONTROL_ALIASES as readonly string[]).includes(alias));
  return [
    `Step guard (${modeLabel(mode, source)}): ${admission.reason}.`,
    `Project ${lease.project} is at step ${lease.step} (owner ${lease.owner}, role ${lease.role}).`,
    `Allowed now: ${allowed.length ? allowed.join(", ") : "(no step tools)"} plus control commands (${ALWAYS_ADMITTED.join(", ")}, feedback, memory, library:list, ...).`,
    `Run \`pnpm next --project ${lease.project}\` for the current step.`,
    `If this run is intended: \`pnpm step:unlock --project ${lease.project} --reason "<why>" [--minutes 30]\` (spend still needs the user's approval); for manual work AGENTBROS_STEP_GUARD=off.`,
  ].join(" ");
}

export const leaseHashOf = (projectDir: string): string | undefined => readLease(projectDir)?.hash;
