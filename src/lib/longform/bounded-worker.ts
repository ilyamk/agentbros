import { spawn, spawnSync } from "node:child_process";
import { CliErrorObject } from "../cli";

type ProcessIdentity = { pid: number; ppid: number; identity: string };
function processSnapshot(): ProcessIdentity[] {
  // Identity is pid plus start time. Not comm: Linux renames a starting Node process's main thread ("MainThread"), so a
  // snapshot taken at spawn would no longer match the same process a moment later and it would escape cleanup.
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,lstart="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("Could not enumerate owned render processes");
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), identity: match[3] }] : [];
  });
}
function descendants(rows: ProcessIdentity[], root: number) {
  const included = new Set([root]);
  for (let pass = 0; pass < rows.length; pass++) {
    let changed = false;
    for (const row of rows)
      if (!included.has(row.pid) && included.has(row.ppid)) {
        included.add(row.pid);
        changed = true;
      }
    if (!changed) break;
  }
  return rows.filter((row) => included.has(row.pid));
}
function signalIdentities(owned: ProcessIdentity[], signal: NodeJS.Signals) {
  const current = processSnapshot();
  // Verify captured start time and executable before targeting retained PIDs.
  for (const row of [...owned].reverse())
    if (current.some((p) => p.pid === row.pid && p.identity === row.identity)) {
      try {
        process.kill(row.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
}
/** Trusted worker handshake: parent verifies live ancestry before acknowledging registration. */
export async function registerOwnedRenderProcesses() {
  if (!process.send) return;
  const processes = process.platform === "win32" ? [] : descendants(processSnapshot(), process.pid);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off("message", message);
      reject(new Error("Owned render registration was not acknowledged"));
    }, 10000);
    const message = (raw: unknown) => {
      if (raw && typeof raw === "object" && "type" in raw && raw.type === "ownership-registered") {
        clearTimeout(timer);
        process.off("message", message);
        resolve();
      }
    };
    process.on("message", message);
    process.send!({ type: "owned-processes", processes }, (error) => {
      if (error) {
        clearTimeout(timer);
        process.off("message", message);
        reject(error);
      }
    });
  });
}
export type WorkerBounds = {
  timeoutMs?: number;
  stallTimeoutMs?: number;
  signal?: AbortSignal;
  onRegisteredRoot?: (pid: number) => Promise<void> | void;
};
function bound(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1000 || value > 7200000)
    throw new Error(`${label} must be an integer from 1000 to 7200000ms`);
  return value;
}

/** Isolated, literal-argv local job. No automatic retry or arbitrary process-name cleanup. */
export function runBoundedRenderWorker(executable: string, argv: string[], cwd: string, options: WorkerBounds = {}) {
  if (options.signal?.aborted)
    return Promise.reject(new CliErrorObject({ code: "TIMEOUT", message: "Worker cancelled before launch" }));
  const timeoutMs = bound(options.timeoutMs ?? 7200000, "Render deadline");
  const stallMs = bound(options.stallTimeoutMs ?? 300000, "Render progress bound");
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, argv, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let failure: Error | undefined,
      stderr = "",
      rendered = -1,
      encoded = -1,
      changedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined,
      finished = false,
      exited = false,
      spawned = false;
    let owned: ProcessIdentity[] = [];
    let rejectRegistration: ((error: Error) => void) | undefined;
    const cleanup = () => {
      options.signal?.removeEventListener("abort", cancelled);
      clearTimeout(deadline);
      clearInterval(watchdog);
      if (timer) clearTimeout(timer);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      child.unref();
      child.stderr?.destroy();
      try {
        if (child.connected) child.disconnect();
      } catch (error) {
        failure ??= new CliErrorObject({
          code: "INTERNAL",
          message: `Worker channel cleanup failed: ${String(error)}`,
        });
      }
      if (failure) reject(failure);
      else resolve();
    };
    const captureOwned = () => {
      if (!child.pid || process.platform === "win32") return;
      const current = processSnapshot();
      // Retained roots can reparent and then create fresh grandchildren during shutdown.
      // A remembered PID alone is never enough to reacquire an ownership root.
      const roots = owned
        .filter((identity) => current.some((row) => row.pid === identity.pid && row.identity === identity.identity))
        .map((row) => row.pid);
      if (!exited && !owned.some((row) => row.pid === child.pid)) roots.push(child.pid);
      const observed = roots.flatMap((root) => descendants(current, root));
      for (const row of observed)
        if (!owned.some((p) => p.pid === row.pid && p.identity === row.identity)) owned.push(row);
    };
    const kill = (signal: NodeJS.Signals) => {
      if (process.platform === "win32") {
        if (child.pid)
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { timeout: 5000, stdio: "ignore" });
      } else {
        // Group signaling is allowed only while the owned leader is still alive.
        if (
          !exited &&
          child.pid &&
          processSnapshot().some((row) =>
            owned.some((p) => p.pid === child.pid && row.pid === p.pid && row.identity === p.identity),
          )
        )
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        signalIdentities(owned, signal);
      }
    };
    const abort = (reason: string, code: "TIMEOUT" | "INTERNAL" = "TIMEOUT") => {
      if (failure || finished) return;
      failure = new CliErrorObject({ code, message: reason });
      rejectRegistration?.(failure);
      try {
        captureOwned();
        kill("SIGTERM");
      } catch (error) {
        failure = new CliErrorObject({ code: "INTERNAL", message: `Owned render cleanup failed: ${String(error)}` });
        child.kill("SIGTERM");
      }
      timer = setTimeout(() => {
        try {
          captureOwned();
          kill("SIGKILL");
        } catch (error) {
          failure = new CliErrorObject({
            code: "INTERNAL",
            message: `Render timed out; owned process cleanup incomplete: ${String(error)}`,
          });
          child.kill("SIGKILL");
        }
        // Kernel/transport failure cannot turn the caller's deadline into an infinite wait.
        timer = setTimeout(() => {
          if (!exited)
            failure = new CliErrorObject({
              code: "INTERNAL",
              message: "Render timed out; worker did not report exit after forced owned cleanup",
            });
          finish();
        }, 500);
      }, 1000);
    };
    const cancelled = () => abort("Worker cancelled");
    options.signal?.addEventListener("abort", cancelled, { once: true });
    const deadline = setTimeout(
      () => abort(`Chapter render exceeded ${timeoutMs}ms deadline; verified chapters remain cached`),
      timeoutMs,
    );
    const watchdog = setInterval(
      () => {
        try {
          captureOwned();
        } catch (error) {
          abort(String(error));
        }
        if (Date.now() - changedAt >= stallMs)
          abort(
            `Chapter renderer made no rendered/encoded frame progress for ${stallMs}ms; verified chapters remain cached`,
          );
      },
      Math.min(1000, stallMs),
    );
    child.stderr!.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-32768);
      process.stderr.write(data);
    });
    let registration: Promise<void> | undefined;
    child.once("spawn", () => {
      spawned = true;
      try {
        captureOwned();
        if (options.onRegisteredRoot && !failure) {
          // Direct-spawn identity is trusted before the child can delay its receipt.
          // The receipt still independently validates ancestry before activation ACK.
          registration = (async () => {
            let registrationTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                Promise.resolve().then(() => options.onRegisteredRoot!(child.pid!)),
                new Promise<never>((_, reject) => {
                  rejectRegistration = reject;
                  registrationTimer = setTimeout(() => reject(Error("Trusted root registration timeout")), 10000);
                }),
              ]);
            } finally {
              clearTimeout(registrationTimer);
              rejectRegistration = undefined;
            }
          })();
          void registration.catch((error) => abort(String(error), "INTERNAL"));
        }
      } catch (error) {
        abort(String(error), "INTERNAL");
      }
    });
    child.on("message", async (raw) => {
      if (finished || failure) return;
      if (
        raw &&
        typeof raw === "object" &&
        "type" in raw &&
        raw.type === "owned-processes" &&
        "processes" in raw &&
        Array.isArray(raw.processes)
      ) {
        try {
          const current = process.platform === "win32" ? [] : processSnapshot();
          const observed = descendants(current, child.pid!);
          for (const claim of raw.processes) {
            if (
              !claim ||
              typeof claim !== "object" ||
              !Number.isSafeInteger(claim.pid) ||
              !Number.isSafeInteger(claim.ppid) ||
              typeof claim.identity !== "string"
            )
              throw new Error("Invalid owned-process receipt");
            // Transient ps/encoder children may have exited between the two snapshots.
            if (!current.some((row) => row.pid === claim.pid && row.identity === claim.identity)) continue;
            if (
              !observed.some(
                (row) => row.pid === claim.pid && row.ppid === claim.ppid && row.identity === claim.identity,
              )
            )
              throw new Error("Invalid owned-process receipt");
            if (!owned.some((row) => row.pid === claim.pid && row.identity === claim.identity)) owned.push(claim);
          }
          if (options.onRegisteredRoot) {
            if (!registration) throw Error("Worker receipt preceded direct-spawn registration");
            await registration;
          }
          if (finished || failure || options.signal?.aborted) return;
          child.send({ type: "ownership-registered" }, (error) => {
            if (error) abort(error.message, "INTERNAL");
          });
        } catch (error) {
          abort(String(error), "INTERNAL");
        }
        return;
      }
      if (rendered === -1)
        try {
          captureOwned();
        } catch (error) {
          abort(String(error));
        }
      if (!raw || typeof raw !== "object" || !("renderedFrames" in raw) || !("encodedFrames" in raw)) return;
      const message = raw as { renderedFrames: number; encodedFrames: number };
      if (!Number.isSafeInteger(message.renderedFrames) || !Number.isSafeInteger(message.encodedFrames)) return;
      // Repeated heartbeat callbacks must not conceal a stalled render.
      if (message.renderedFrames > rendered || message.encodedFrames > encoded) changedAt = Date.now();
      rendered = Math.max(rendered, message.renderedFrames);
      encoded = Math.max(encoded, message.encodedFrames);
    });
    child.on("error", (error) => {
      if (!spawned) {
        failure = error;
        exited = true;
        finish();
      } else abort(error.message, "INTERNAL");
    });
    if (options.signal?.aborted) cancelled();
    child.on("exit", (code) => {
      exited = true;
      if (failure && timer) return; // Escalate surviving owned descendants even if worker exits early.
      if (code !== 0) failure = new Error(`Chapter renderer exited ${code}: ${stderr}`);
      try {
        captureOwned();
        kill("SIGKILL");
      } catch (error) {
        failure = new CliErrorObject({ code: "INTERNAL", message: `Owned worker cleanup failed: ${String(error)}` });
      }
      finish();
    });
  });
}
