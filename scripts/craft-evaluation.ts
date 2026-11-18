import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { readWorkflowRequest } from "../src/lib/workflows/dispatch";
import { evaluateCraft } from "../src/lib/evaluation/service";
import { CRAFT_RUBRICS, CRAFT_RUBRIC_VERSION } from "../src/lib/evaluation/rubrics";
void runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      choices: ["rubric", "evaluate"],
      default: "evaluate",
      description: "Read-only evaluation or rubric discovery",
    },
    { name: "request", description: "Versioned local evaluation manifest" },
    { name: "scope-root", description: "Trusted boundary for manifest and all nested artifact/media paths" },
  ]);
  try {
    if (args.action === "rubric")
      return {
        outputs: [],
        metadata: { version: CRAFT_RUBRIC_VERSION, rubrics: CRAFT_RUBRICS, apiCalls: 0, apiSpendUsd: 0 },
      };
    if (!args.request) throw new Error("Evaluation requires --request");
    const root = args["scope-root"] ? String(args["scope-root"]) : process.cwd();
    const report = await evaluateCraft(readWorkflowRequest(String(args.request), root), root);
    if (report.variants.at(-1)?.technical === "fail")
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Evaluation has technical defects",
        details: { report },
      });
    return { outputs: [], metadata: { report } };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
  }
});
