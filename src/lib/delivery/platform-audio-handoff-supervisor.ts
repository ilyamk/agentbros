import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { z } from "zod";
import { StringDecoder } from "node:string_decoder";
import { HandoffOwnership, handoffProcessInventory, type HandoffProcess } from "./platform-audio-handoff-ownership";
export const HandoffJobSchema = z
  .object({
    request: z
      .string()
      .min(1)
      .max(1024)
      .refine((v) => !/[\u0000-\u001f]/.test(v) && !v.split(/[\\/]/).some((p) => /^\.env(?:\.|$)/.test(p))),
    snapshot: z
      .string()
      .min(1)
      .max(1024)
      .refine((v) => !/[\u0000-\u001f]/.test(v) && !v.split(/[\\/]/).some((p) => /^\.env(?:\.|$)/.test(p))),
    project: z
      .string()
      .max(160)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .optional(),
    recover: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
type Job = z.infer<typeof HandoffJobSchema>;
const LIMIT = 1024 * 1024;
const HandoffResultSchema = z
  .object({
    ok: z.literal(true),
    marker: z.string().min(1).max(2048),
    packetId: z.string().regex(/^[a-f0-9]{64}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.literal("draft-needs-review"),
    productionReady: z.literal(false),
    status: z.literal("pending-manual"),
    recovered: z.boolean(),
  })
  .strict();
export class HandoffWorkerError extends Error {
  constructor(
    message: string,
    readonly publication: "not-started" | "unknown",
    readonly code: "VALIDATION" | "TIMEOUT" | "INTERNAL" = "VALIDATION",
  ) {
    super(message);
  }
}
/** Private injected process seam. Production CLI always supplies the fixed sandbox factory below. */
export function superviseHandoffProcess(
  factory: (nonce: string) => ChildProcess,
  job: Job,
  dependencies: {
    inventory: () => HandoffProcess[];
    signal: (pid: number, signal: NodeJS.Signals) => void;
    workMs: number;
    cleanupMs: number;
    abort?: AbortSignal;
  },
) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const nonce = randomBytes(24).toString("hex"),
      ownership = new HandoffOwnership(),
      decoder = new StringDecoder("utf8");
    let child: ChildProcess | undefined,
      started = false,
      registered = false,
      closed = false,
      settled = false,
      failure: Error | undefined;
    let stdout = "",
      stderrBytes = 0,
      stdoutBytes = 0,
      cleanupStarted = false,
      cleanupVerified = false;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined,
      escalation: ReturnType<typeof setTimeout> | undefined,
      observer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(watch);
      clearTimeout(cleanupDeadline);
      clearTimeout(escalation);
      clearTimeout(observer);
      dependencies.abort?.removeEventListener("abort", cancelled);
      if (child?.connected)
        try {
          child.disconnect();
        } catch {}
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      if (!cleanupVerified)
        failure ??= new HandoffWorkerError(
          "Known owned cleanup could not be verified",
          started ? "unknown" : "not-started",
          "INTERNAL",
        );
      if (failure) {
        reject(failure);
        return;
      }
      try {
        const lines = (stdout + decoder.end()).trim().split("\n");
        if (lines.length !== 1) throw Error("Worker must return exactly one JSON line");
        const result = HandoffResultSchema.parse(JSON.parse(lines[0]));
        resolve({ ...result, knownOwnedCleanupVerified: true });
      } catch (e) {
        reject(
          new HandoffWorkerError(
            e instanceof Error ? e.message : "Invalid worker result",
            started ? "unknown" : "not-started",
          ),
        );
      }
    };
    const capture = () => {
      const rows = dependencies.inventory();
      if (!registered && child?.pid && !closed) {
        ownership.register(child.pid, process.pid, rows);
        registered = true;
      } else ownership.capture(rows);
      return rows;
    };
    const signalOwned = (signal: NodeJS.Signals) => {
      try {
        for (const row of ownership.targets(capture()))
          try {
            dependencies.signal(row.pid, signal);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
          }
      } catch {
        failure ??= new HandoffWorkerError(
          "Owned cleanup inventory unavailable",
          started ? "unknown" : "not-started",
          "INTERNAL",
        );
      }
      // ChildProcess retains the directly spawned unreaped child; never accepts a caller PID.
      if (child && !closed)
        try {
          child.kill(signal);
        } catch {}
    };
    const observe = () => {
      if (settled) return;
      try {
        if (closed && ownership.targets(capture()).length === 0) {
          cleanupVerified = true;
          finish();
          return;
        }
      } catch {
        failure ??= new HandoffWorkerError(
          "Owned cleanup observation unavailable",
          started ? "unknown" : "not-started",
          "INTERNAL",
        );
      }
      observer = setTimeout(observe, 20);
    };
    const cleanup = () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      clearTimeout(deadline);
      signalOwned(failure ? "SIGTERM" : "SIGKILL");
      escalation = setTimeout(() => signalOwned("SIGKILL"), Math.min(100, dependencies.cleanupMs / 2));
      cleanupDeadline = setTimeout(() => {
        signalOwned("SIGKILL");
        finish();
      }, dependencies.cleanupMs);
      observe();
    };
    const fail = (message: string, code: "VALIDATION" | "TIMEOUT" | "INTERNAL" = "VALIDATION") => {
      if (failure || settled) return;
      failure = new HandoffWorkerError(message, started ? "unknown" : "not-started", code);
      cleanup();
    };
    const cancelled = () =>
      fail("Native handoff cancelled; inspect exact marker, never automatically replay", "TIMEOUT");
    const deadline = setTimeout(
      () => fail("Native handoff deadline; inspect exact marker, never automatically replay", "TIMEOUT"),
      dependencies.workMs,
    );
    const watch = setInterval(() => {
      if (!settled && !cleanupStarted)
        try {
          capture();
        } catch {
          fail("Owned inventory changed/unavailable", "INTERNAL");
        }
    }, 100);
    if (dependencies.abort?.aborted) {
      closed = true;
      cleanupVerified = true;
      failure = new HandoffWorkerError("Native handoff cancelled before launch", "not-started", "TIMEOUT");
      finish();
      return;
    }
    dependencies.abort?.addEventListener("abort", cancelled, { once: true });
    try {
      child = factory(nonce);
    } catch (e) {
      failure = new HandoffWorkerError(e instanceof Error ? e.message : "Worker unavailable", "not-started");
      closed = true;
      cleanupVerified = true;
      finish();
      return;
    }
    child.on("spawn", () => {
      try {
        capture();
      } catch {
        fail("Direct worker ownership unavailable", "INTERNAL");
      }
    });
    child.on("message", (raw) => {
      if (settled || failure) return;
      try {
        const value = z
          .object({ type: z.literal("ready"), nonce: z.literal(nonce), pid: z.number().int().positive() })
          .strict()
          .parse(raw);
        if (started || value.pid !== child?.pid) throw Error("Forged/repeated worker registration");
        capture();
        if (!registered) throw Error("Worker ownership absent");
        started = true;
        child.send!({ type: "start", nonce, parentPid: process.pid, job }, (error) => {
          if (error) fail("Worker start acknowledgement failed", "INTERNAL");
        });
      } catch {
        fail("Worker registration refused", "INTERNAL");
      }
    });
    child.stdout?.on("data", (b: Buffer) => {
      stdoutBytes += b.length;
      if (stdoutBytes > LIMIT) fail("Worker stdout exceeds bound");
      else stdout += decoder.write(b);
    });
    child.stdout?.on("error", () => fail("Worker stdout pipe failed", "INTERNAL"));
    child.stderr?.on("error", () => fail("Worker stderr pipe failed", "INTERNAL"));
    child.stderr?.on("data", (b: Buffer) => {
      stderrBytes += b.length;
      if (stderrBytes > LIMIT) fail("Worker stderr exceeds bound");
    });
    child.on("error", () => fail("Fixed worker launch failed", "INTERNAL"));
    child.on("close", (code, signal) => {
      closed = true;
      if (code !== 0 || signal) {
        let message = "Native handoff worker failed; inspect exact marker before another action";
        try {
          const failed = z
            .object({
              ok: z.literal(false),
              state: z.literal("draft-needs-review"),
              productionReady: z.literal(false),
              status: z.literal("pending-manual"),
              publication: z.literal("unknown"),
              error: z.literal("VALIDATION"),
              message: z.string().min(1).max(500),
            })
            .strict()
            .parse(JSON.parse(stdout + decoder.end()));
          message = failed.message;
        } catch {}
        failure ??= new HandoffWorkerError(message, started ? "unknown" : "not-started");
      }
      cleanup();
    });
  });
}
function regular(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw Error("Fixed installed runtime must be regular");
  return file;
}
export function runPlatformAudioHandoff(input: unknown) {
  const job = HandoffJobSchema.parse(input);
  if (process.platform !== "darwin")
    throw new HandoffWorkerError("OS deny-network native handoff unavailable", "not-started");
  let executable: string, tsx: string, worker: string;
  try {
    regular("/usr/bin/sandbox-exec");
    executable = regular(realpathSync(process.execPath));
    const require = createRequire(import.meta.url);
    tsx = regular(realpathSync(require.resolve("tsx")));
    worker = regular(fileURLToPath(new URL("./platform-audio-handoff-worker.ts", import.meta.url)));
  } catch {
    throw new HandoffWorkerError("Installed fixed sandbox/runtime unavailable", "not-started");
  }
  const root = process.cwd(),
    codeRoot = fileURLToPath(new URL("../../../", import.meta.url));
  if (path.resolve(root) !== path.resolve(codeRoot))
    throw new HandoffWorkerError("Native handoff requires the fixed workspace root", "not-started");
  const controller = new AbortController(),
    cancel = () => controller.abort();
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  return superviseHandoffProcess(
    (nonce) =>
      spawn(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          '(version 1)(allow default)(deny network*)(deny file-read* (regex #"/[.]env([.][^/]*)?$"))',
          executable,
          "--import",
          tsx,
          worker,
          nonce,
        ],
        {
          cwd: root,
          shell: false,
          detached: true,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: "/var/empty", TMPDIR: "/private/tmp", LC_ALL: "C" },
        },
      ),
    job,
    {
      inventory: handoffProcessInventory,
      signal: (pid, signal) => process.kill(pid, signal),
      workMs: 45000,
      cleanupMs: 5000,
      abort: controller.signal,
    },
  ).finally(() => {
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  });
}
