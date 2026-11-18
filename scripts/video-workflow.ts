import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import {
  WORKFLOWS,
  WorkflowKindSchema,
  readWorkflowRequest,
  runWorkflow,
  workflowGuide,
} from "../src/lib/workflows/dispatch";
import { compactRecordingEditMetadata } from "../src/lib/workflows/recording-edit";

void runScript(async () => {
  const args = parseArgs([
    { name: "scenario", choices: WorkflowKindSchema.options, description: "Concrete local video workflow" },
    {
      name: "action",
      choices: ["list", "plan", "create"],
      default: "plan",
      description: "Plan is read-only; create imports supplied originals into new projects",
    },
    { name: "request", description: "Strict scenario JSON; local files, supplied scripts and explicit reviews" },
    {
      name: "dry-run",
      type: "boolean",
      description: "Force plan, even with action=create; never writes project artifacts",
    },
    { name: "scope-root", description: "Trusted launcher boundary for every nested source path" },
  ]);
  try {
    if (args.action === "list") return { outputs: [], metadata: { workflows: WORKFLOWS, apiCalls: 0, apiSpendUsd: 0 } };
    if (!args.scenario || !args.request) throw new Error("Workflow plan/create requires --scenario and --request");
    const kind = WorkflowKindSchema.parse(args.scenario);
    const scopeRoot = args["scope-root"] ? String(args["scope-root"]) : undefined;
    const action = args["dry-run"] === true ? "plan" : args.action === "create" ? "create" : "plan";
    const result = await runWorkflow(kind, readWorkflowRequest(String(args.request), scopeRoot), { action, scopeRoot });
    const metadata = kind === "recording-edit" ? compactRecordingEditMetadata(result.metadata) : result.metadata;
    return {
      outputs: result.outputs,
      metadata: {
        ...metadata,
        scenario: kind,
        action,
        dryRun: action === "plan",
        guide: workflowGuide(kind),
        apiCalls: 0,
        apiSpendUsd: 0,
      },
    };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
  }
});
