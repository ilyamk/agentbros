import { pythonArgs, pythonToolArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject } from "../cli";

const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/multicam.py");
const TIMEOUT_MS = 1_800_000;
const INSTALL_UV = "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh";

const uvx = () => pythonUv(process.env.MULTICAM_UVX);

function run(args: string[], label: string, profile: "multicam" | "offset" = "multicam"): string {
  const result = spawnSync(uvx(), args, {
    env: pythonEnvironment(profile),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim().slice(-800);
    throw new CliErrorObject({
      code: /ETIMEDOUT/.test(detail) ? "TIMEOUT" : "INTERNAL",
      message: `${label} failed: ${detail}`,
      details: {
        fix: /ENOENT|not found/i.test(detail)
          ? INSTALL_UV
          : "Check network access for the first uv package download, then rerun.",
      },
    });
  }
  return result.stdout;
}

/** BBC audio-offset-finder: where `target` starts inside `reference`, in seconds, plus its standard score. */
export function coarseOffset(reference: string, target: string): { offsetSec: number; standardScore: number } {
  const stdout = run(
    pythonToolArgs("offset", "audio-offset-finder", ["--find-offset-of", target, "--within", reference, "--json"]),
    "audio-offset-finder",
    "offset",
  );
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const parsed = JSON.parse(line) as { time_offset: number; standard_score: number };
  return { offsetSec: parsed.time_offset, standardScore: parsed.standard_score };
}

export function runMulticamWorker<T>(operation: "refine" | "energy" | "detect", request: unknown): T {
  const work = mkdtempSync(path.join(tmpdir(), "multicam-worker-"));
  const file = path.join(work, "request.json");
  writeFileSync(file, JSON.stringify(request));
  try {
    return JSON.parse(run(pythonArgs("multicam", [WORKER, operation, file]), `multicam ${operation}`)) as T;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
