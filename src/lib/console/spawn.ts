/**
 * Runs the CLI that owns a user's decision (RFC 0004 D9, §2.3 principle 2): a fixed allowlist of pnpm aliases, each
 * resolved to its `tsx scripts/<file>.ts` entry in package.json, spawned as `node <tsx> <script> ...args` with literal
 * argv (no shell), cwd at the checkout root, `AGENTBROS_ACTOR=user` and `AGENTBROS_CHANNEL=console`. The child's one
 * JSON line is its answer; anything else (no line, two lines, an exit code that disagrees) becomes a refused
 * `INTERNAL` envelope, never a success.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { consoleGrantEnv } from "./grant";
import { CliEnvelopeSchema, CONSOLE_ENV, type CliEnvelope } from "../../types/console";

/** The aliases the console may spawn: the user's decisions only (§8). Control and cards belong to WP8 and WP11. */
export const DECISION_ALIASES = [
  "film:approve",
  "film:done",
  "film:policy",
  "film:rights",
  "budget",
  "feedback",
  "memory",
  "music",
  "ref:rate",
  "recut:plan",
] as const;
export type DecisionAlias = (typeof DECISION_ALIASES)[number];

export interface SpawnRequest {
  /** Checkout root: the child's cwd (`public/projects/` lives here). */
  rootDir: string;
  alias: DecisionAlias;
  /** The project the decision is on (for the grant hook). */
  project?: string;
  /** Flags after the alias, literal. User text always travels inside one `--flag=value` token. */
  args: readonly string[];
  timeoutMs?: number;
}

/**
 * Extra environment that lets a user's console decision run while the project is paused (WP8): `argv` is exactly the
 * arguments after the script. Default: {@link consoleGrantEnv}, signed with the session token.
 */
export type GrantEnv = (rootDir: string, project: string | undefined, argv: readonly string[]) => NodeJS.ProcessEnv;

/** A project-less decision (a global memory) is signed for project `""`, which is how cli/channel.ts verifies it. */
const defaultGrantEnv: GrantEnv = (rootDir, project, argv) => consoleGrantEnv(rootDir, project ?? "", argv);
export interface SpawnResult {
  envelope: CliEnvelope;
  exitCode: number | null;
}
export type SpawnCli = (request: SpawnRequest) => Promise<SpawnResult>;

/** Where the code lives (package.json, node_modules/tsx, scripts/), which may differ from the data root in tests. */
export const CODE_ROOT = path.resolve(import.meta.dirname, "../../..");
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_STDOUT = 4 * 1024 * 1024;

let scripts: Record<string, string> | undefined;
/** `scripts/<file>.ts` of an allowed alias, from package.json's exact `tsx scripts/<file>.ts` command. */
export function scriptOf(alias: string, codeRoot: string = CODE_ROOT): string {
  if (!(DECISION_ALIASES as readonly string[]).includes(alias)) throw new Error(`The console does not run ${alias}.`);
  scripts ??= (
    JSON.parse(readFileSync(path.join(codeRoot, "package.json"), "utf8")) as { scripts: Record<string, string> }
  ).scripts;
  const match = /^tsx (scripts\/[a-z0-9-]+\.ts)$/.exec(scripts[alias]?.trim() ?? "");
  if (!match) throw new Error(`package.json does not run ${alias} as tsx scripts/<file>.ts.`);
  return path.join(codeRoot, match[1]!);
}

/** The child's environment: the server's, minus run and lease pairing, plus the user as actor on the console. */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env[CONSOLE_ENV.runId];
  delete env.AGENTBROS_STEP_ADMITTED;
  delete env.npm_lifecycle_event;
  delete env.npm_lifecycle_script;
  env[CONSOLE_ENV.actor] = "user";
  env[CONSOLE_ENV.channel] = "console";
  return env;
}

const internal = (message: string, details?: Record<string, unknown>): CliEnvelope => ({
  ok: false,
  error: "INTERNAL",
  message,
  ...(details ? { details } : {}),
});

/** The command ran but its outcome cannot be read: it may have applied. `details.ambiguous` marks it. */
const ambiguous = (message: string, details: Record<string, unknown> = {}, error = "INTERNAL"): CliEnvelope => ({
  ok: false,
  error,
  message,
  details: { ...details, ambiguous: true },
});

/** True when the envelope says the command's outcome is unknown (timeout, crash, unreadable output). */
export const isAmbiguous = (envelope: CliEnvelope): boolean => envelope.details?.["ambiguous"] === true;

/** Parses a child's stdout and exit code into its envelope (pure; exported for tests). */
export function envelopeOf(stdout: string, exitCode: number | null, stderr = ""): CliEnvelope {
  const lines = stdout
    .trimEnd()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  const tail = stderr.trim().slice(-500);
  if (lines.length !== 1)
    return ambiguous(`The command printed ${lines.length} lines instead of one JSON envelope.`, {
      exitCode,
      ...(tail ? { stderr: tail } : {}),
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]!);
  } catch {
    return ambiguous("The command's output is not JSON.", { exitCode });
  }
  const result = CliEnvelopeSchema.safeParse(parsed);
  if (!result.success) return ambiguous("The command's output is not a CLI envelope.", { exitCode });
  // A help screen never applies anything: words that reach parseArgs as a flag must not count as a decision.
  if (result.data.metadata?.["help"] === true)
    return internal("The command printed its help instead of running: nothing was applied.", { exitCode });
  if (exitCode !== (result.data.ok ? 0 : 1))
    return ambiguous(`The command exited ${exitCode} but its envelope says ok: ${result.data.ok}.`, {
      exitCode,
      envelope: result.data,
    });
  return result.data;
}

export function createSpawnCli(
  options: { codeRoot?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; grantEnv?: GrantEnv } = {},
): SpawnCli {
  const codeRoot = options.codeRoot ?? CODE_ROOT;
  const runner = path.join(codeRoot, "node_modules/tsx/dist/cli.mjs");
  return (request) =>
    new Promise((resolve) => {
      let script: string;
      try {
        script = scriptOf(request.alias, codeRoot);
      } catch (error) {
        resolve({ envelope: internal((error as Error).message), exitCode: null });
        return;
      }
      const child = spawn(process.execPath, [runner, script, ...request.args], {
        cwd: request.rootDir,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...childEnv(options.env ?? process.env),
          ...(options.grantEnv ?? defaultGrantEnv)(request.rootDir, request.project, request.args),
        },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0;
      let failure: CliEnvelope | undefined;
      let started = false;
      child.on("spawn", () => {
        started = true;
      });
      const timer = setTimeout(
        () => {
          failure = ambiguous(
            `The command did not answer within ${Math.round((request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s: it may have applied.`,
            {},
            "TIMEOUT",
          );
          child.kill("SIGKILL");
        },
        request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_STDOUT) {
          failure = ambiguous("The command printed too much.");
          child.kill("SIGKILL");
        } else out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        err.push(chunk);
        if (err.length > 64) err.shift();
      });
      child.on("error", (error) => {
        failure = started ? ambiguous(error.message) : internal(error.message);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) resolve({ envelope: failure, exitCode: code });
        else
          resolve({
            envelope: envelopeOf(Buffer.concat(out).toString("utf8"), code, Buffer.concat(err).toString("utf8")),
            exitCode: code,
          });
      });
    });
}
