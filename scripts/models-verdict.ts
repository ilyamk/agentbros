import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { writeModelVerdict } from "../src/lib/models/model-slots-project";

runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project id" },
    { name: "operation-id", required: true, description: "Existing operation id" },
    { name: "accepted", type: "boolean", description: "Record acceptance" },
    { name: "rejected", type: "boolean", description: "Record rejection" },
    { name: "reason", description: "Optional reason" },
  ] as const);
  if (Boolean(args.accepted) === Boolean(args.rejected))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose --accepted or --rejected" });
  const verdict = writeModelVerdict(args.project!, {
    operationId: args["operation-id"]!,
    verdict: args.accepted ? "accepted" : "rejected",
    reason: args.reason,
  });
  return { outputs: [`public/projects/${args.project}/pipeline/model-verdicts.jsonl`], metadata: { verdict } };
});
