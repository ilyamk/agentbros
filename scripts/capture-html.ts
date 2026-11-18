import { readFileSync } from "node:fs";
import path from "node:path";
import { captureHtml } from "../src/lib/backends/html";
import { parseArgs, runScript, CliErrorObject, assertPathWithin, requireProject } from "../src/lib/cli";
runScript(async () => {
  const args = parseArgs([
    { name: "request", description: "Offline capture request JSON" },
    { name: "output", description: "Immutable capture directory" },
    { name: "project", description: "Optional project-scoped publication owner" },
    { name: "scope-root", description: "Trusted local launcher filesystem boundary" },
  ] as const);
  if (!args.request || !args.output)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Use --request JSON --output DIRECTORY",
    });
  try {
    const input = JSON.parse(readFileSync(args.request, "utf8"));
    if (args["scope-root"]) {
      for (const value of [input.htmlFile, input.assetRoot, args.output])
        assertPathWithin(path.resolve(args["scope-root"]), path.resolve(String(value)));
    }
    if (args.project) {
      requireProject(args.project);
      assertPathWithin(path.resolve("public/projects", args.project), path.resolve(args.output));
    }
    const result = await captureHtml(input, args.output);
    return { outputs: result.outputs, metadata: result };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({
      code: String(error).includes("timeout") ? "TIMEOUT" : "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
