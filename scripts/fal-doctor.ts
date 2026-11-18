/**
 * Which fal endpoints the harness or a project references are removed, deprecated or retiring,
 * judged against the catalogue index (refresh it with fal:sync). Read-only; no network.
 *
 * Usage:
 *   pnpm fal:doctor                       # legacy aliases, model tables, video/lip-sync scripts, music allow-list
 *   pnpm fal:doctor --project my-film     # plus the project's operations.json jobs and asset-plan requests
 */
import { parseArgs, runScript, CliErrorObject, assertPathWithin } from "../src/lib/cli";
import { runFalDoctor } from "../src/lib/models/fal-doctor";
import { assetsPlanPath, pipelineDir, projectDir } from "../src/lib/pipeline/paths";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

runScript(async () => {
  const args = parseArgs([
    { name: "project", description: "Also scan this project's operations.json and asset-plan.json" },
    { name: "only-project", type: "boolean", description: "Skip the harness's own references" },
    { name: "catalog", description: "Index directory (default src/lib/models/fal-catalog)" },
    { name: "scope-root", description: "Trusted MCP workspace boundary for project files" },
  ] as const);
  if (args["only-project"] && !args.project)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--only-project needs --project." });
  let project: { operations: string; assetPlan: string; label: string } | undefined;
  if (args.project) {
    let dir: string;
    try {
      dir = projectDir(args.project);
    } catch (error) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!existsSync(dir))
      throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project ${args.project} not found.` });
    project = {
      operations: path.join(pipelineDir(args.project), "operations.json"),
      assetPlan: assetsPlanPath(args.project),
      label: args.project,
    };
    if (args["scope-root"]) {
      for (const file of [project.operations, project.assetPlan]) {
        if (existsSync(file)) assertPathWithin(realpathSync(args["scope-root"]), realpathSync(file));
      }
    }
  }
  const report = runFalDoctor({ catalogDir: args.catalog, includeStatic: !args["only-project"], project });
  return {
    metadata: {
      ...report,
      ...(report.catalogEntries === 0
        ? { hint: "The catalogue index is empty: run pnpm fal:sync --catalog first." }
        : {}),
    },
  };
});
