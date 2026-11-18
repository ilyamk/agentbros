import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { ProviderIdSchema } from "../src/types/fal-catalog";
import { scaffoldFalEndpoint, writeFalScaffold } from "../src/lib/models/fal-scaffold";

runScript(async () => {
  // parseArgs is scalar: collect repeated assignments without splitting JSON commas.
  const argv = process.argv.slice(2),
    rest: string[] = [],
    assignments: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--set") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--"))
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "--set requires key=value" });
      assignments.push(value);
    } else if (arg.startsWith("--set=")) assignments.push(arg.slice(6));
    else rest.push(arg);
  }
  const args = parseArgs(
    [
      { name: "endpoint", required: true, description: "Exact provider endpoint" },
      { name: "provider", choices: ["fal", "higgsfield"], description: "Provider (default fal)" },
      { name: "set", description: "Repeat key=value assignments; dotted object keys supported" },
      { name: "set-json", description: "JSON array of assignments (MCP transport)" },
      { name: "out", description: "Optional request file; workspace or temporary path" },
      { name: "force", type: "boolean", description: "Explicitly overwrite an existing request" },
      { name: "project", description: "Optional MCP project scope" },
    ] as const,
    rest,
  );
  if (args["set-json"]) {
    const values: unknown = JSON.parse(args["set-json"]);
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string"))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--set-json must be a string array." });
    assignments.push(...values);
  }
  const scaffold = scaffoldFalEndpoint(args.endpoint!, {
    set: assignments,
    provider: args.provider ? ProviderIdSchema.parse(args.provider) : undefined,
  });
  const outputs =
    args.out && !scaffold.nextAction ? [writeFalScaffold(args.out, scaffold.request, { force: args.force })] : [];
  return { outputs, metadata: { ...scaffold } };
});
