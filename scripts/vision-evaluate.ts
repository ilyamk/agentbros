import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { prepareVisionEvaluation } from "../src/lib/vision/eval-fixtures";
import { evaluateVision } from "../src/lib/vision/evaluation";
void runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      choices: ["prepare", "run"],
      required: true,
      description: "Create frozen fixtures or run actual local harness evaluation",
    },
    { name: "output", required: true, description: "New local output directory" },
    { name: "cases", description: "Prepared cases.json; answer key stays outside agent packets" },
    {
      name: "harness",
      choices: ["codex", "claude", "both"],
      default: "both",
      description: "Existing authorised harness subscriptions, current configured models",
    },
    { name: "limit", type: "number", description: "Smoke subset only; cannot establish acceptance" },
  ] as const);
  if (args.action === "prepare") return { outputs: [prepareVisionEvaluation(args.output!)] };
  if (!args.cases) throw new CliErrorObject({ code: "INVALID_INPUT", message: "run requires --cases." });
  const report = await evaluateVision({
    casesFile: args.cases,
    output: args.output!,
    harnesses: args.harness === "both" ? ["codex", "claude"] : [args.harness as "codex" | "claude"],
    limit: args.limit,
  });
  if (!report.passed && !args.limit)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Vision agent acceptance failed.",
      details: { summary: report.summary, report: `${args.output}/report.json` },
    });
  return {
    outputs: [`${args.output}/report.json`],
    metadata: { passed: report.passed, smokeOnly: !!args.limit, summary: report.summary },
  };
});
