import path from "node:path";
import { readFileSync } from "node:fs";
import { parseArgs, runScript, CliErrorObject, assertPathWithin, validateProjectId } from "../src/lib/cli";
import { LocalResolveAdapter } from "../src/lib/backends/resolve/adapter";
import { executeResolveHandoff } from "../src/lib/backends/handoff";
runScript(async () => {
  const args = parseArgs([
    {
      name: "directory",
      description: "Prepared immutable handoff directory",
      required: true,
    },
    { name: "action", default: "probe", description: "probe | execute" },
    { name: "project", description: "Optional expected project owner from handoff" },
    { name: "scope-root", description: "Trusted local launcher filesystem boundary" },
  ] as const);
  if (!args.directory)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--directory required",
    });
  if (args.project || args["scope-root"]) {
    const manifest = JSON.parse(readFileSync(path.join(args.directory, "handoff.json"), "utf8"));
    if (args.project) {
      validateProjectId(args.project);
      if (manifest.expected?.projectId !== args.project)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "Handoff project differs from scoped project." });
    }
    if (args["scope-root"])
      for (const value of [args.directory, ...manifest.originals.map((original: { path: string }) => original.path)])
        assertPathWithin(path.resolve(args["scope-root"]), path.resolve(value));
  }
  const adapter = new LocalResolveAdapter(args.directory);
  if (args.action === "probe") return { outputs: [], metadata: await adapter.probe() };
  if (args.action !== "execute")
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Use probe or execute",
    });
  const result = await executeResolveHandoff(args.directory, adapter);
  return {
    outputs: Array.isArray(result.outputs) ? (result.outputs as string[]) : [],
    metadata: result,
  };
});
