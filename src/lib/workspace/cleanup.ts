import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, assertPathWithin, isReservedProjectId, reservedProjectReason } from "../cli";
import { noteRemoved } from "../memory/capture";
import { PROJECT_STATE_CACHES, projectFootprint } from "../pipeline/paths";
import { campaignRemovalBlockers } from "../campaigns/production/store";
import { STUDIO_DIR, listStates, logFileOf, psInfo, stateFileOf, studioProcess } from "../console/studio";
import { JournalCache } from "../console/view/activity";
import type { ConsoleEvent } from "../../types/console";

export const CLEANUP_SCOPES = ["projects", "renders", "bundles", "qa", "cache", "memory"] as const;
export type CleanupScope = (typeof CLEANUP_SCOPES)[number];
/** What `--scope all` means: the user's memory is never part of it and must be named. */
export const ALL_SCOPES: readonly CleanupScope[] = CLEANUP_SCOPES.filter((scope) => scope !== "memory");

export type CleanupTarget = {
  path: string;
  scope: CleanupScope;
  bytes: number;
  files: number;
  trackedFiles: number;
  blockedBy: string[];
};

export type CleanupPlan = {
  targets: CleanupTarget[];
  totalBytes: number;
  blocked: string[];
  /** Entries left alone on purpose, with the reason (a reserved project id such as `console`). */
  skipped?: { path: string; reason: string }[];
};

const PROJECTS_ROOT = path.join("public", "projects");
const SOURCES_ROOT = path.join("src", "projects");
const QA_ROOT = path.join("out", "qa");
const QA_INFERENCE_RUNTIME = path.join(QA_ROOT, "offline-inference", "runtime");
const MEMORY_ROOT = "memory";
const MEMORY_RULES = path.join(MEMORY_ROOT, "AGENTS.md");
const USAGE_ROOT = path.join(MEMORY_ROOT, "usage");
/** memory/usage/<id>.json is a project's record of library blocks: part of its footprint, removed with the project. */
const usageRecordId = (entry: string): string | undefined => {
  const normalised = path.normalize(entry);
  return path.dirname(normalised) === USAGE_ROOT && normalised.endsWith(".json")
    ? path.basename(normalised, ".json")
    : undefined;
};
const TERMINAL_JOB_STATES = ["published", "cancelled", "failed"];

// Dotfiles such as .gitkeep and .DS_Store are not generated data.
const children = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => !name.startsWith("."))
        .sort()
    : [];
const isDirectory = (entry: string): boolean => lstatSync(entry).isDirectory();

function measure(entry: string): { bytes: number; files: number } {
  const stat = lstatSync(entry);
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
  const total = { bytes: 0, files: 0 };
  for (const name of readdirSync(entry)) {
    const nested = measure(path.join(entry, name));
    total.bytes += nested.bytes;
    total.files += nested.files;
  }
  return total;
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && existsSync(".git"))
    throw new CliErrorObject({ code: "VALIDATION", message: "Could not check tracked files. Cleanup refused." });
  return result.status === 0 ? result.stdout : "";
}

/** Paid operations that are not settled must stay reconcilable, so their ledger cannot be deleted. */
function unsettledOperations(entry: string): string[] {
  const file = path.join(entry, "pipeline", "operations.json");
  if (!existsSync(file)) return [];
  try {
    const database = JSON.parse(readFileSync(file, "utf8")) as {
      jobs?: Record<string, { state?: string; reservedMicros?: number }>;
    };
    const blocked: string[] = [];
    const pendingBilling: string[] = [];
    for (const [id, job] of Object.entries(database.jobs ?? {})) {
      if (!TERMINAL_JOB_STATES.includes(String(job.state)))
        blocked.push(`Paid operation ${id} is still open (${job.state}). Finish or cancel it before deleting.`);
      else if ((job.reservedMicros ?? 0) > 0) pendingBilling.push(`${id} (${job.state})`);
    }
    if (pendingBilling.length)
      blocked.push(
        [
          "Billing is still pending for the operations below. Reconcile the provider records with pnpm budget before deleting.",
          ...pendingBilling,
        ].join("\n"),
      );
    return blocked;
  } catch {
    return [`cannot read ${file}`];
  }
}

function activeCommands(directory: string): string[] {
  const running = new Map<string, ConsoleEvent>();
  for (const event of new JournalCache(directory).read()) {
    if (!event.runId) continue;
    if (event.kind === "cli.start") running.set(event.runId, event);
    if (event.kind === "cli.end") running.delete(event.runId);
  }
  return [...running.values()].flatMap((event) => {
    const pid = event.data?.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) return [];
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return [];
    }
    const info = psInfo(pid);
    if (info && info.startedAt > Date.parse(event.at)) return [];
    return [`Project command ${event.alias ?? "CLI"} is still running (PID ${pid}).`];
  });
}

function allowedRoot(entry: string): string {
  return entry.startsWith(`${PROJECTS_ROOT}${path.sep}`)
    ? PROJECTS_ROOT
    : entry.startsWith(`${SOURCES_ROOT}${path.sep}`)
      ? SOURCES_ROOT
      : entry.split(path.sep)[0]!;
}

/** The user's memory is removed only by the `memory` scope, and its tracked rules never; a project's usage record goes with the project. */
export function memoryGuard(entry: string, scope: CleanupScope): string[] {
  const normalised = path.normalize(entry).replace(/[\\/]+$/, "");
  if (normalised === MEMORY_RULES || MEMORY_RULES.startsWith(`${normalised}${path.sep}`))
    return [`${MEMORY_RULES} is never removed`];
  if (scope === "projects" && usageRecordId(normalised)) return [];
  if (normalised.startsWith(`${MEMORY_ROOT}${path.sep}`) && scope !== "memory")
    return ["the user's memory is removed only by --scope memory"];
  return [];
}

function buildPlan(candidates: Map<string, CleanupScope>, allowTracked: boolean): CleanupPlan {
  const paths = [...candidates.keys()].sort();
  // A directory that is already selected covers everything nested inside it.
  const outermost = paths.filter((entry) => !paths.some((other) => entry.startsWith(`${other}${path.sep}`)));
  const targets = outermost.map((entry): CleanupTarget => {
    const blockedBy: string[] = [];
    const scope = candidates.get(entry)!;
    try {
      assertPathWithin(process.cwd(), entry);
      assertPathWithin(allowedRoot(entry), entry);
      if (scope === "projects" && realpathSync(entry) !== path.join(realpathSync(process.cwd()), entry))
        throw new Error("Project footprint must not traverse a symlink.");
    } catch (error) {
      return { path: entry, scope, bytes: 0, files: 0, trackedFiles: 0, blockedBy: [(error as Error).message] };
    }
    const trackedFiles = git(["ls-files", "-z", "--", entry]).split("\0").filter(Boolean).length;
    if (trackedFiles > 0 && !allowTracked)
      blockedBy.push(`${trackedFiles} files are tracked by Git; pass --allow-tracked to remove them`);
    const modified = git(["status", "--porcelain", "-z", "--", entry])
      .split("\0")
      .filter((line) => line && !line.startsWith("??")).length;
    if (modified > 0) blockedBy.push(`${modified} tracked files have uncommitted changes`);
    if (entry.startsWith(`${PROJECTS_ROOT}${path.sep}`))
      blockedBy.push(...unsettledOperations(entry), ...campaignRemovalBlockers(process.cwd(), path.basename(entry)));
    blockedBy.push(...memoryGuard(entry, scope));
    return { path: entry, scope, ...measure(entry), trackedFiles, blockedBy };
  });
  return {
    targets,
    totalBytes: targets.reduce((sum, target) => sum + target.bytes, 0),
    blocked: targets.flatMap((target) => target.blockedBy.map((reason) => `${target.path}: ${reason}`)),
  };
}

export function planProjectRemoval(id: string, options: { allowTracked?: boolean } = {}): CleanupPlan {
  const candidates = new Map<string, CleanupScope>();
  for (const entry of projectFootprint(id))
    if (lstatSync(entry, { throwIfNoEntry: false })) candidates.set(entry, "projects");
  if (candidates.size === 0)
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project "${id}" has no files on disk.` });
  const root = realpathSync(process.cwd());
  const studioDir = path.join(root, STUDIO_DIR);
  if (existsSync(studioDir) && realpathSync(studioDir) !== studioDir)
    throw new CliErrorObject({ code: "VALIDATION", message: "The Studio state directory must not be a symlink." });
  const studios = listStates(root).filter((state) => state.project === id);
  for (const studio of studios)
    for (const file of [stateFileOf(root, studio.key), logFileOf(root, studio.key)])
      if (lstatSync(file, { throwIfNoEntry: false })) candidates.set(path.relative(root, file), "projects");
  const plan = buildPlan(candidates, options.allowTracked ?? false);
  const projectDir = path.join(PROJECTS_ROOT, id);
  const index = plan.targets.findIndex((target) => target.path === projectDir);
  if (index >= 0) {
    if (!plan.blocked.length) plan.blocked.push(...activeCommands(path.join(root, projectDir)));
    // Keep the project visible for retry if a different part of the footprint cannot be removed.
    plan.targets.push(plan.targets.splice(index, 1)[0]!);
  }
  if (studios.some((studio) => ["ours", "unknown"].includes(studioProcess(studio))))
    plan.blocked.push("Close Remotion Studio for this project before deleting it.");
  return plan;
}

export function planWorkspaceClean(options: {
  scopes: CleanupScope[];
  keep?: string[];
  allowTracked?: boolean;
  includeRuntime?: boolean;
}): CleanupPlan {
  const keep = new Set(options.keep ?? []);
  const skipped: { path: string; reason: string }[] = [];
  const projectIds = [...new Set([...children(PROJECTS_ROOT), ...children(SOURCES_ROOT)])].filter((id) => {
    const entries = [path.join(PROJECTS_ROOT, id), path.join(SOURCES_ROOT, id)].filter(
      (entry) => existsSync(entry) && isDirectory(entry),
    );
    if (entries.length && isReservedProjectId(id)) {
      if (options.scopes.includes("projects"))
        for (const entry of entries) skipped.push({ path: entry, reason: reservedProjectReason(id) });
      return false;
    }
    return entries.length > 0;
  });
  const unknown = [...keep].filter((id) => !projectIds.includes(id) && !existsSync(path.join("out", id)));
  if (unknown.length > 0)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown --keep entries: ${unknown.join(", ")}` });

  const candidates = new Map<string, CleanupScope>();
  const add = (entry: string, scope: CleanupScope) => {
    if (existsSync(entry) && !candidates.has(entry)) candidates.set(entry, scope);
  };
  // out/qa is QA evidence and out/console the studio console's journal, lock and cache (RFC 0004): neither is a render.
  const outputs = children("out").filter((name) => name !== "qa" && !isReservedProjectId(name));

  if (options.scopes.includes("projects")) {
    for (const id of projectIds) if (!keep.has(id)) for (const entry of projectFootprint(id)) add(entry, "projects");
    // A usage record whose project is already gone is footprint left behind.
    for (const name of children(USAGE_ROOT)) {
      const id = usageRecordId(path.join(USAGE_ROOT, name));
      if (id && !keep.has(id) && !projectIds.includes(id)) add(path.join(USAGE_ROOT, name), "projects");
    }
  }
  if (options.scopes.includes("renders")) {
    for (const name of outputs) if (!keep.has(name)) add(path.join("out", name), "renders");
  }
  if (options.scopes.includes("bundles")) {
    // Bundles are rebuilt on demand, so --keep does not protect them.
    for (const name of outputs) add(path.join("out", name, "bundle"), "bundles");
  }
  if (options.scopes.includes("qa")) {
    const protectedPaths = options.includeRuntime ? [] : [QA_INFERENCE_RUNTIME];
    const addQa = (dir: string) => {
      for (const name of children(dir)) {
        const entry = path.join(dir, name);
        if (protectedPaths.includes(entry)) continue;
        if (protectedPaths.some((kept) => kept.startsWith(`${entry}${path.sep}`))) addQa(entry);
        else add(entry, "qa");
      }
    };
    addQa(QA_ROOT);
  }
  if (options.scopes.includes("cache")) {
    for (const name of children(".cache"))
      if (!PROJECT_STATE_CACHES.includes(name)) add(path.join(".cache", name), "cache");
  }
  if (options.scopes.includes("memory")) {
    for (const name of children(MEMORY_ROOT))
      if (path.join(MEMORY_ROOT, name) !== MEMORY_RULES) add(path.join(MEMORY_ROOT, name), "memory");
  }
  const plan = buildPlan(candidates, options.allowTracked ?? false);
  return skipped.length ? { ...plan, skipped } : plan;
}

/** Removes nothing unless every target is clear, so a refusal never leaves a half-cleaned workspace. */
export function applyCleanup(plan: CleanupPlan): void {
  if (plan.blocked.length > 0) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Cleanup refused: ${plan.blocked.length} blocking ${plan.blocked.length === 1 ? "issue" : "issues"}.`,
      details: { blocked: plan.blocked },
    });
  }
  for (const target of plan.targets) rmSync(target.path, { recursive: true, force: true });
  // An append-only tombstone, so a later project reusing the id does not inherit this one's metrics.
  for (const id of removedProjects(plan)) noteRemoved(id);
}

/** Projects whose public/projects/<id> or src/projects/<id> this plan removes. */
export function removedProjects(plan: CleanupPlan): string[] {
  const ids = plan.targets.flatMap((target) => {
    if (target.scope !== "projects") return [];
    const parent = path.dirname(path.normalize(target.path));
    return parent === PROJECTS_ROOT || parent === SOURCES_ROOT ? [path.basename(target.path)] : [];
  });
  return [...new Set(ids)].sort();
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function cleanupResult(
  plan: CleanupPlan,
  dryRun: boolean,
): { outputs: string[]; metadata: Record<string, unknown> } {
  return {
    outputs: dryRun ? [] : plan.targets.map((target) => target.path),
    metadata: {
      dryRun,
      totalBytes: plan.totalBytes,
      totalSize: formatBytes(plan.totalBytes),
      targets: plan.targets,
      blocked: plan.blocked,
      ...(plan.skipped?.length ? { skipped: plan.skipped } : {}),
    },
  };
}
