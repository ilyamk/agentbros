/**
 * The console server's lock (RFC 0004 D16): `out/console/server.json` {pid, port, version, startedAt, url} lets every
 * caller reuse the running server. A lock counts only when its pid is alive and `GET /api/health` on its port answers
 * with that pid; a start lock (`server.starting`, exclusive) keeps two concurrent callers from starting two servers.
 */
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { uptime } from "node:os";
import { request } from "node:http";
import path from "node:path";
import {
  CONSOLE_OUT_DIR,
  CONSOLE_TOKEN_HEADER,
  SERVER_LOCK_FILE,
  ServerLockSchema,
  type ServerLock,
} from "../../types/console";

export const lockPath = (rootDir: string) => path.join(rootDir, SERVER_LOCK_FILE);
export const startLockPath = (rootDir: string) => path.join(rootDir, CONSOLE_OUT_DIR, "server.starting");
const START_LOCK_STALE_MS = 20_000;

export function readLock(rootDir: string): ServerLock | undefined {
  try {
    const parsed = ServerLockSchema.safeParse(JSON.parse(readFileSync(lockPath(rootDir), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write (temporary file and rename). */
export function writeLock(rootDir: string, lock: ServerLock): void {
  const file = lockPath(rootDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o644);
  try {
    writeSync(fd, JSON.stringify(ServerLockSchema.parse(lock), null, 2) + "\n");
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

/** Removes the lock only when it still names `pid`. */
export function removeLockIfOwned(rootDir: string, pid: number): void {
  if (readLock(rootDir)?.pid === pid) rmSync(lockPath(rootDir), { force: true });
}

export const removeLock = (rootDir: string) => rmSync(lockPath(rootDir), { force: true });

/** True while a process with this pid exists (EPERM counts as alive). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Health {
  ok: true;
  version: string;
  pid: number;
  port: number;
  startedAt: string;
  /** HMAC-SHA256(token, nonce) in hex: proves the answer comes from a holder of this machine's token. */
  proof: string;
}

/** The proof a console server returns for a health nonce: the token never travels in the probe. */
export const healthProof = (token: string, nonce: string) =>
  createHmac("sha256", token).update(`agentbros-console-health:${nonce}`).digest("hex");

/**
 * `GET /api/health?nonce=<random>` on 127.0.0.1:`port`, without the token: the answer counts only when its `proof`
 * is the HMAC of the nonce under our token, so whatever else listens on a stale lock's port learns nothing.
 */
export function probeHealth(port: number, token: string, timeoutMs = 1000): Promise<Health | undefined> {
  const nonce = randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: `/api/health?nonce=${nonce}`,
        method: "GET",
        headers: { Host: `127.0.0.1:${port}` },
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          if (chunks.length > 64) req.destroy();
        });
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<Health>;
            const expected = Buffer.from(healthProof(token, nonce));
            const proof = Buffer.from(typeof body.proof === "string" ? body.proof : "");
            resolve(
              res.statusCode === 200 &&
                body.ok === true &&
                typeof body.version === "string" &&
                typeof body.pid === "number" &&
                proof.length === expected.length &&
                timingSafeEqual(proof, expected)
                ? (body as Health)
                : undefined,
            );
          } catch {
            resolve(undefined);
          }
        });
        res.on("error", () => resolve(undefined));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

/** Machine boot time, with some slack for rounding. A restricted process may be unable to read it. */
export function bootTimeMs(): number | undefined {
  try {
    return Date.now() - uptime() * 1000 - 5000;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { info?: { code?: string } };
    if (["EPERM", "EACCES", "ENOSYS"].includes(failure.info?.code ?? failure.code ?? "")) return undefined;
    throw error;
  }
}

/** A lock written before this boot names a pid that may have been reused since: never trust or signal it. */
export function lockBeforeBoot(lock: ServerLock): boolean {
  const boot = bootTimeMs();
  return boot !== undefined && Date.parse(lock.startedAt) < boot;
}

/** The daemon file as it appears on a daemon's command line. */
export const DAEMON_MARK = path.join("src", "lib", "console", "daemon");

/**
 * True for this user's console daemon serving `rootDir`, false for another known process and undefined when process
 * inspection is unavailable. Sending a signal requires a positive match.
 */
export function inspectDaemonProcess(pid: number, rootDir: string): boolean | undefined {
  if (process.platform === "win32" || typeof process.getuid !== "function") return undefined;
  try {
    const out = spawnSync("ps", ["-o", "uid=", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      shell: false,
      timeout: 2000,
    });
    if (out.status !== 0) return undefined;
    const match = /^\s*(\d+)\s+(.*)$/s.exec(out.stdout.trim());
    if (!match) return undefined;
    if (Number(match[1]) !== process.getuid()) return false;
    const command = match[2]!;
    return command.includes(DAEMON_MARK) && command.includes(`--root ${rootDir} `);
  } catch {
    return undefined;
  }
}

export const daemonProcessMatches = (pid: number, rootDir: string): boolean =>
  inspectDaemonProcess(pid, rootDir) === true;

/**
 * The live server named by the lock. The PID is alive, the lock does not predate a known boot, and the health answer
 * proves the token and names the lock's PID. `attempts` retries a slow health answer.
 */
export async function liveServer(
  rootDir: string,
  token: string,
  attempts = 1,
  /** Each probe's timeout (default 1 s); a caller with a deadline passes what is left, and 0 stops probing. */
  probeMs?: () => number,
): Promise<{ lock: ServerLock; health: Health } | undefined> {
  const lock = readLock(rootDir);
  if (!lock || lockBeforeBoot(lock) || !pidAlive(lock.pid)) return undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timeout = probeMs ? Math.floor(probeMs()) : 1000;
    if (timeout <= 0) return undefined;
    const health = await probeHealth(lock.port, token, timeout);
    if (health) return health.pid === lock.pid ? { lock, health } : undefined;
    if (!pidAlive(lock.pid)) return undefined;
  }
  return undefined;
}

/**
 * Takes the exclusive start lock; undefined when another live caller holds it. Returns the release function.
 * A stale start lock is taken over atomically: renamed to a unique name, checked to be the one judged stale (a fresh
 * lock taken meanwhile is linked back), then the exclusive create is retried.
 */
export function acquireStartLock(rootDir: string): (() => void) | undefined {
  const file = startLockPath(rootDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), id: randomBytes(8).toString("hex") });
  const release = () => {
    try {
      if (readFileSync(file, "utf8") === mine) rmSync(file, { force: true });
    } catch {
      // already gone
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o644);
      writeSync(fd, mine);
      closeSync(fd);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let content = "";
    let age = 0;
    try {
      content = readFileSync(file, "utf8");
      age = Date.now() - statSync(file).mtimeMs;
    } catch {
      continue; // released meanwhile: retry the create
    }
    let holder: number | undefined;
    try {
      holder = (JSON.parse(content) as { pid?: number }).pid;
    } catch {
      holder = undefined;
    }
    if ((holder && pidAlive(holder) && age < START_LOCK_STALE_MS) || (!holder && age < 1000)) return undefined;
    const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(file, aside);
    } catch {
      continue;
    }
    let taken = "";
    try {
      taken = readFileSync(aside, "utf8");
    } catch {
      taken = "";
    }
    if (taken !== content) {
      // We moved a fresh lock another caller had just taken: put it back (link fails if a newer one exists).
      try {
        linkSync(aside, file);
      } catch {
        // a newer lock exists; leave it
      }
      rmSync(aside, { force: true });
      return undefined;
    }
    rmSync(aside, { force: true });
  }
  return undefined;
}

/** Sends `signal` and waits until the pid is gone; true when it exited within `timeoutMs`. */
export async function terminate(pid: number, timeoutMs = 5000, signal: NodeJS.Signals = "SIGTERM"): Promise<boolean> {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !pidAlive(pid);
}
