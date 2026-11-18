import { readFileSync, constants, openSync, closeSync, fstatSync } from "node:fs";
import path from "node:path";
import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { planBroll, applyBroll, BrollRequestSchema } from "../src/lib/ingest/broll";
import { assertPathWithin } from "../src/lib/cli";
import { assertProjectId } from "../src/lib/render-plan";
function json(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Bounded regular JSON file required");
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || bytes.length > 16 * 1024 * 1024) throw new Error("JSON changed while reading");
    return JSON.parse(bytes.toString());
  } finally {
    closeSync(fd);
  }
}
runScript(async () => {
  const args = parseArgs([
    {
      name: "project",
      required: true,
      description: "Selected project slug; must match request",
    },
    {
      name: "action",
      choices: ["plan", "apply"],
      default: "plan",
      description: "Read-only plan or explicit reviewed independent visual track",
    },
    {
      name: "request",
      description: "Project-scoped B-roll request JSON for planning",
    },
    {
      name: "plan",
      description: "Exact previously returned plan JSON for application",
    },
    {
      name: "review",
      description: "Supplied hash-bound review JSON; does not authenticate creative approval",
    },
    {
      name: "scope-root",
      description: "Trusted launcher workspace boundary",
    },
    {
      name: "dry-run",
      type: "boolean",
      default: false,
      description: "Validate reviewed application without writing",
    },
  ] as const);
  try {
    assertProjectId(args.project!);
    const project = path.resolve("public/projects", args.project!);
    const read = (file?: string) => {
      if (!file) throw new Error("Required JSON input missing");
      assertPathWithin(project, path.resolve(file));
      return json(file);
    };
    let result;
    if (args.action === "plan") {
      const request = BrollRequestSchema.parse(read(args.request));
      if (request.projectId !== args.project) throw new Error("Request belongs to another project");
      result = planBroll(request, {
        scopeRoot: args["scope-root"],
      });
    } else {
      const plan = read(args.plan);
      if (plan?.request?.projectId !== args.project) throw new Error("Plan belongs to another project");
      result = applyBroll(plan, read(args.review), {
        scopeRoot: args["scope-root"],
        dryRun: args["dry-run"],
      });
    }
    return {
      outputs: args.action === "apply" && !args["dry-run"] ? [path.join(project, "pipeline/timeline-edit.json")] : [],
      metadata: result,
    };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({
      code: "VALIDATION",
      message: error instanceof Error ? error.message : "B-roll validation failed",
    });
  }
});
