/**
 * The event journal writer (RFC 0004 D7, §6.1, §7): one JSON line per event in
 * `public/projects/<id>/pipeline/events.jsonl`, or `out/console/events.jsonl` for the few project-less commands that
 * matter. `runScript` (src/lib/cli) writes `cli.start` at entry, `cli.end` synchronously before `emitResult` exits and
 * a throttled `cli.progress`; `film:brief` writes `agent.dispatch`; the job store writes `job.state`.
 *
 * Rules: a project's journal is written only when `public/projects/<id>/pipeline/` existed when the command started
 * (many commands treat a directory's existence as the project's existence, so the journal never creates one); writing
 * never throws and never fails or slows a command (errors are swallowed and counted, {@link journalStats});
 * `AGENTBROS_EVENTS=off` disables it. The root is the working directory, as for every CLI.
 *
 * Loaded by every CLI, so it imports node builtins and type-only modules only (src/types/console.ts pulls in zod; its
 * constants are mirrored here and checked by tests/console-journal.test.ts).
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { gzipSync } from "node:zlib";
import type { ConsoleEvent, EventKind } from "../../types/console";
import { processAttribution, resolveAttribution, type Actor, type Attribution, type Channel } from "../cli/channel";
import { redactArgv, redactData, redactString, scrubSecrets } from "./redact";
import { ulid } from "./ulid";

export const EVENTS_FILE = "pipeline/events.jsonl";
export const GLOBAL_EVENTS_FILE = "out/console/events.jsonl";
export const EVENTS_ROTATE_BYTES = 10 * 1024 * 1024;
export const PROGRESS_INTERVAL_MS = 2000;
/** Aliases whose project-less runs (or runs before their project exists) go to the global journal (D7). */
export const GLOBAL_ALIASES: readonly string[] = ["playbook", "film:init", "project:new"];
/** Rotated journals: `events.<n>.jsonl.gz` beside the live file. */
export const ROTATED_EVENTS = /^events\.(\d+)\.jsonl\.gz$/;

const ENV = {
  events: "AGENTBROS_EVENTS",
  runId: "AGENTBROS_RUN_ID",
  actor: "AGENTBROS_ACTOR",
  channel: "AGENTBROS_CHANNEL",
} as const;
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CODE_ROOT = path.resolve(import.meta.dirname, "../../..");

// ---------------------------------------------------------------------------
// Switch, counters, destination
// ---------------------------------------------------------------------------

/** `AGENTBROS_EVENTS=off` (or `0`, `false`, `no`) disables the journal; anything else, or unset, enables it. */
export function eventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["off", "0", "false", "no"].includes((env[ENV.events] ?? "").trim().toLowerCase());
}

const stats = { written: 0, errors: 0, lastError: undefined as string | undefined, rotations: 0 };

/** Lines written, swallowed write errors (and the last one's message) and rotations in this process. */
export function journalStats(): { written: number; errors: number; lastError?: string; rotations: number } {
  return { ...stats };
}

/** Test helper: zeroes the counters. */
export function resetJournalStats(): void {
  Object.assign(stats, { written: 0, errors: 0, lastError: undefined, rotations: 0 });
}

const fail = (error: unknown) => {
  stats.errors += 1;
  stats.lastError = error instanceof Error ? error.message : String(error);
  return false;
};

/** Where an event goes and what must already exist for it to be written. */
export type EventTarget = {
  /** Absolute journal file. */
  file: string;
  /** Absolute directory that must still exist at write time (the project directory); never created. */
  requireDir?: string;
  /** Absolute directory that roots relative output paths (the project directory, or the repository root). */
  base: string;
};

/**
 * The project's journal when `public/projects/<id>/pipeline/` exists now as a real directory, else undefined. The
 * journal creates no folder inside a project (a template project without pipeline/ is not journaled), so a command
 * that writes nothing to a project still leaves its tree's shape unchanged.
 */
export function projectTarget(rootDir: string, project: string): EventTarget | undefined {
  if (!PROJECT_ID.test(project) || project.length > 128) return undefined;
  const projectDir = path.resolve(rootDir, "public", "projects", project);
  const pipeline = path.join(projectDir, "pipeline");
  try {
    if (!lstatSync(projectDir, { throwIfNoEntry: false })?.isDirectory()) return undefined;
    if (!lstatSync(pipeline, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return { file: path.join(projectDir, EVENTS_FILE), requireDir: pipeline, base: projectDir };
}

/** The global journal, `out/console/events.jsonl` under the root. */
export function globalTarget(rootDir: string): EventTarget {
  const root = path.resolve(rootDir);
  return { file: path.join(root, GLOBAL_EVENTS_FILE), base: root };
}

// ---------------------------------------------------------------------------
// Writing and rotation
// ---------------------------------------------------------------------------

/** A rotated journal waiting to be compressed: `events.<ulid>.<pid>.rotating`, still plain JSONL (readers read it). */
export const ROTATING_EVENTS = /^events\.[0-9A-Z]{26}\.\d+\.rotating$/;
/** How old a `.rotating` file must be before it is compressed: a writer that opened it just before the rename is done. */
export const ROTATION_SETTLE_MS = 5000;

/**
 * Rotation step one, on the write path: rename the live file to a unique `.rotating` name (atomic; a losing racer gets
 * ENOENT and simply appends to the new live file). A writer that opened the old file just before the rename still
 * lands its line in the `.rotating` file, which stays plain JSONL until {@link finishRotations} compresses it. Then
 * finishes at most one older, settled rotation, so the gzip cost is rare and never on the file just rotated.
 */
function rotate(file: string): void {
  const directory = path.dirname(file);
  try {
    renameSync(file, path.join(directory, `events.${ulid()}.${process.pid}.rotating`));
    stats.rotations += 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; // another writer rotated first
  }
  finishRotations(directory, { limit: 1 });
}

/**
 * Rotation step two: compresses settled `.rotating` files (older than {@link ROTATION_SETTLE_MS}, oldest first) to
 * `events.<n>.jsonl.gz`. A file is deleted only after its archive is written and only when it did not change while it
 * was read; on any failure the partial archive is removed and the `.rotating` file kept for a later try (readers still
 * read it). Safe to call from anywhere (the console server may call it on a timer). Never throws; returns how many
 * files it finished.
 */
export function finishRotations(
  directory: string,
  options: { now?: number; settleMs?: number; limit?: number } = {},
): number {
  let finished = 0;
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => ROTATING_EVENTS.test(name))
      .sort();
  } catch {
    return 0;
  }
  const now = options.now ?? Date.now();
  for (const name of names) {
    if (finished >= (options.limit ?? Infinity)) break;
    const source = path.join(directory, name);
    let archive: string | undefined;
    try {
      const before = statSync(source);
      const settle = options.settleMs ?? ROTATION_SETTLE_MS;
      if (settle > 0 && now - before.mtimeMs < settle) continue; // mtime has sub-millisecond precision
      const packed = gzipSync(readFileSync(source));
      let index =
        readdirSync(directory).reduce(
          (most, entry) => Math.max(most, Number(ROTATED_EVENTS.exec(entry)?.[1] ?? 0)),
          0,
        ) + 1;
      for (;;) {
        try {
          writeFileSync(path.join(directory, `events.${index}.jsonl.gz`), packed, { flag: "wx" });
          archive = path.join(directory, `events.${index}.jsonl.gz`);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          index += 1;
        }
      }
      const after = statSync(source);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        unlinkSync(archive); // a late line arrived: keep the source, try again later
        continue;
      }
      unlinkSync(source);
      finished += 1;
    } catch (error) {
      if (archive)
        try {
          unlinkSync(archive);
        } catch {
          // the partial archive stays; the source is kept either way
        }
      fail(error);
    }
  }
  return finished;
}

/**
 * Appends one event line to the target, rotating the file first when it would pass {@link EVENTS_ROTATE_BYTES}.
 * Creates no directory inside a project (only `out/console/` for the global journal). Never throws:
 * returns false and counts the error instead.
 */
export function appendEvent(target: EventTarget, event: ConsoleEvent, options: { rotateBytes?: number } = {}): boolean {
  try {
    if (target.requireDir && !lstatSync(target.requireDir, { throwIfNoEntry: false })?.isDirectory()) return false;
    const directory = path.dirname(target.file);
    const directoryStat = lstatSync(directory, { throwIfNoEntry: false });
    if (directoryStat?.isSymbolicLink()) throw new Error(`${directory} is a symlink`);
    if (!directoryStat) {
      if (target.requireDir) return false; // never create a folder inside a project
      mkdirSync(directory, { recursive: true });
    }
    const line = `${JSON.stringify(event)}\n`;
    const current = lstatSync(target.file, { throwIfNoEntry: false });
    if (current && !current.isFile()) throw new Error(`${target.file} is not a regular file`);
    if (current && current.size + Buffer.byteLength(line) > (options.rotateBytes ?? EVENTS_ROTATE_BYTES))
      rotate(target.file);
    appendFileSync(target.file, line);
    stats.written += 1;
    return true;
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------
// Event fields from the environment
// ---------------------------------------------------------------------------

/**
 * Actor and channel (D15): `user` and `console` only with a console grant verified for this argv (cli/channel.ts);
 * an unverified env claim falls back to `agent` / `cli` and is kept in cli.start's `data.claimed`. This process's
 * verdict is memoised at runScript's start; another env (tests) is judged on its own. Trusted in-process writers (the
 * server) set `actor` and `channel` in the event input instead.
 */
function attributionFor(env: NodeJS.ProcessEnv, argv?: readonly string[], rootDir?: string): Attribution {
  if (env === process.env && (argv === undefined || argv === process.argv)) return processAttribution();
  return resolveAttribution({ env, argv: argv ?? process.argv, rootDir });
}

/** The harness the command runs under, when it says so in the environment (best effort). */
function harnessOf(env: NodeJS.ProcessEnv): ConsoleEvent["agent"] | undefined {
  if (env.CLAUDECODE === "1") return { harness: "claude-code" };
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) return { harness: "codex" };
  return undefined;
}

/** The first `--project` value of argv when it is a valid project id (as runScript's step guard reads it). */
export function projectFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const value = token === "--project" ? argv[i + 1] : token.startsWith("--project=") ? token.slice(10) : undefined;
    if (value !== undefined) return PROJECT_ID.test(value) && value.length <= 128 ? value : undefined;
  }
  return undefined;
}

/** The leased step of an existing project directory, when its lease is readable and unexpired. */
export function leasedStep(projectDir: string, now: number = Date.now()): string | undefined {
  try {
    const file = path.join(projectDir, "pipeline", "session", "lease.json");
    if (!existsSync(file)) return undefined;
    const lease = JSON.parse(readFileSync(file, "utf8")) as { step?: unknown; expiresAt?: unknown };
    if (typeof lease.step !== "string" || !lease.step) return undefined;
    if (typeof lease.expiresAt === "string" && Date.parse(lease.expiresAt) <= now) return undefined;
    return lease.step.slice(0, 64);
  } catch {
    return undefined;
  }
}

let packageScripts: Record<string, string> | undefined;
function scriptsOfPackage(): Record<string, string> {
  if (!packageScripts) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(CODE_ROOT, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      packageScripts = parsed.scripts ?? {};
    } catch {
      packageScripts = {};
    }
  }
  return packageScripts;
}

const runsScript = (command: string, script: string) => command.split(/\s+/).includes(script);

/**
 * The pnpm alias of the running script: `npm_lifecycle_event` when package.json says that alias runs this script
 * (children inherit their parent's lifecycle variables, so the variable alone is not trusted), else the first alias
 * whose command is exactly `tsx <script>`, else the first that runs it, else the script's file name.
 */
export function aliasOf(entry: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!entry) return "unknown";
  let file = path.resolve(entry);
  let root = CODE_ROOT;
  try {
    file = realpathSync(file);
    root = realpathSync(CODE_ROOT);
  } catch {
    // keep the resolved paths
  }
  const relative = path.relative(root, file).split(path.sep).join("/");
  const fallback =
    path
      .basename(file)
      .replace(/\.[cm]?[jt]sx?$/, "")
      .slice(0, 64) || "unknown";
  if (relative.startsWith("..") || path.isAbsolute(relative)) return fallback;
  const scripts = scriptsOfPackage();
  const lifecycle = env.npm_lifecycle_event;
  if (lifecycle && scripts[lifecycle] && runsScript(scripts[lifecycle], relative)) return lifecycle.slice(0, 64);
  const entries = Object.entries(scripts);
  const exact = entries.find(([, command]) => command.trim() === `tsx ${relative}`);
  const any = exact ?? entries.find(([, command]) => runsScript(command, relative));
  return (any?.[0] ?? fallback).slice(0, 64);
}

/** Repository-relative or absolute output paths made relative to the target's base; paths outside the root dropped. */
export function relativeOutputs(outputs: readonly unknown[], rootDir: string, base: string): string[] {
  const root = path.resolve(rootDir);
  const out: string[] = [];
  for (const output of outputs) {
    if (typeof output !== "string" || !output) continue;
    const absolute = path.resolve(root, output);
    const inBase = path.relative(base, absolute);
    const inRoot = path.relative(root, absolute);
    const pick = !inBase.startsWith("..") && !path.isAbsolute(inBase) ? inBase : inRoot;
    if (!pick || pick.startsWith("..") || path.isAbsolute(pick)) continue;
    out.push(pick.split(path.sep).join("/").slice(0, 1024));
    if (out.length === 256) break;
  }
  return out;
}

const usd = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1e6) / 1e6 : undefined;

/**
 * The cost a CLI reports in its metadata: `costUsd`, else a settled receipt (`billing.actualUsd`, as the paid job
 * runner returns it, or `receipt.actualUsd`/`receipt.costUsd`). A quote is an estimate, never a cost.
 */
export function costFromMetadata(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  const nested = (key: string, field: string) => {
    const value = record[key];
    return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
  };
  return (
    usd(record.costUsd) ??
    usd(nested("billing", "actualUsd")) ??
    usd(nested("receipt", "actualUsd")) ??
    usd(nested("receipt", "costUsd"))
  );
}

// ---------------------------------------------------------------------------
// CLI runs: cli.start, cli.progress, cli.end
// ---------------------------------------------------------------------------

export type CliRun = {
  runId: string;
  parentRunId?: string;
  alias: string;
  argv: string[];
  project?: string;
  step?: string;
  startedAt: number;
  rootDir: string;
  target: EventTarget;
  actor: Actor;
  channel: Channel;
  agent?: ConsoleEvent["agent"];
  lastProgressAt: number;
};

let current: CliRun | undefined;

/** The run this process journals, if any. */
export const currentCliRun = (): CliRun | undefined => current;

/** Test helper: forgets the current run without writing `cli.end`. */
export function resetCliRun(): void {
  current = undefined;
}

const base = (run: CliRun, kind: EventKind, at: number): ConsoleEvent => ({
  v: 1,
  id: ulid(at),
  at: new Date(at).toISOString(),
  ...(run.project ? { project: run.project } : {}),
  kind,
  runId: run.runId,
  ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
  alias: run.alias,
  ...(run.step ? { step: run.step } : {}),
  ...(run.agent ? { agent: run.agent } : {}),
  actor: run.actor,
  channel: run.channel,
});

/**
 * Called by runScript at entry. Resolves the destination once (cli.start and cli.end share it, even when the command
 * creates or removes its project), sets `AGENTBROS_RUN_ID` for children (the inherited one becomes `parentRunId`) and
 * writes `cli.start`. Returns undefined when the journal is off or the run has nowhere to go. Never throws.
 */
export function beginCliRun(
  options: { argv?: readonly string[]; env?: NodeJS.ProcessEnv; rootDir?: string; now?: number } = {},
): CliRun | undefined {
  try {
    const env = options.env ?? process.env;
    if (!eventsEnabled(env)) return undefined;
    const argv = options.argv ?? process.argv;
    const now = options.now ?? Date.now();
    const rootDir = path.resolve(options.rootDir ?? process.cwd());
    const args = argv.slice(2);
    const inherited = env[ENV.runId];
    const runId = ulid(now);
    env[ENV.runId] = runId;
    const alias = aliasOf(argv[1], env);
    const project = projectFromArgv(args);
    const target =
      (project ? projectTarget(rootDir, project) : undefined) ??
      (GLOBAL_ALIASES.includes(alias) ? globalTarget(rootDir) : undefined);
    if (!target) return undefined;
    const step = project && target.requireDir ? leasedStep(target.base, now) : undefined;
    const agent = harnessOf(env);
    const who = attributionFor(env, argv, rootDir);
    current = {
      runId,
      ...(inherited && RUN_ID.test(inherited) && inherited !== runId ? { parentRunId: inherited } : {}),
      alias,
      argv: redactArgv(args[0] === "--" ? args.slice(1) : args).map((token) => token.slice(0, 1024)),
      ...(project ? { project } : {}),
      ...(step ? { step } : {}),
      startedAt: now,
      rootDir,
      target,
      actor: who.actor,
      channel: who.channel,
      ...(agent ? { agent } : {}),
      lastProgressAt: 0,
    };
    appendEvent(target, {
      ...base(current, "cli.start", now),
      argv: current.argv,
      data: { pid: process.pid, ...(who.claimed ? { claimed: who.claimed } : {}) },
    });
    return current;
  } catch (error) {
    fail(error);
    return undefined;
  }
}

/** The envelope fields cli.end reads (a CliResult). */
export type CliEndResult = {
  ok: boolean;
  error?: string;
  message?: string;
  elapsedMs?: number;
  outputs?: unknown[];
  metadata?: unknown;
};

/**
 * Called by emitResult before it writes stdout and exits: writes `cli.end` synchronously, once per run. Never throws.
 */
export function endCliRun(result: CliEndResult, now: number = Date.now()): void {
  const run = current;
  if (!run) return;
  current = undefined;
  try {
    const elapsed =
      typeof result.elapsedMs === "number" && Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0
        ? result.elapsedMs
        : Math.max(0, now - run.startedAt);
    const outputs = Array.isArray(result.outputs) ? relativeOutputs(result.outputs, run.rootDir, run.target.base) : [];
    const cost = costFromMetadata(result.metadata);
    const event: ConsoleEvent = {
      ...base(run, "cli.end", now),
      ok: result.ok === true,
      ...(result.ok !== true ? { error: scrubSecrets(String(result.error || "INTERNAL")).slice(0, 64) } : {}),
      ...(typeof result.message === "string" && result.message
        ? { message: redactString(scrubSecrets(result.message)).slice(0, 2048) }
        : {}),
      elapsedMs: elapsed,
      ...(outputs.length ? { outputs } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    };
    appendEvent(run.target, event);
  } catch (error) {
    fail(error);
  }
}

/** Called by emitProgress: at most one `cli.progress` per {@link PROGRESS_INTERVAL_MS}. Never throws. */
export function cliProgress(message: unknown, rest: readonly unknown[] = [], now: number = Date.now()): void {
  const run = current;
  if (!run || now - run.lastProgressAt < PROGRESS_INTERVAL_MS) return;
  try {
    const text = redactString(scrubSecrets(format(message, ...rest).trim()));
    if (!text) return;
    run.lastProgressAt = now;
    appendEvent(run.target, { ...base(run, "cli.progress", now), data: { text } });
  } catch (error) {
    fail(error);
  }
}

// ---------------------------------------------------------------------------
// Other writers: agent.dispatch, job.state, and the generic entry point
// ---------------------------------------------------------------------------

/** The fields a writer may set on an event of another kind; `v`, `id`, `at`, actor and channel are filled in. */
export type EventInput = Omit<Partial<ConsoleEvent>, "v" | "id" | "at" | "kind"> & {
  kind: Exclude<EventKind, "cli.start" | "cli.end" | "cli.progress">;
};

/**
 * Writes one event of a non-CLI kind to the target. Inside a CLI run it carries that run's id, alias and agent, so the
 * console can tie it to the command. `data` is redacted and bounded to 8 KB. Never throws.
 */
export function recordEvent(
  target: EventTarget | undefined,
  input: EventInput,
  options: { env?: NodeJS.ProcessEnv; now?: number } = {},
): boolean {
  try {
    const env = options.env ?? process.env;
    if (!target || !eventsEnabled(env)) return false;
    const now = options.now ?? Date.now();
    const run = current;
    const runId = run?.runId ?? (RUN_ID.test(env[ENV.runId] ?? "") ? env[ENV.runId] : undefined);
    const who = attributionFor(env);
    const event: ConsoleEvent = {
      v: 1,
      id: ulid(now),
      at: new Date(now).toISOString(),
      ...(run?.alias ? { alias: run.alias } : {}),
      ...(runId ? { runId } : {}),
      ...(run?.step ? { step: run.step } : {}),
      actor: who.actor,
      channel: who.channel,
      ...input,
      ...(input.agent || run?.agent ? { agent: { ...run?.agent, ...input.agent } } : {}),
      ...(input.data ? { data: redactData(input.data) } : {}),
    } as ConsoleEvent;
    return appendEvent(target, event);
  } catch (error) {
    return fail(error);
  }
}

/** `film:brief`'s `agent.dispatch` (§7): which agent was sent to which step, with its brief (project-relative). */
export function recordDispatch(
  input: {
    rootDir: string;
    project: string;
    step: string;
    agent: string;
    role: string;
    /** The brief file, absolute or relative to rootDir. */
    brief: string;
    team?: string;
    variant?: string;
    lane?: string;
  },
  options: { env?: NodeJS.ProcessEnv; now?: number } = {},
): boolean {
  try {
    const target = projectTarget(input.rootDir, input.project);
    if (!target) return false;
    const brief = path.relative(target.base, path.resolve(input.rootDir, input.brief)).split(path.sep).join("/");
    return recordEvent(
      target,
      {
        kind: "agent.dispatch",
        project: input.project,
        step: input.step.slice(0, 64),
        agent: { name: input.agent.slice(0, 128), role: input.role.slice(0, 64) },
        data: {
          brief,
          ...(input.team ? { team: input.team } : {}),
          ...(input.variant ? { variant: input.variant } : {}),
          ...(input.lane ? { lane: input.lane } : {}),
        },
      },
      options,
    );
  } catch (error) {
    return fail(error);
  }
}

/** The job fields `job.state` reads (a GenerationJob). */
export type JobStateInput = {
  operationId: string;
  state: string;
  provider?: string;
  endpoint?: string;
  reservedMicros?: number;
  receipt?: { actualUsd?: number };
  stage?: string;
  assetId?: string;
};

/**
 * The job store's `job.state` (§7): written only when the store's directory is `public/projects/<projectId>/pipeline`
 * under the root (the working directory) and that project exists; stores kept elsewhere are not journaled. Never throws.
 */
export function recordJobState(
  pipelineDirectory: string,
  projectId: string,
  job: JobStateInput,
  options: { env?: NodeJS.ProcessEnv; now?: number; rootDir?: string } = {},
): boolean {
  try {
    const directory = path.resolve(pipelineDirectory);
    // Only a real project's own store: other stores (media budgets, bench runs, fixtures) live elsewhere.
    const project = projectTarget(options.rootDir ?? process.cwd(), projectId);
    if (!project || path.resolve(project.requireDir!) !== directory) return false;
    const reserved = usd((job.reservedMicros ?? 0) / 1_000_000);
    const cost = usd(job.receipt?.actualUsd);
    return recordEvent(
      { file: path.join(directory, "events.jsonl"), requireDir: directory, base: path.dirname(directory) },
      {
        kind: "job.state",
        ...(PROJECT_ID.test(projectId) ? { project: projectId } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
        data: {
          jobId: String(job.operationId).slice(0, 128),
          state: job.state,
          ...(job.provider ? { provider: job.provider } : {}),
          ...(job.endpoint ? { endpoint: job.endpoint } : {}),
          ...(reserved !== undefined ? { reservedUsd: reserved } : {}),
          ...(cost !== undefined ? { costUsd: cost } : {}),
          ...(job.stage ? { stage: job.stage } : {}),
          ...(job.assetId ? { assetId: job.assetId } : {}),
        },
      },
      options,
    );
  } catch (error) {
    return fail(error);
  }
}
