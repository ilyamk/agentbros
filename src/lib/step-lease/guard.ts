/**
 * The step guard: maps a running script (or an MCP tool) to its registry entries and applies the lease's
 * predicate. runScript loads this module only when the project it operates on has a lease (docs/step-lease.md).
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { COMMAND_REGISTRY, commandByMcpTool, type CommandEntry, type CommandSpend } from "../cli/commands";
import { autonomousPolicy } from "../film/autonomy";
import { PROXY_KINDS } from "../film/state";
import {
  activeUnlock,
  admit,
  chainHash,
  explicitGuardMode,
  guardMessage,
  isDryRun,
  modeLabel,
  projectDirOf,
  projectFromArgv,
  readLease,
  recordViolation,
  type Admission,
  type GuardMode,
  type GuardModeSource,
} from "./lease";
import type { StepLease, StepViolation } from "../../types/step-lease";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RANK: Record<CommandSpend, number> = { none: 0, "may-spend": 1, paid: 2 };

/** Every registry entry that runs this repository-relative script (several aliases may share one). */
export const entriesForScript = (script: string): CommandEntry[] =>
  COMMAND_REGISTRY.filter((entry) => entry.script === script && entry.alias);

/** The highest spend among the entries. */
export const spendOf = (entries: readonly CommandEntry[]): CommandSpend =>
  entries.reduce<CommandSpend>((most, entry) => (RANK[entry.paid] > RANK[most] ? entry.paid : most), "none");

/** The repository-relative script of a process.argv[1], or undefined outside the repository. */
export function scriptOf(entry: string | undefined, repoRoot: string = REPO_ROOT): string | undefined {
  if (!entry) return undefined;
  let file = path.resolve(entry);
  try {
    file = realpathSync(file);
  } catch {
    // keep the resolved path
  }
  let root = repoRoot;
  try {
    root = realpathSync(repoRoot);
  } catch {
    // keep the given root
  }
  const relative = path.relative(root, file);
  return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : relative.split(path.sep).join("/");
}

/** A budget ceiling above zero exists (pipeline/operations.json policy.ceilingUsd), set only with the user's words. */
export function budgetCeiling(projectDir: string): boolean {
  const file = path.join(projectDir, "pipeline", "operations.json");
  if (!existsSync(file)) return false;
  try {
    const ceiling = (JSON.parse(readFileSync(file, "utf8")) as { policy?: { ceilingUsd?: unknown } }).policy
      ?.ceilingUsd;
    return typeof ceiling === "number" && ceiling > 0;
  } catch {
    return false;
  }
}

/** A `film:approve --proxy benchmark` decision is on file (pipeline/approvals/<step>.json): the project is a benchmark run. */
export function benchmarkProxyRun(projectDir: string): boolean {
  const dir = path.join(projectDir, "pipeline", "approvals");
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .some((name) => {
      try {
        const events = (JSON.parse(readFileSync(path.join(dir, name), "utf8")) as { events?: unknown }).events;
        return (
          Array.isArray(events) &&
          events.some((event) => (event as { proxy?: unknown } | null)?.proxy === PROXY_KINDS.benchmark)
        );
      } catch {
        return false;
      }
    });
}

export type EffectiveGuardMode = { mode: GuardMode; source: GuardModeSource };

/**
 * The guard's mode for a project: AGENTBROS_STEP_GUARD when set; otherwise enforce when the project runs
 * autonomously (a standing autonomous policy in pipeline/policy.json) or as a benchmark (a `--proxy benchmark`
 * approval on file, or a launch with AGENTBROS_INTERACTION_MODE=autonomous, as the bench harness does); else warn.
 */
export function effectiveGuardMode(projectDir: string, env: NodeJS.ProcessEnv = process.env): EffectiveGuardMode {
  const explicit = explicitGuardMode(env);
  if (explicit) return { mode: explicit, source: "env" };
  if (autonomousPolicy(projectDir)) return { mode: "enforce", source: "policy" };
  if ((env.AGENTBROS_INTERACTION_MODE ?? "").trim().toLowerCase() === "autonomous" || benchmarkProxyRun(projectDir))
    return { mode: "enforce", source: "benchmark" };
  return { mode: "warn", source: "default" };
}

export type StepCheck =
  | { verdict: "none" }
  | {
      verdict: "admitted" | "warn" | "refuse";
      mode: GuardMode;
      /** Why that mode (effectiveGuardMode). */
      source: GuardModeSource;
      admission: Admission;
      leaseHash: string;
      lease?: StepLease;
      message?: string;
    };

/** The shared check: no lease or mode off is "none"; otherwise the predicate, with the violation recorded. */
export function checkStep(options: {
  rootDir: string;
  project: string;
  entries: readonly CommandEntry[];
  dryRun: boolean;
  via: "cli" | "mcp";
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** What to append to violations.jsonl: everything (default), refusals only (the MCP bridge leaves warnings to the child's runScript), or nothing. */
  record?: "all" | "refusals" | "none";
}): StepCheck {
  const env = options.env ?? process.env;
  if (explicitGuardMode(env) === "off" || !options.entries.length) return { verdict: "none" };
  const projectDir = projectDirOf(options.rootDir, options.project);
  const loaded = readLease(projectDir);
  if (!loaded) return { verdict: "none" };
  const { mode, source } = effectiveGuardMode(projectDir, env);
  if (mode === "off") return { verdict: "none" };
  const aliases = options.entries.map((entry) => entry.alias!);
  const now = options.now ?? new Date();
  if ("invalid" in loaded) {
    const admission = admit({
      lease: unreadable(options.project),
      leaseHash: loaded.hash,
      aliases,
      spend: spendOf(options.entries),
      dryRun: options.dryRun,
      currentHash: "",
      now,
      ...(env.AGENTBROS_STEP_ADMITTED ? { nested: env.AGENTBROS_STEP_ADMITTED } : {}),
    });
    if (admission.admitted) return { verdict: "admitted", mode, source, admission, leaseHash: loaded.hash };
    const message = `Step guard (${modeLabel(mode, source)}): the lease of project ${options.project} is unreadable (${loaded.invalid.slice(0, 200)}). Run \`pnpm next --project ${options.project}\` to issue it again.`;
    return {
      verdict: mode === "enforce" ? "refuse" : "warn",
      mode,
      source,
      admission,
      leaseHash: loaded.hash,
      message,
    };
  }
  const { lease } = loaded;
  const unlock = activeUnlock(projectDir, now);
  const admission = admit({
    lease,
    leaseHash: loaded.hash,
    aliases,
    spend: spendOf(options.entries),
    dryRun: options.dryRun,
    currentHash: chainHash(projectDir, lease.route),
    now,
    budgetCeiling: lease.paidWhen === "budget-ceiling" ? budgetCeiling(projectDir) : false,
    ...(env.AGENTBROS_STEP_ADMITTED ? { nested: env.AGENTBROS_STEP_ADMITTED } : {}),
    ...(unlock ? { unlock } : {}),
  });
  const base = { mode, source, admission, leaseHash: loaded.hash, lease };
  const recording = options.record ?? "all";
  const record = (refused: boolean, unlocked: boolean, code: StepViolation["code"]) =>
    recordViolation(projectDir, {
      at: now.toISOString(),
      project: options.project,
      step: lease.step,
      owner: lease.owner,
      alias: admission.alias,
      code,
      mode: mode as "warn" | "enforce",
      modeSource: source,
      refused,
      via: options.via,
      ...(unlocked ? { unlocked: true } : {}),
    });
  if (admission.admitted) {
    if (admission.via === "unlock" && recording === "all") record(false, true, admission.code);
    return { verdict: "admitted", ...base };
  }
  const refused = mode === "enforce";
  if (recording === "all" || (refused && recording === "refusals")) record(refused, false, admission.code);
  return { verdict: refused ? "refuse" : "warn", ...base, message: guardMessage(lease, admission, mode, source) };
}

const unreadable = (project: string): StepLease => ({
  schemaVersion: 1,
  project,
  route: "film",
  step: "unknown",
  owner: "unknown",
  role: "orchestrator",
  lanes: [],
  allow: [],
  spending: [],
  paidAllowed: false,
  chainHash: "0".repeat(64),
  issuedAt: new Date(0).toISOString(),
  expiresAt: new Date(0).toISOString(),
  issuedBy: "unknown",
});

/**
 * runScript's guard. Returns a warning for metadata.stepGuard (warn mode) or throws the refusal (enforce mode);
 * after admission sets AGENTBROS_STEP_ADMITTED so the command's own children are admitted.
 */
export function guardCli(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  rootDir: string = process.cwd(),
): { warning?: Record<string, unknown>; refusal?: string } {
  const args = argv.slice(2);
  const project = projectFromArgv(args);
  const script = scriptOf(argv[1]);
  if (!project || !script) return {};
  const check = checkStep({
    rootDir,
    project,
    entries: entriesForScript(script),
    dryRun: isDryRun(args),
    via: "cli",
    env,
  });
  if (check.verdict === "none") return {};
  if (check.verdict === "refuse") return { refusal: check.message! };
  env.AGENTBROS_STEP_ADMITTED = check.leaseHash;
  if (check.verdict === "warn")
    return {
      warning: {
        mode: check.mode,
        source: check.source,
        code: check.admission.admitted ? undefined : check.admission.code,
        message: check.message,
        ...(check.lease ? { step: check.lease.step, owner: check.lease.owner } : {}),
      },
    };
  return {};
}

/**
 * The MCP bridge's guard, before --allow-paid: in enforce mode an out-of-step tool is refused and a spend
 * refusal on a dry-run tool narrows it to --dry-run=true. Returns whether dry-run is forced; throws the refusal.
 */
export function guardTool(
  toolName: string,
  flags: Record<string, unknown>,
  rootDir: string,
  toolPaid: "dry-run" | "blocked" | "local",
  env: NodeJS.ProcessEnv = process.env,
): { forceDryRun: boolean } {
  const project = typeof flags.project === "string" ? flags.project : undefined;
  const entry = commandByMcpTool(toolName);
  if (!project || !entry?.alias || !existsSync(projectDirOf(rootDir, project))) return { forceDryRun: false };
  // Warn mode leaves the warning and its record to the child's runScript; only enforce (explicit or resolved) acts here.
  if (effectiveGuardMode(projectDirOf(rootDir, project), env).mode !== "enforce") return { forceDryRun: false };
  const entries = entry.script ? entriesForScript(entry.script) : [entry];
  const dryRun = flags["dry-run"] === true || flags["dry-run"] === "true";
  // The bridge's own process may carry an admission; a tool call is judged on its own.
  const common = { rootDir, project, entries, via: "mcp" as const, env: { ...env, AGENTBROS_STEP_ADMITTED: "" } };
  const first = checkStep({ ...common, dryRun, record: "none" });
  if (first.verdict !== "refuse") return { forceDryRun: false };
  const narrow = !first.admission.admitted && first.admission.code === "paid" && toolPaid === "dry-run";
  const final = checkStep({ ...common, dryRun: dryRun || narrow, record: "refusals" });
  if (final.verdict !== "refuse") return { forceDryRun: narrow };
  throw new Error(final.message);
}
