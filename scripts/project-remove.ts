/**
 * Remove one project and everything it owns. Shows the plan unless --yes is passed.
 *
 * Usage: pnpm project:remove <project-id> [--yes] [--allow-tracked]
 */

import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";
import { applyCleanup, cleanupResult, formatBytes, planProjectRemoval } from "../src/lib/workspace/cleanup";

runScript(async () => {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  if (argv[0] && !argv[0].startsWith("-")) argv.splice(0, 1, "--project", argv[0]);
  const args = parseArgs(
    [
      { name: "project", required: true, description: "Project id" },
      { name: "yes", type: "boolean", description: "Delete the files; without it only the plan is shown" },
      { name: "allow-tracked", type: "boolean", description: "Also remove committed files, which Git can restore" },
    ] as const,
    argv,
  );
  let plan;
  try {
    plan = planProjectRemoval(args.project!, { allowTracked: args["allow-tracked"] });
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "INVALID_INPUT", message: (error as Error).message });
  }
  for (const target of plan.targets)
    emitProgress(
      `${formatBytes(target.bytes).padStart(10)}  ${target.path}${target.blockedBy.length ? "  [blocked]" : ""}`,
    );
  if (args.yes) applyCleanup(plan);
  return cleanupResult(plan, !args.yes);
});
