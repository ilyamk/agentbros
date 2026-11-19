/**
 * Shared CLI helper module for all production scripts.
 *
 * Contract:
 *   stdout  — exactly one JSON line: { ok: true, ... } or { ok: false, ... }
 *   stderr  — free-form progress lines visible to the user when running interactively
 *   exit    — 0 on success, non-zero on failure
 *
 * Usage pattern:
 *   import { runScript, parseArgs, emitProgress } from "../src/lib/cli";
 *   runScript(async () => {
 *     const args = parseArgs(SPECS);
 *     emitProgress("Starting…");
 *     return { outputs: ["out/file.png"], metadata: { cost: 0.04 } };
 *   });
 */

import { collectBeforeExit } from "./exit-guard";
import { existsSync, lstatSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { runtimeStatus, runtimeWarning } from "../runtime";
import { beginCliRun, cliProgress, endCliRun } from "../console/journal";
import { processAttribution } from "./channel";
import { applyManagedCredentials, credentialFilesDisabled } from "../setup/credential-store";

/** `AGENTBROS_NO_DOTENV=1` (or `true`) skips loading local environment files. */
export const dotenvDisabled = credentialFilesDisabled;

export type { ArgSpec, ArgsResult, CliError, CliResult, CliSuccess, ErrorCode } from "./types.js";
export { ERROR_CODES } from "./types.js";

import type { ArgSpec, ArgsResult, CliResult, ErrorCode } from "./types.js";

// ---------------------------------------------------------------------------
// CliErrorObject
// ---------------------------------------------------------------------------

/**
 * Error subclass that carries a structured error code. Throw this anywhere in
 * script logic; `runScript` will catch it and emit the correct JSON envelope.
 */
export class CliErrorObject extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(opts: { code: ErrorCode; message: string; retryAfterMs?: number; details?: Record<string, unknown> }) {
    super(opts.message);
    this.name = "CliErrorObject";
    this.code = opts.code;
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
  }
}

// ---------------------------------------------------------------------------
// Emit helpers
// ---------------------------------------------------------------------------

/**
 * Log a progress message to stderr. The user sees this when running
 * interactively; orchestrators ignore stderr.
 */
export function emitProgress(message: string, ...rest: unknown[]): void {
  console.error("[progress]", message, ...rest);
  cliProgress(message, rest); // throttled journal line (RFC 0004 §7); never throws
}

/**
 * Log a debug message to stderr. Only emits when DEBUG=1 is set.
 */
export function emitDebug(message: string, ...rest: unknown[]): void {
  if (process.env["DEBUG"] === "1") {
    console.error("[debug]", message, ...rest);
  }
}

/**
 * Print the result as a single JSON line to stdout and exit.
 * Exit code is 0 for success, 1 for failure.
 */
export function emitResult(result: CliResult): never {
  // Serialise first: a throw here (BigInt, cycle) leaves the journal run open, and runScript's INTERNAL fallback,
  // which calls emitResult again, journals the real outcome.
  // Pipes may accept only part of a large envelope. Preserve every UTF-8 byte
  // before exiting, including offline plans containing inline media references.
  const bytes = Buffer.from(JSON.stringify(result) + "\n");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset, bytes.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN") {
        // stdout failed (EPIPE…): the run fails, so the journal says so (RFC 0004 D7), then the error propagates.
        endCliRun({ ok: false, error: "INTERNAL", message: `stdout write failed: ${code ?? String(error)}` });
        throw error;
      }
      Atomics.wait(wait, 0, 0, 1); // Wait for the pipe consumer without losing bytes.
    }
  }
  // The journal's cli.end (RFC 0004 D7): synchronous, never throws, written before exit with the outcome delivered.
  endCliRun(result);
  collectBeforeExit();
  process.exit(result.ok ? 0 : 1);
}

/**
 * Convenience wrapper — builds a CliSuccess and calls emitResult.
 */
export function emitSuccess(opts: {
  outputs?: string[];
  metadata?: Record<string, unknown>;
  startedAt: number;
}): never {
  return emitResult({
    ok: true,
    outputs: opts.outputs ?? [],
    metadata: opts.metadata ?? {},
    elapsedMs: Date.now() - opts.startedAt,
  });
}

/**
 * Convenience wrapper — builds a CliError and calls emitResult.
 */
export function emitError(opts: {
  error: ErrorCode;
  message: string;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  startedAt: number;
}): never {
  return emitResult({
    ok: false,
    error: opts.error,
    message: opts.message,
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
    ...(opts.details !== undefined ? { details: opts.details } : {}),
    elapsedMs: Date.now() - opts.startedAt,
  });
}

// ---------------------------------------------------------------------------
// runScript
// ---------------------------------------------------------------------------

/**
 * Wraps a script's main function with timing and structured error handling.
 *
 * - On success: emits JSON `{ ok: true, outputs, metadata, elapsedMs }` and exits 0.
 * - On CliErrorObject: emits JSON `{ ok: false, error, message, ... }` and exits 1.
 * - On any other Error: emits `{ ok: false, error: "INTERNAL", ... }` and exits 1.
 */
export async function runScript(
  fn: () => Promise<{ outputs?: string[]; metadata?: Record<string, unknown> }>,
): Promise<never> {
  const startedAt = Date.now();
  // Who runs this (cli/channel.ts): decided now, while the console grant is still in the env and fresh.
  processAttribution();
  beginCliRun({ now: startedAt }); // the journal's cli.start (RFC 0004 D7); never throws, off with AGENTBROS_EVENTS=off
  try {
    let runtime: ReturnType<typeof runtimeStatus>;
    try {
      runtime = runtimeStatus();
    } catch {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Runtime policy is missing or inconsistent; align package.json, .nvmrc and .nvmrc.fallback.",
      });
    }
    if (runtime.role === "unsupported")
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Node ${runtime.actual} is unsupported; use any Node ${runtime.primary.split(".")[0]}.x or ${runtime.fallback.split(".")[0]}.x (recommended and CI-tested: ${runtime.primary}). Run nvm install && nvm use in the repository (reads .nvmrc); see docs/node-runtime.md.`,
        details: runtime,
      });
    const warning = runtimeWarning(runtime);
    if (warning) process.stderr.write(warning);
    if (
      !dotenvDisabled() &&
      !process.argv.some((arg) => ["--help", "-h", "--dry-run", "--dry-run=true"].includes(arg))
    ) {
      if (existsSync(".env")) process.loadEnvFile(".env");
      applyManagedCredentials(process.env);
    }
    await guardPause();
    const stepGuard = await guardStep();
    const result = await fn();
    emitSuccess({
      outputs: result.outputs ?? [],
      metadata: stepGuard ? { ...(result.metadata ?? {}), stepGuard } : (result.metadata ?? {}),
      startedAt,
    });
  } catch (err) {
    if (err instanceof CliErrorObject) {
      emitError({
        error: err.code,
        message: err.message,
        retryAfterMs: err.retryAfterMs,
        details: err.details,
        startedAt,
      });
    } else if (
      err instanceof Error &&
      err.name === "BudgetError" &&
      (err as Error & { code?: unknown }).code === "BUDGET_EXCEEDED"
    ) {
      // jobs/store's BudgetError, matched by name so every CLI need not load the store.
      const details = (err as Error & { details?: Record<string, unknown> }).details;
      emitError({ error: "BUDGET_EXCEEDED", message: err.message, details, startedAt });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error && ["ZodError", "SyntaxError"].includes(err.name) ? "VALIDATION" : "INTERNAL";
      emitError({ error: code, message, startedAt });
    }
  }
  // Unreachable — emitError/emitSuccess call process.exit.
  throw new Error("unreachable");
}

/** The `--project` value of argv when it is a valid project id (as the step guard and the hook read it). */
function projectArg(args: readonly string[]): string | undefined {
  const at = args.findIndex((arg) => arg === "--project" || arg.startsWith("--project="));
  const project = at < 0 ? undefined : args[at] === "--project" ? args[at + 1] : args[at]!.slice("--project=".length);
  return project && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project) && project.length <= 128 ? project : undefined;
}

/**
 * The pause check (RFC 0004 D12), before the step guard and whatever AGENTBROS_STEP_GUARD says: a project the user
 * paused or stopped refuses every non-control command with `PAUSED`. Every project the line names is checked
 * (`--project`, `-p`, `=` forms, every occurrence: parseArgs keeps the last, a decoy must not hide it). The control
 * file is read inline; the judging module (registry, aliases) loads only when a named project is not running.
 */
async function guardPause(): Promise<void> {
  // The console grant is for this process only: children of it never inherit one (console/grant.ts).
  const env = { ...process.env };
  delete process.env.AGENTBROS_CONSOLE_GRANT;
  delete process.env.AGENTBROS_CONSOLE_GRANT_AT;
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return;
  const projects: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const equal = token.indexOf("=");
    const flag = equal < 0 ? token : token.slice(0, equal);
    if (flag !== "--project" && flag !== "-p") continue;
    const value = equal < 0 ? args[++i] : token.slice(equal + 1);
    // Any id projectDir() resolves, as written and lowercased (pauseCandidates in console/control.ts).
    if (value && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) && value.length <= 128)
      projects.push(value, value.toLowerCase());
  }
  const halted = projects.some((project) => {
    try {
      const file = path.join("public", "projects", project, "pipeline", "session", "control.json");
      const control = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; state?: unknown };
      return control?.v === 1 && (control.state === "paused" || control.state === "stopped");
    } catch {
      return false; // missing or unreadable: running, as the hook reads it
    }
  });
  if (!halted) return;
  const { pauseVerdict } = await import("../console/pause.js");
  const verdict = pauseVerdict({ rootDir: process.cwd(), argv: process.argv, env });
  if (verdict) throw new CliErrorObject({ code: "PAUSED", message: verdict.message, details: verdict.details });
}

/**
 * The step guard (docs/step-lease.md): only when the project named by --project has a step lease is the guard
 * module loaded. Warn mode (default) returns the warning for metadata.stepGuard; enforce mode throws VALIDATION.
 */
async function guardStep(): Promise<Record<string, unknown> | undefined> {
  // A confirmed removal signed by Studio Console is a user action outside the agent's step.
  if (processAttribution().verified && path.basename(process.argv[1] ?? "") === "project-remove.ts") return undefined;
  if ((process.env.AGENTBROS_STEP_GUARD ?? "").trim().toLowerCase() === "off") return undefined;
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) return undefined;
  const project = projectArg(args);
  if (!project) return undefined;
  if (!existsSync(path.join("public", "projects", project, "pipeline", "session", "lease.json"))) return undefined;
  const { guardCli } = await import("../step-lease/guard.js");
  const verdict = guardCli();
  if (verdict.refusal) throw new CliErrorObject({ code: "VALIDATION", message: verdict.refusal });
  if (verdict.warning) process.stderr.write(`[step-guard] ${String(verdict.warning["message"])}\n`);
  return verdict.warning;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

/**
 * Typed argv parser. Reads from `process.argv.slice(2)` unless `argv` is given.
 *
 * Supported forms:
 *   --name value       string/number value
 *   --name=value       inline value
 *   -s value           short alias
 *   --name             boolean flag (true)
 *   --no-name          negates a boolean flag (false)
 *
 * Throws CliErrorObject with code "INVALID_INPUT" on validation failure.
 * On --help / -h: prints usage to stderr and emits a success envelope.
 */
export function parseArgs<S extends readonly ArgSpec[]>(specs: S, argv?: string[]): ArgsResult<S> {
  const tokens = [...(argv ?? process.argv.slice(2))];
  if (tokens[0] === "--") tokens.shift(); // pnpm forwards its separator
  if (tokens.includes("--help") || tokens.includes("-h")) {
    printUsage(specs);
    emitResult({ ok: true, outputs: [], metadata: { help: true }, elapsedMs: 0 });
  }
  const parsed: Record<string, string | boolean | number | undefined> = {};
  for (const spec of specs) {
    parsed[spec.name] = spec.default ?? (spec.type === "boolean" ? false : undefined);
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const equal = token.indexOf("=");
    const flag = equal < 0 ? token : token.slice(0, equal);
    const direct = flag.startsWith("--") ? specs.find((item) => item.name === flag.slice(2)) : undefined;
    const negated = !direct && flag.startsWith("--no-");
    const name = flag.slice(negated ? 5 : 2);
    const spec = flag.startsWith("--")
      ? (direct ?? specs.find((item) => item.name === name))
      : specs.find((item) => flag === `-${item.short}` && item.short);
    if (!spec || (negated && spec.type !== "boolean")) {
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown argument: ${token}` });
    }
    if (negated) {
      if (equal >= 0)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `Negated flag cannot take a value: ${token}` });
      parsed[spec.name] = false;
    } else if (spec.type === "boolean" && equal < 0) {
      parsed[spec.name] = true;
    } else {
      const raw = equal >= 0 ? token.slice(equal + 1) : tokens[++i];
      if (raw === undefined || (equal < 0 && /^--?[^0-9.]/.test(raw))) {
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `Missing value for --${spec.name}` });
      }
      parsed[spec.name] = coerce(spec, raw);
    }
  }
  for (const spec of specs) {
    const value = parsed[spec.name];
    if (spec.required && (value === undefined || value === "")) {
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `Missing required argument: --${spec.name}` });
    }
    if (spec.choices && value !== undefined && !spec.choices.includes(String(value))) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Invalid value "${value}" for --${spec.name}. Allowed: ${spec.choices.join(", ")}`,
      });
    }
  }
  return parsed as ArgsResult<S>;
}

function coerce(spec: ArgSpec, raw: string): string | number | boolean {
  if (spec.type === "number") {
    const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value)) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Expected a finite number for --${spec.name}, got "${raw}"`,
      });
    }
    return value;
  }
  if (spec.type === "boolean") {
    if (!["true", "false", "1", "0"].includes(raw.toLowerCase())) {
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `Expected true or false for --${spec.name}` });
    }
    return raw.toLowerCase() === "true" || raw === "1";
  }
  return raw;
}

function printUsage(specs: readonly ArgSpec[]): void {
  console.error("Options:");
  for (const spec of specs) {
    const flags = [`--${spec.name}`, spec.short ? `-${spec.short}` : null].filter(Boolean).join(", ");

    const meta =
      spec.type === "boolean" ? "" : spec.choices ? ` <${spec.choices.join("|")}>` : ` <${spec.type ?? "string"}>`;

    const req = spec.required ? " (required)" : "";
    const def = spec.default !== undefined ? ` [default: ${String(spec.default)}]` : "";
    console.error(`  ${flags}${meta}  ${spec.description}${req}${def}`);
  }
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_ON: ErrorCode[] = ["RATE_LIMIT", "NETWORK", "TIMEOUT"];

/**
 * Retries `fn` with exponential backoff when it throws a retryable CliErrorObject.
 *
 * @param fn        Async function to attempt
 * @param opts.attempts   Total attempts (including the first)
 * @param opts.backoffMs  Base delay in milliseconds
 * @param opts.factor     Multiplier per attempt (default 2)
 * @param opts.retryOn    Error codes that trigger a retry (default: RATE_LIMIT, NETWORK, TIMEOUT)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    attempts: number;
    backoffMs: number;
    factor?: number;
    retryOn?: readonly ErrorCode[];
  },
): Promise<T> {
  if (
    !Number.isInteger(opts.attempts) ||
    opts.attempts < 1 ||
    !Number.isFinite(opts.backoffMs) ||
    opts.backoffMs < 0 ||
    (opts.factor !== undefined && (!Number.isFinite(opts.factor) || opts.factor < 0))
  ) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Retry attempts must be positive and delays finite/nonnegative.",
    });
  }
  const factor = opts.factor ?? 2;
  const retryOn = opts.retryOn ?? DEFAULT_RETRY_ON;
  let lastErr: unknown;

  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof CliErrorObject && retryOn.includes(err.code) && attempt < opts.attempts - 1) {
        const delayMs = err.retryAfterMs ?? opts.backoffMs * Math.pow(factor, attempt);
        if (!Number.isFinite(delayMs) || delayMs < 0)
          throw new CliErrorObject({ code: "INVALID_INPUT", message: "Retry delay must be finite and nonnegative." });
        emitProgress(`Attempt ${attempt + 1}/${opts.attempts} failed (${err.code}). Retrying in ${delayMs}ms…`);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}

async function sleep(ms: number): Promise<void> {
  const maximum = 2 ** 31 - 1;
  while (ms > maximum) {
    await new Promise<void>((resolve) => setTimeout(resolve, maximum));
    ms -= maximum;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

/**
 * Returns the value of an environment variable or throws a structured error.
 */
export function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new CliErrorObject({
      code: "MISSING_API_KEY",
      message: `Environment variable ${name} is not set. Add it to your .env file.`,
    });
  }
  return val;
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that a file exists or throws a structured error.
 */
export function requireFile(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `Required file not found: ${filePath}`,
    });
  }
}

/**
 * Asserts that `public/projects/{id}/project.json` exists.
 */
/** A bespoke film has its own composition and never a project.json. */
export function isBespokeBrief(briefPath: string): boolean {
  if (!existsSync(briefPath)) return false;
  try {
    return (JSON.parse(readFileSync(briefPath, "utf8")) as { renderMode?: unknown }).renderMode === "bespoke";
  } catch {
    return false;
  }
}

export function requireProject(projectId: string): void {
  validateProjectId(projectId);
  const projectJson = path.join("public", "projects", projectId, "project.json");
  assertPathWithin(path.resolve("public", "projects"), path.resolve(projectJson));
  if (
    !existsSync(projectJson) &&
    !isBespokeBrief(path.join("public", "projects", projectId, "pipeline", "brief.json")) &&
    !isCampaignContainer(path.dirname(projectJson))
  ) {
    throw new CliErrorObject({
      code: "PROJECT_NOT_FOUND",
      message: `Project "${projectId}" not found. Expected: ${projectJson}`,
    });
  }
}

/** A material-owning campaign is a project container, never a renderable video. */
export function isCampaignContainer(directory: string): boolean {
  const file = path.join(directory, "pipeline/campaign-production/owner.json");
  if (!existsSync(file)) return false;
  assertPathWithin(directory, file);
  const value = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; campaignId?: unknown };
  return (
    value.version === 1 &&
    value.campaignId === path.basename(directory) &&
    typeof value.campaignId === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.campaignId)
  );
}

/**
 * Ids no project may take: `out/console/` holds the studio console's journal, lock and cache (RFC 0004), so a project
 * named `console` would share it and `project:remove console` would delete it.
 */
export const RESERVED_PROJECT_IDS: readonly string[] = ["console"];
/** Case-insensitive, as on the default (case-insensitive) macOS file system `Console` and `console` are one folder. */
export const isReservedProjectId = (id: string): boolean => RESERVED_PROJECT_IDS.includes(id.toLowerCase());
/** Why a reserved id is refused or skipped, for command output. */
export const reservedProjectReason = (id: string): string =>
  `Project id "${id}" is reserved: out/${id.toLowerCase()}/ belongs to the studio console (RFC 0004), so a project of that name is never created, removed or cleaned by these commands; rename the folder to manage it.`;

/** Reject traversal, shell syntax, ambiguous filesystem names and reserved ids before IO. */
export function validateProjectId(id: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 128) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Project ID must be a lowercase alphanumeric slug with hyphens (max 128 characters).",
    });
  }
  if (isReservedProjectId(id)) throw new CliErrorObject({ code: "INVALID_INPUT", message: reservedProjectReason(id) });
}

/** Checks lexical containment and existing symlink ancestors. */
export function assertPathWithin(root: string, target: string): void {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    );
  };
  if (!inside(base, resolved))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Path escapes project directory." });
  const canonical = (file: string): string => {
    let ancestor = file;
    try {
      while (!lstatSync(ancestor, { throwIfNoEntry: false }) && path.dirname(ancestor) !== ancestor)
        ancestor = path.dirname(ancestor);
      return path.resolve(realpathSync(ancestor), path.relative(ancestor, file));
    } catch (error) {
      if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "Path contains a dangling or cyclic symlink." });
      }
      throw error;
    }
  };
  if (!inside(canonical(base), canonical(resolved))) {
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Path escapes project directory through a symlink." });
  }
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe checks
// ---------------------------------------------------------------------------

/**
 * Throws a structured error if ffmpeg is not installed.
 */
export function ensureFfmpeg(): void {
  const result = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" });
  if (result.error ?? (result.status !== 0 && result.status !== null)) {
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg not found. Install it with: brew install ffmpeg",
    });
  }
}

/**
 * Throws a structured error if ffprobe is not installed.
 */
export function ensureFfprobe(): void {
  const result = spawnSync("ffprobe", ["-version"], { encoding: "utf-8" });
  if (result.error ?? (result.status !== 0 && result.status !== null)) {
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffprobe not found. Install it with: brew install ffmpeg",
    });
  }
}

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------

/**
 * Converts a string to a URL-safe slug.
 *
 * Steps: lowercase → split on whitespace → take first N words → join with "-"
 *        → strip characters that are not [a-z0-9-]
 *
 * @example
 *   slugify("Hello World!! With Extra Spaces", { maxWords: 3 }) // "hello-world-with"
 */
export function slugify(s: string, opts?: { maxWords?: number }): string {
  const maxWords = opts?.maxWords ?? 5;
  const words = s.toLowerCase().split(/\s+/).filter(Boolean).slice(0, maxWords);
  return words.join("-").replace(/[^a-z0-9-]/g, "");
}

/**
 * Strips the `process.cwd()` prefix from an absolute path so output JSON
 * contains repo-relative paths.
 *
 * If the path does not start with `process.cwd()`, it is returned unchanged.
 */
export function relativisePath(absolutePath: string): string {
  const cwd = process.cwd();
  if (absolutePath.startsWith(cwd)) {
    // Remove the cwd prefix and any leading separator
    return absolutePath.slice(cwd.length).replace(/^[/\\]/, "");
  }
  return absolutePath;
}
