import { parseArgs, runScript, requireProject, CliErrorObject } from "../src/lib/cli";
import { assertProjectId } from "../src/lib/render-plan";
import { inspectChartQuantitySources } from "../src/lib/chart-quantity-sources";
/** Read-only declaration/source correspondence, never a factual or release approval. */
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Existing local project ID" },
    { name: "timeline", type: "boolean", description: "Inspect current active edited timeline chart payloads" },
  ]);
  const projectId = String(args.project);
  assertProjectId(projectId);
  requireProject(projectId);
  let report: ReturnType<typeof inspectChartQuantitySources>;
  try {
    report = inspectChartQuantitySources(process.cwd(), projectId, { timeline: args.timeline === true });
  } catch (error) {
    throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
  }
  const metadata = { ...report, apiCalls: 0, apiSpendUsd: 0 };
  if (report.status === "blocked")
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Chart declaration/source correspondence has blocking findings",
      details: metadata,
    });
  return { outputs: [], metadata };
});
