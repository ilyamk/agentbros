import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, accessSync, constants } from "node:fs";
import path from "node:path";
export type RhythmProcessIdentity = {
  readonly pid: number;
  readonly ppid: number;
  readonly start: string;
  readonly command: string;
};
/** Start identity survives exec; command is observation only, never signal authority. */
export function parseRhythmProcessRows(text: string): RhythmProcessIdentity[] {
  return text.split("\n").flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!m || !Number.isSafeInteger(Number(m[1])) || !Number.isSafeInteger(Number(m[2]))) return [];
    return [{ pid: Number(m[1]), ppid: Number(m[2]), start: m[3].replace(/\s+/g, " "), command: m[4] }];
  });
}
const sameBirth = (a: RhythmProcessIdentity, b: RhythmProcessIdentity) => a.pid === b.pid && a.start === b.start;
/** Pure ownership discovery; remembered PIDs never reacquire a different birth. */
export function captureRhythmOwned(
  rows: readonly RhythmProcessIdentity[],
  owned: readonly RhythmProcessIdentity[],
  direct: { pid: number; parentPid: number; live: boolean },
): RhythmProcessIdentity[] {
  const roots = new Set(owned.filter((x) => rows.some((r) => sameBirth(r, x))).map((x) => x.pid));
  if (
    direct.live &&
    !owned.some((x) => x.pid === direct.pid) &&
    rows.some((x) => x.pid === direct.pid && x.ppid === direct.parentPid)
  )
    roots.add(direct.pid);
  for (let pass = 0; pass < rows.length; pass++) {
    let added = false;
    for (const r of rows)
      if (roots.has(r.ppid) && !roots.has(r.pid) && !owned.some((x) => x.pid === r.pid && !sameBirth(x, r))) {
        roots.add(r.pid);
        added = true;
      }
    if (!added) break;
  }
  const result = owned.map((x) => {
    const observed = rows.find((r) => roots.has(r.pid) && sameBirth(r, x));
    return observed ? { ...x, command: observed.command } : x;
  });
  for (const r of rows) if (roots.has(r.pid) && !owned.some((x) => x.pid === r.pid)) result.push(r);
  return result;
}
/** Both group permission and exact targets depend on immutable known birth, not comm. */
export function selectRhythmSignalTargets(
  rows: readonly RhythmProcessIdentity[],
  owned: readonly RhythmProcessIdentity[],
  direct: { pid: number; live: boolean },
) {
  const targets = [...owned].reverse().filter((x) => rows.some((r) => sameBirth(r, x))),
    leader = owned.find((x) => x.pid === direct.pid);
  return { targets, groupPid: direct.live && leader && rows.some((r) => sameBirth(r, leader)) ? direct.pid : null };
}
function processes(): RhythmProcessIdentity[] {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,comm="], {
    encoding: "utf8",
    timeout: 1000,
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH },
  });
  if (result.status !== 0) throw Error("Rhythm owned process identity unavailable");
  return parseRhythmProcessRows(result.stdout);
}
export type RhythmProcessBounds = {
  timeoutMs: number;
  stallMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  signal?: AbortSignal;
};
/** Internal trusted host tool runner, not request authority. Fixed installed tools do not author scripts. */
export type TrustedRhythmProcessChannels = { inheritedFd: number; input: Buffer; env: Record<string, string> };
export function runRhythmOwnedProcess(
  executable: string,
  argv: string[],
  bounds: RhythmProcessBounds,
  channels?: TrustedRhythmProcessChannels,
): Promise<{ stdout: Buffer; stderrBytes: number }> {
  for (const [name, value, max] of [
    ["timeout", bounds.timeoutMs, 90000],
    ["stall", bounds.stallMs, 10000],
    ["stdout", bounds.stdoutBytes, 19200000],
    ["stderr", bounds.stderrBytes, 262144],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error(`Invalid rhythm process ${name} bound`);
  if (!path.isAbsolute(executable) || bounds.signal?.aborted)
    throw Error("Rhythm process unavailable/cancelled before spawn");
  if (
    channels &&
    (!Number.isSafeInteger(channels.inheritedFd) ||
      channels.inheritedFd < 3 ||
      !Buffer.isBuffer(channels.input) ||
      channels.input.length > 2048)
  )
    throw Error("Rhythm trusted inherited FD/input bounds");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      shell: false,
      detached: true,
      stdio: channels ? ["pipe", "pipe", "pipe", channels.inheritedFd] : ["ignore", "pipe", "pipe"],
      env: channels?.env ?? { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    });
    let failure: Error | undefined,
      finished = false,
      exited = false,
      lastProgress = Date.now(),
      outBytes = 0,
      errBytes = 0;
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    let owned: RhythmProcessIdentity[] = [];
    let force: ReturnType<typeof setTimeout> | undefined, final: ReturnType<typeof setTimeout> | undefined;
    const capture = () => {
      if (!child.pid) return;
      owned = captureRhythmOwned(processes(), owned, { pid: child.pid, parentPid: process.pid, live: !exited });
      if (!exited && !owned.some((x) => x.pid === child.pid))
        throw Error("Rhythm direct spawned birth identity unavailable");
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      const selection = selectRhythmSignalTargets(processes(), owned, { pid: child.pid, live: !exited });
      if (selection.groupPid !== null) {
        try {
          process.kill(-selection.groupPid, signal);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
      }
      for (const r of selection.targets) {
        try {
          process.kill(r.pid, signal);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
      }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearInterval(watch);
      clearTimeout(force);
      clearTimeout(final);
      bounds.signal?.removeEventListener("abort", cancel);
      process.off("SIGTERM", cancel);
      process.off("disconnect", cancel);
      child.stdout!.destroy();
      child.stderr!.destroy();
      child.unref();
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(output, outBytes), stderrBytes: errBytes });
    };
    const abort = (message: string) => {
      if (failure || finished) return;
      failure = Error(message);
      try {
        capture();
        kill("SIGTERM");
      } catch (e) {
        failure = Error(`${message}; cleanup: ${String(e)}`);
        child.kill("SIGTERM");
      }
      force = setTimeout(() => {
        try {
          capture();
          kill("SIGKILL");
        } catch (e) {
          failure = Error(`${failure?.message}; force cleanup: ${String(e)}`);
          child.kill("SIGKILL");
        }
        final = setTimeout(() => {
          failure = Error(`${failure?.message}; child cleanup exit not confirmed`);
          finish();
        }, 500);
      }, 250);
    };
    const cancel = () => abort("Rhythm process cancelled");
    bounds.signal?.addEventListener("abort", cancel, { once: true });
    process.once("SIGTERM", cancel);
    process.once("disconnect", cancel);
    const deadline = setTimeout(() => abort("Rhythm process deadline exceeded"), bounds.timeoutMs),
      watch = setInterval(
        () => {
          if (finished) return;
          try {
            capture();
          } catch (e) {
            abort(String(e));
          }
          if (Date.now() - lastProgress >= bounds.stallMs) abort("Rhythm process stalled");
        },
        Math.min(100, bounds.stallMs),
      );
    child.once("spawn", () => {
      try {
        capture();
      } catch (e) {
        abort(String(e));
      }
      if (bounds.signal?.aborted) cancel();
    });
    child.stdout!.on("data", (bytes: Buffer) => {
      if (finished || failure) return;
      lastProgress = Date.now();
      if (outBytes + bytes.length > bounds.stdoutBytes) {
        abort("Rhythm stdout byte bound");
        return;
      }
      output.push(bytes);
      outBytes += bytes.length;
    });
    child.stderr!.on("data", (bytes: Buffer) => {
      if (finished || failure) return;
      lastProgress = Date.now();
      if (errBytes + bytes.length > bounds.stderrBytes) {
        abort("Rhythm stderr byte bound");
        return;
      }
      errors.push(bytes);
      errBytes += bytes.length;
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("exit", (code) => {
      try {
        capture();
      } catch (e) {
        failure ??= Error(String(e));
      }
      exited = true;
      if (!failure && code !== 0)
        failure = Error(`Rhythm tool failed (${code}): ${Buffer.concat(errors).toString("utf8").slice(-2000)}`);
    });
    child.once("close", () => {
      try {
        capture();
        kill("SIGKILL");
      } catch (e) {
        failure ??= Error(`Rhythm final cleanup: ${String(e)}`);
      }
      finish();
    });
    if (channels) {
      child.stdin!.on("error", (error) => {
        abort(`Rhythm metadata stdin: ${String(error)}`);
      });
      child.stdin!.end(channels.input);
    }
  });
}
/** Fixed names resolved only from host installation PATH; no tool path appears in request schemas. */
export function resolveRhythmTool(name: "ffmpeg" | "ffprobe") {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    if (!existsSync(candidate)) continue;
    const file = realpathSync(candidate),
      stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    accessSync(file, constants.X_OK);
    return file;
  }
  throw Error(`Rhythm installed ${name} unavailable; no automatic install/download`);
}
export function runRhythmTool(file: string, argv: string[], bounds: RhythmProcessBounds) {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
    throw Error("Rhythm OS deny-network preparation unavailable");
  return runRhythmOwnedProcess(
    "/usr/bin/sandbox-exec",
    ["-p", "(version 1)(allow default)(deny network*)", file, ...argv],
    bounds,
  );
}
