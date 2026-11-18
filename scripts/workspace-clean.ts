/**
 * Clear generated workspace data by scope. Shows the plan unless --yes is passed.
 *
 * Usage: pnpm workspace:clean --scope projects,renders,bundles,qa,cache,memory [--keep a,b] [--yes]
 * `all` is every scope except `memory`: the user's memory is cleared only when named, and memory/AGENTS.md never.
 */

import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";
import {
  ALL_SCOPES,
  CLEANUP_SCOPES,
  applyCleanup,
  cleanupResult,
  formatBytes,
  planWorkspaceClean,
  type CleanupScope,
} from "../src/lib/workspace/cleanup";

const list = (value?: string): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

runScript(async () => {
  const args = parseArgs([
    {
      name: "scope",
      required: true,
      description: `Comma-separated: ${CLEANUP_SCOPES.join(", ")} or all (every scope except memory)`,
    },
    { name: "keep", description: "Comma-separated project ids to protect" },
    { name: "yes", type: "boolean", description: "Delete the files; without it only the plan is shown" },
    { name: "allow-tracked", type: "boolean", description: "Also remove committed files, which Git can restore" },
    { name: "include-runtime", type: "boolean", description: "Also remove the local inference runtime under out/qa" },
  ] as const);
  const requested = list(args.scope);
  const scopes = (
    requested.includes("all")
      ? [...new Set([...ALL_SCOPES, ...requested.filter((scope) => scope !== "all")])]
      : requested
  ) as CleanupScope[];
  const invalid = scopes.filter((scope) => !CLEANUP_SCOPES.includes(scope));
  if (scopes.length === 0 || invalid.length > 0) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Invalid --scope. Expected: ${CLEANUP_SCOPES.join(", ")} or all.`,
    });
  }
  const plan = planWorkspaceClean({
    scopes,
    keep: list(args.keep),
    allowTracked: args["allow-tracked"],
    includeRuntime: args["include-runtime"],
  });
  for (const target of plan.targets)
    emitProgress(
      `${formatBytes(target.bytes).padStart(10)}  ${target.path}${target.blockedBy.length ? "  [blocked]" : ""}`,
    );
  for (const skipped of plan.skipped ?? []) emitProgress(`   skipped  ${skipped.path}: ${skipped.reason}`);
  if (args.yes) applyCleanup(plan);
  return cleanupResult(plan, !args.yes);
});
