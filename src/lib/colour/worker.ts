import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { z } from "zod";
import { CliErrorObject } from "../cli";
import { pythonArgs, pythonEnvironment, pythonUv } from "../python";

/** The colour worker needs NumPy, SciPy and OpenCV headless: exactly the locked `vork` group, so it reuses that environment. */
export const COLOUR_PROFILE = "vork" as const;
const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/colour.py");
const TIMEOUT_MS = 1_800_000;

export type ColourOperation = "scopes" | "compare" | "match" | "shots" | "bake" | "selftest";

/** Run one worker operation and validate its answer. `COLOUR_UV` overrides the uv executable (tests). */
export function runColourWorker<T>(operation: ColourOperation, request: unknown, schema: z.ZodType<T>): T {
  const work = mkdtempSync(path.join(tmpdir(), "colour-worker-"));
  const file = path.join(work, "request.json");
  writeFileSync(file, JSON.stringify(request));
  try {
    const result = spawnSync(pythonUv(process.env.COLOUR_UV), pythonArgs(COLOUR_PROFILE, [WORKER, operation, file]), {
      env: pythonEnvironment(COLOUR_PROFILE),
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024 * 1024,
    });
    const last = result.stdout?.trim().split("\n").at(-1) ?? "";
    let parsed: unknown;
    try {
      parsed = last ? JSON.parse(last) : undefined;
    } catch {
      parsed = undefined;
    }
    const answer = parsed as { ok?: boolean; error?: string } | undefined;
    if (answer?.ok === false)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `colour ${operation}: ${answer.error ?? "failed"}` });
    if (result.error || result.status !== 0 || !answer) {
      const detail = result.error?.message ?? result.stderr.trim().slice(-800);
      throw new CliErrorObject({
        code: /ETIMEDOUT/.test(detail) ? "TIMEOUT" : "INTERNAL",
        message: `colour ${operation} failed: ${detail}`,
        details: {
          fix: /ENOENT|not found/i.test(detail)
            ? "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
            : "The first run downloads the locked NumPy/SciPy/OpenCV wheels; check network access, then rerun.",
        },
      });
    }
    const checked = schema.safeParse(answer);
    if (!checked.success)
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `colour ${operation}: unexpected worker answer: ${checked.error.message.slice(0, 400)}`,
      });
    return checked.data;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
