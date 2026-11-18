import { runScript, parseArgs, CliErrorObject } from "../src/lib/cli";
import {
  getHarnessOperation,
  importResult,
  listCapabilities,
  readHarnessJson,
  requestAsset,
} from "../src/lib/assets/harness-runtime";

void runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      choices: ["capabilities", "request", "import", "status"],
      default: "capabilities",
      description: "Offline portable harness handoff",
    },
    { name: "project", description: "Existing project ID (required for import/status)" },
    { name: "request-id", description: "Persisted request identity for status" },
    { name: "capabilities", description: "Observed/supplied runtime declaration JSON within workspace" },
    { name: "request", description: "Versioned request JSON within workspace" },
    { name: "result", description: "Fulfilled original/result JSON within workspace" },
    { name: "scope-root", description: "Trusted workspace scope" },
    { name: "dry-run", type: "boolean", description: "Validate/plan without writes or generation" },
  ] as const);
  const rootDir = args["scope-root"] ?? process.cwd();
  const read = (name: "capabilities" | "request" | "result") => {
    if (!args[name]) throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${name} is required.` });
    return readHarnessJson(rootDir, args[name]!);
  };
  if (args.action === "capabilities")
    return { metadata: listCapabilities(args.capabilities ? read("capabilities") : undefined, rootDir) };
  if (args.action === "request") {
    const input = read("request");
    if (
      args.project &&
      (!input || typeof input !== "object" || !("projectId" in input) || input.projectId !== args.project)
    )
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Request projectId does not match launcher project scope.",
      });
    const result = requestAsset(input, read("capabilities"), { rootDir, dryRun: args["dry-run"] });
    return { outputs: result.dryRun ? [] : [result.file], metadata: result };
  }
  if (!args.project) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--project is required." });
  if (args.action === "status") {
    if (!args["request-id"]) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--request-id is required." });
    return { metadata: { operation: getHarnessOperation(args.project, args["request-id"], rootDir) } };
  }
  const result = importResult(args.project, read("result"), { rootDir, dryRun: args["dry-run"] });
  return {
    outputs: result.dryRun
      ? []
      : [result.file, ...(result.operation.receipt ? [`public/${result.operation.receipt.original}`] : [])],
    metadata: result,
  };
});
