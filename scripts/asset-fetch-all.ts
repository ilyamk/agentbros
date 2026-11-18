/**
 * Batch asset fetcher for the creative-studio pipeline.
 *
 * Reads pipeline/asset-plan.json, filters assets by status, dispatches each
 * via the shared dispatcher, and emits a summary JSON.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/asset-fetch-all.ts \
 *     --project <id> [--parallel 1] [--continue-on-error] \
 *     [--include-status pending,failed]
 *
 * Output: JSON on stdout, progress on stderr.
 *
 * Parallel default is 1 (serial) to avoid hitting API rate limits. Increase
 * only for low-cost backends (Pexels, Lottie, Pixabay) or when you know your
 * API quotas can handle concurrent requests.
 */

import { existsSync, readFileSync } from "node:fs";

import { parseArgs, runScript, requireProject, emitProgress, CliErrorObject } from "../src/lib/cli/index.js";
import { dispatchAsset, isPendingDispatch } from "../src/lib/asset-dispatcher.js";
import { assetsPlanPath } from "../src/lib/pipeline/paths.js";
import { AssetPlanSchema } from "../src/types/pipeline.js";
import type { AssetSpec } from "../src/types/pipeline.js";
import type { ErrorCode } from "../src/lib/cli/types.js";

// ---------------------------------------------------------------------------
// Arg spec
// ---------------------------------------------------------------------------

const SPECS = [
  {
    name: "project",
    short: "p",
    required: true as const,
    description: "Project ID (must exist under public/projects/)",
  },
  {
    name: "parallel",
    type: "number" as const,
    default: 1,
    description: "Max concurrent dispatches. Default 1 (serial). Raise cautiously — external APIs rate-limit.",
  },
  {
    name: "continue-on-error",
    type: "boolean" as const,
    default: false,
    description: "Continue processing remaining assets even if one fails",
  },
  {
    name: "include-status",
    default: "pending,failed,running",
    description: "Comma-separated list of statuses to process (default: pending,failed,running)",
  },
] as const;

// ---------------------------------------------------------------------------
// Promise pool
// ---------------------------------------------------------------------------

async function promisePool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (true) {
      const taskIndex = index++;
      if (taskIndex >= tasks.length) break;
      results[taskIndex] = await tasks[taskIndex]!();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Per-asset result record
// ---------------------------------------------------------------------------

interface AssetSummary {
  id: string;
  kind: string;
  status: string;
  error?: string;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  const args = parseArgs(SPECS);

  const projectId = args["project"] as string;
  const concurrency = Math.max(1, typeof args["parallel"] === "number" ? args["parallel"] : 1);
  const continueOnError = args["continue-on-error"] as boolean;
  const includeStatusRaw = (args["include-status"] as string) ?? "pending,failed";
  const includeStatuses = new Set(includeStatusRaw.split(",").map((s) => s.trim()));

  requireProject(projectId);

  // ── Load asset plan ───────────────────────────────────────────────────────

  const planPath = assetsPlanPath(projectId);
  if (!existsSync(planPath)) {
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `asset-plan.json not found for project "${projectId}". Run the asset-plan stage first.`,
    });
  }

  const raw: unknown = JSON.parse(readFileSync(planPath, "utf-8"));
  const planResult = AssetPlanSchema.safeParse(raw);
  if (!planResult.success) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `asset-plan.json failed schema validation: ${planResult.error.message}`,
    });
  }

  const pending: AssetSpec[] = planResult.data.assets.filter((a) => includeStatuses.has(a.status));

  emitProgress(
    `Found ${pending.length} asset(s) to process` + ` (filter: ${includeStatusRaw}, concurrency: ${concurrency})`,
  );

  if (pending.length === 0) {
    return {
      outputs: [],
      metadata: {
        total: 0,
        done: 0,
        failed: 0,
        skipped: 0,
        manualRequired: 0,
        perAsset: [] as AssetSummary[],
      },
    };
  }

  // ── Dispatch all assets ───────────────────────────────────────────────────

  const allOutputs: string[] = [];
  const perAsset: AssetSummary[] = [];
  let failCount = 0;
  let manualRequiredCount = 0;
  let pendingCount = 0;

  // pendingError is set when continueOnError=false and a failure occurs.
  // We finish the promisePool but then throw at the end.
  let pendingError: CliErrorObject | undefined;

  const tasks = pending.map((asset) => async (): Promise<void> => {
    if (pendingError) return; // short-circuit remaining tasks on hard stop

    emitProgress(`Dispatching: ${asset.id} (${asset.kind}/${asset.source})`);

    const result = await dispatchAsset({
      projectId,
      assetId: asset.id,
      force: false,
    });

    let statusLabel: string;
    if (!result.ok) {
      statusLabel = "failed";
      failCount++;
      emitProgress(`FAILED: "${asset.id}" — ${result.error ?? "unknown error"}`);
    } else if (isPendingDispatch(result)) {
      statusLabel = "pending";
      pendingCount++;
    } else if (result.metadata["requiresManualDrop"]) {
      statusLabel = "manual-required";
      manualRequiredCount++;
    } else if (result.metadata["skippedReason"] ?? result.metadata["skipped"]) {
      statusLabel = "skipped";
    } else if (result.metadata["inline"]) {
      statusLabel = "inline";
    } else {
      statusLabel = "done";
      allOutputs.push(...result.outputs);
    }

    perAsset.push({
      id: asset.id,
      kind: asset.kind,
      status: statusLabel,
      error: result.error,
      elapsedMs: result.elapsedMs,
    });

    if (!result.ok && !continueOnError) {
      pendingError = new CliErrorObject({
        code: (result.errorCode as ErrorCode) ?? "INTERNAL",
        message: `Asset "${asset.id}" failed: ${result.error ?? "unknown"}`,
        details: { assetId: asset.id, kind: asset.kind, source: asset.source, perAsset },
      });
    }
  });

  await promisePool(tasks, concurrency);

  if (pendingError) {
    throw pendingError;
  }

  // ── Build summary ─────────────────────────────────────────────────────────

  const doneCount = perAsset.filter((a) => a.status === "done" || a.status === "inline").length;

  const summary = {
    total: pending.length,
    done: doneCount,
    failed: failCount,
    skipped: perAsset.filter((a) => a.status === "skipped").length,
    manualRequired: manualRequiredCount,
    pending: pendingCount,
    perAsset,
    // Expose hasFailures so orchestrator can inspect without throwing
    ...(failCount > 0 ? { hasFailures: true } : {}),
  };

  emitProgress(`Complete — done=${doneCount} failed=${failCount} manualRequired=${manualRequiredCount}`);

  return {
    outputs: allOutputs,
    metadata: summary,
  };
});
