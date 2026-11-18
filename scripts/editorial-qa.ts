import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, runScript, requireProject, ensureFfmpeg, ensureFfprobe, CliErrorObject } from "../src/lib/cli";
import { inspectEditorialProject } from "../src/lib/editorial/qa";
runScript(async () => {
  const args = parseArgs([
    {
      name: "timeline",
      type: "boolean",
      description: "Inspect the explicitly edited timeline journal",
    },
    { name: "project", required: true, description: "Project ID" },
    { name: "render", description: "Optional rendered video" },
    {
      name: "format",
      choices: ["vertical", "square", "landscape"],
      description: "Output format",
      default: "landscape",
    },
    { name: "report", description: "QA JSON output" },
  ]);
  const id = String(args.project);
  requireProject(id);
  ensureFfmpeg();
  ensureFfprobe();
  const report = inspectEditorialProject(id, {
    renderFile: args.render ? String(args.render) : undefined,
    editedTimeline: args.timeline === true,
    format: args.format as "vertical" | "square" | "landscape",
  });
  const file = String(args.report ?? path.join("public/projects", id, "pipeline/editorial-qa.json"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  if (report.status === "failed")
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Editorial QA failed: ${report.findings.filter((f) => f.severity === "error").length} blocking findings`,
      details: {
        report: file,
        findings: report.findings,
        suggestions: report.suggestions,
      },
    });
  return { outputs: [file], metadata: report };
});
