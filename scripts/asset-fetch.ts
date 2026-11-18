/**
 * Single-asset fetch dispatcher for the creative-studio pipeline.
 *
 * Reads pipeline/asset-plan.json, finds the asset by id, dispatches to the
 * correct backend, updates the plan status, and emits structured JSON.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/asset-fetch.ts \
 *     --project <id> --asset-id <id> [--retry 1] [--force]
 *
 * Output: JSON on stdout, progress on stderr.
 */

import { parseArgs, runScript, requireProject, CliErrorObject } from "../src/lib/cli/index.js";
import { dispatchAsset } from "../src/lib/asset-dispatcher.js";
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
    name: "asset-id",
    required: true as const,
    description: "Asset ID from asset-plan.json",
  },
  {
    name: "retry",
    type: "number" as const,
    default: 1,
    description: "Extra attempts on failure (total = 1 + retry)",
  },
  {
    name: "force",
    type: "boolean" as const,
    default: false,
    description: "Re-fetch even if the asset is already marked done",
  },
] as const;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  const args = parseArgs(SPECS);

  const projectId = args["project"] as string;
  const assetId = args["asset-id"] as string;
  const force = args["force"] as boolean;
  const maxRetry = typeof args["retry"] === "number" ? args["retry"] : 1;

  requireProject(projectId);

  let lastResult = await dispatchAsset({ projectId, assetId, force, retry: maxRetry });

  // Retry loop for transient failures — does not re-try manual-drop or inline assets
  // (those return ok:true and are not retried anyway).
  let attempt = 0;
  while (!lastResult.ok && attempt < maxRetry) {
    attempt++;
    lastResult = await dispatchAsset({ projectId, assetId, force: true, retry: 0 });
  }

  if (!lastResult.ok) {
    throw new CliErrorObject({
      code: (lastResult.errorCode as ErrorCode) ?? "INTERNAL",
      message: lastResult.error ?? "Asset dispatch failed.",
      details: lastResult.metadata,
    });
  }

  return {
    outputs: lastResult.outputs,
    metadata: lastResult.metadata,
  };
});
