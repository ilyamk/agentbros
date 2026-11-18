/**
 * Starting, reusing and stopping the console server (RFC 0004 D16). `ensureConsoleServer` is what `pnpm next`,
 * `film:next`, `footage:next` and `film:init` call (WP7a): it never throws, refuses in tests and when switched off,
 * reuses a live server of the same version, replaces a stale lock, restarts a server of another version, and
 * otherwise starts one detached (logs to `out/console/server.log`). Light on purpose: no server code, no Vite.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CONSOLE_ENV, DEFAULT_CONSOLE_PORT, SERVER_LOG_FILE } from "../../types/console";
import { codeRoot, consoleVersion } from "./bundle";
import {
  acquireStartLock,
  bootTimeMs,
  inspectDaemonProcess,
  liveServer,
  lockBeforeBoot,
  pidAlive,
  readLock,
  removeLockIfOwned,
  terminate,
} from "./lock";
import { loadOrCreateSessionToken, readSessionToken } from "./session";
import { sessionUrl } from "./urls";

export type ConsoleStartResult =
  | {
      /** Session URL with `#token=` (and `&project=` when given): keep it private. */
      url: string;
      /** `http://127.0.0.1:<port>/`, without the token (the `console.url` of next-step answers). */
      baseUrl: string;
      port: number;
      reused: boolean;
      /** The requested port was busy; the server listens on another one. */
      fellBack: boolean;
      pid: number;
      version: string;
    }
  | {
      error: string;
      /** Verified, reachable server left in place when it could not be replaced. */
      existingBaseUrl?: string;
      /** A spawned server that did not answer and was stopped. */
      pid?: number;
    };

export interface StartOptions {
  /** Checkout root (holds `public/projects/` and `out/`). */
  rootDir: string;
  project?: string;
  /** Requested port (default 4317; the server falls back to a free one). */
  port?: number;
  /** Version to require and to start with (default: hash of this checkout's console sources). */
  version?: string;
  /** How long to wait for a new server's health answer (default 10 s). */
  timeoutMs?: number;
  /** Extra daemon flags (tests: `--no-build`, `--idle-ms`). */
  daemonArgs?: string[];
  /**
   * Whether a live daemon of this root that answers with another version, or does not answer, may be terminated and
   * replaced (default true: `pnpm console`). False (next-step callers, via {@link ensureConsoleServer}) never signals a
   * live daemon, reports `error` instead, and treats `timeoutMs` as one deadline for the whole call.
   */
  replace?: boolean;
}

export interface EnsureOptions extends StartOptions {
  /** Environment consulted for the refusals (default process.env). */
  env?: NodeJS.ProcessEnv;
}

const DAEMON = path.join(import.meta.dirname, "daemon.ts");
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const inspectionRefusal = (pid: number) =>
  `Cannot verify console process ${pid} from this session. The process and its lock were left in place. Run pnpm console from an unrestricted local terminal.`;

/** True when `rootDir` is a checkout of this repository: package `agentbros`, `.git`, the console sources. */
export function isCheckoutRoot(rootDir: string): boolean {
  try {
    const root = realpathSync(rootDir);
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown };
    return (
      pkg.name === "agentbros" &&
      existsSync(path.join(root, ".git")) &&
      existsSync(path.join(root, "src/types/console.ts")) &&
      existsSync(path.join(root, "apps/console"))
    );
  } catch {
    return false;
  }
}

/** Why auto-start must not run here, or undefined. */
export function autoStartRefusal(rootDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if ((env[CONSOLE_ENV.console] ?? "").trim().toLowerCase() === "off")
    return `${CONSOLE_ENV.console}=off: console auto-start is disabled.`;
  if (env.NODE_TEST_CONTEXT) return "Running under node:test: the console server is not started.";
  if (!isCheckoutRoot(rootDir)) return "Not a checkout root: the console server starts only from the repository.";
  return undefined;
}

/**
 * The entry point for next-step commands (D16, WP7a). Never throws: every failure is `{ error }`.
 * Refuses when `AGENTBROS_CONSOLE=off`, under node:test (`NODE_TEST_CONTEXT`) and outside a real checkout root.
 */
export async function ensureConsoleServer(options: EnsureOptions): Promise<ConsoleStartResult> {
  try {
    const refusal = autoStartRefusal(options.rootDir, options.env);
    if (refusal) return { error: refusal };
    return await startOrReuseConsoleServer({ ...options, replace: false });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function result(
  token: string,
  project: string | undefined,
  port: number,
  pid: number,
  version: string,
  reused: boolean,
  requested: number,
): ConsoleStartResult {
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: sessionUrl(origin, token, project),
    baseUrl: `${origin}/`,
    port,
    reused,
    fellBack: !reused && requested !== 0 && port !== requested,
    pid,
    version,
  };
}

function rotateLog(file: string) {
  try {
    if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
}

/** The daemon's environment: this one without node:test's context (the daemon is a server, not a test). */
function daemonEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function logTail(file: string): string {
  try {
    return readFileSync(file, "utf8").trim().split("\n").slice(-5).join("\n");
  } catch {
    return "";
  }
}

/** Reuse or start without the auto-start refusals (`pnpm console` and tests). Never throws. */
export async function startOrReuseConsoleServer(options: StartOptions): Promise<ConsoleStartResult> {
  try {
    const rootDir = realpathSync(options.rootDir);
    const requested = options.port ?? DEFAULT_CONSOLE_PORT;
    const version = options.version ?? consoleVersion().version;
    const token = loadOrCreateSessionToken(rootDir);
    const timeoutMs = options.timeoutMs ?? 10_000;
    const replace = options.replace !== false;
    // Without replacement the whole call (reuse probes, a start lock held by another caller, a spawn) has one deadline.
    const overall = performance.now() + timeoutMs;
    const remaining = () => Math.max(0, overall - performance.now());
    const probeMs = replace ? undefined : () => Math.min(1000, remaining());
    const waitUntil = () => (replace ? performance.now() + timeoutMs : overall);
    const reuse = async (): Promise<ConsoleStartResult | undefined> => {
      const lock = readLock(rootDir);
      // A live pid that is our daemon for this root but slow to answer is retried, never taken for "no server".
      const active = lock && !lockBeforeBoot(lock) && pidAlive(lock.pid) ? lock : undefined;
      const owner = active ? inspectDaemonProcess(active.pid, rootDir) : undefined;
      const ours = owner === true;
      const live = await liveServer(rootDir, token, ours ? 4 : 1, probeMs);
      if (live?.health.version === version)
        return result(token, options.project, live.lock.port, live.lock.pid, version, true, requested);
      if (!active) return undefined;
      const existing = live ? { existingBaseUrl: `http://127.0.0.1:${live.lock.port}/` } : {};
      if (!ours) return live || owner === undefined ? { error: inspectionRefusal(active.pid), ...existing } : undefined;
      if (!live && bootTimeMs() === undefined) return { error: inspectionRefusal(active.pid) };
      if (!replace)
        return {
          ...existing,
          error: live
            ? `A console server of another version (${live.health.version}) is running (pid ${active.pid}); it was left running. Run pnpm console to restart it.`
            : `The console server is busy (pid ${active.pid} did not answer in time); it was left running.`,
        };
      // Our daemon for this root with another version (the bundle or the server changed), or hung: replace it.
      if ((live && live.lock.pid !== active.pid) || inspectDaemonProcess(active.pid, rootDir) !== true)
        return { error: inspectionRefusal(active.pid) };
      if (!(await terminate(active.pid, 5000)) && !(await terminate(active.pid, 1000, "SIGKILL")))
        return { error: `Console process ${active.pid} did not exit. Its lock was left in place.` };
      removeLockIfOwned(rootDir, active.pid);
      return undefined;
    };
    const reused = await reuse();
    if (reused) return reused;

    const release = acquireStartLock(rootDir);
    if (!release) {
      // Another caller is starting it: wait for its lock and health.
      const deadline = waitUntil();
      while (performance.now() < deadline) {
        await delay(100);
        const live = await liveServer(rootDir, token, 1, probeMs);
        if (live?.health.version === version)
          return result(token, options.project, live.lock.port, live.lock.pid, version, true, requested);
      }
      return { error: "Another process is starting the console server and it did not answer in time." };
    }
    try {
      const again = await reuse();
      if (again) return again;
      if (!replace && remaining() < 250)
        return { error: `The console server could not be started within ${timeoutMs} ms.` };
      const stale = readLock(rootDir);
      if (stale && !pidAlive(stale.pid)) removeLockIfOwned(rootDir, stale.pid);
      const log = path.join(rootDir, SERVER_LOG_FILE);
      rotateLog(log);
      const fd = openSync(log, "a", 0o600);
      let tsx: string;
      try {
        // tsx's loader in this process (not its CLI, which would run the daemon in a second process with another pid).
        tsx = pathToFileURL(createRequire(path.join(codeRoot(), "package.json")).resolve("tsx")).href;
      } catch {
        closeSync(fd);
        return { error: "tsx is not installed; run pnpm install." };
      }
      const child = spawn(
        process.execPath,
        [
          "--import",
          tsx,
          DAEMON,
          "--root",
          rootDir,
          "--port",
          String(requested),
          "--version",
          version,
          ...(options.daemonArgs ?? []),
        ],
        { cwd: rootDir, detached: true, shell: false, stdio: ["ignore", fd, fd], env: daemonEnv(), windowsHide: true },
      );
      closeSync(fd);
      let exited: number | null | undefined;
      child.on("exit", (code) => (exited = code));
      child.on("error", () => (exited = -1));
      child.unref();
      const pid = child.pid;
      if (!pid) return { error: "The console server process could not be spawned." };
      const deadline = waitUntil();
      while (performance.now() < deadline) {
        if (exited !== undefined) {
          const tail = logTail(log);
          return { error: `The console server exited (code ${exited}).${tail ? ` Log: ${tail}` : ""}` };
        }
        const lock = readLock(rootDir);
        if (lock?.pid === pid) {
          const live = await liveServer(rootDir, token, 1, probeMs);
          if (live?.lock.pid === pid) return result(token, options.project, lock.port, pid, version, false, requested);
        }
        await delay(50);
      }
      // Never leave an orphan holding the port: the starter that gave up stops its own child.
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
      return { error: `The console server did not answer within ${timeoutMs} ms; see ${SERVER_LOG_FILE}.`, pid };
    } finally {
      release();
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface StopResult {
  stopped: boolean;
  pid?: number;
  port?: number;
  reason?: string;
}

/**
 * Stops the server named by the lock: verified first (the pid belongs to this user and its command line is this
 * daemon with `--root <rootDir>`), then SIGTERM, then SIGKILL after `timeoutMs`; a lock whose pid is gone, predates
 * this boot or is not our daemon is removed and the process left alone.
 */
export async function stopConsoleServer(options: { rootDir: string; timeoutMs?: number }): Promise<StopResult> {
  const rootDir = realpathSync(options.rootDir);
  const lock = readLock(rootDir);
  if (!lock) return { stopped: false, reason: "No console server is running (no lock)." };
  if (!pidAlive(lock.pid) || lockBeforeBoot(lock)) {
    removeLockIfOwned(rootDir, lock.pid);
    return { stopped: false, pid: lock.pid, port: lock.port, reason: "The lock was stale (process gone); removed it." };
  }
  const owner = inspectDaemonProcess(lock.pid, rootDir);
  if (owner === undefined)
    return { stopped: false, pid: lock.pid, port: lock.port, reason: inspectionRefusal(lock.pid) };
  if (!owner || bootTimeMs() === undefined) {
    const token = readSessionToken(rootDir);
    const live = token ? await liveServer(rootDir, token) : undefined;
    if (owner ? live?.lock.pid !== lock.pid || inspectDaemonProcess(lock.pid, rootDir) !== true : live)
      return { stopped: false, pid: lock.pid, port: lock.port, reason: inspectionRefusal(lock.pid) };
  }
  if (!owner) {
    removeLockIfOwned(rootDir, lock.pid);
    return {
      stopped: false,
      pid: lock.pid,
      port: lock.port,
      reason: "The lock names a process that is not a console server; removed the lock and left the process alone.",
    };
  }
  let stopped = await terminate(lock.pid, options.timeoutMs ?? 5000);
  if (!stopped) stopped = await terminate(lock.pid, 1000, "SIGKILL");
  if (stopped) removeLockIfOwned(rootDir, lock.pid);
  return stopped
    ? { stopped: true, pid: lock.pid, port: lock.port }
    : { stopped: false, pid: lock.pid, port: lock.port, reason: "The server did not exit." };
}
