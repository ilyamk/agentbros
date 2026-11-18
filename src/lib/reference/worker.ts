import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/reference-analysis.py");
const TIMEOUT_MS = 1800000;

export const INSTALL_UV = "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh";

export type Unavailable = { available: false; unavailableReason: string; fix?: string };
export type WorkerResult<T> = { ok: true; value: T } | { ok: false; reason: string; fix: string };

const uvx = () => pythonUv(process.env.REFERENCE_UVX);

export function failureFix(detail: string): string {
  return /ENOENT|not found/i.test(detail)
    ? INSTALL_UV
    : "Check network access for the first uv package download, then rerun ref:analyze for this layer.";
}

/** Runs one worker operation through locked uv profiles. Packages are locked centrally and downloaded once by uv. */
export function runWorker<T>(
  operation: "shots" | "motion" | "audio",
  media: string,
  request?: unknown,
): WorkerResult<T> {
  const profile = operation === "audio" ? "reference-audio" : "reference";
  const work = request === undefined ? undefined : mkdtempSync(path.join(tmpdir(), "reference-worker-"));
  const args = pythonArgs(profile, [WORKER, operation, media]);
  if (work) {
    const file = path.join(work, "request.json");
    writeFileSync(file, JSON.stringify(request));
    args.push(file);
  }
  try {
    const result = spawnSync(uvx(), args, {
      env: pythonEnvironment(profile),
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? result.stderr.trim().slice(-600);
      return { ok: false, reason: `reference-analysis ${operation} failed: ${detail}`, fix: failureFix(detail) };
    }
    try {
      return { ok: true, value: JSON.parse(result.stdout) as T };
    } catch (error) {
      return {
        ok: false,
        reason: `reference-analysis ${operation} printed unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
        fix: "Rerun ref:analyze for this layer; report the reference if it repeats.",
      };
    }
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}
