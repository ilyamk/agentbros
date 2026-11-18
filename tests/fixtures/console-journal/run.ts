/**
 * A runScript command for tests/console-journal.test.ts: `--mode` picks how it ends (success, CliErrorObject, an
 * unknown error, a BudgetError-shaped error, progress lines, or spawning itself as a child to test run-id nesting).
 */
import { spawnSync } from "node:child_process";
import { CliErrorObject, emitProgress, parseArgs, runScript } from "../../../src/lib/cli";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", description: "Project id" },
    { name: "mode", required: true, choices: ["ok", "cli-error", "error", "budget", "progress", "spawn", "bigint", "slow"], description: "How it ends" },
    { name: "api-key", description: "A secret-like flag" },
    { name: "answer", description: "The user's words" },
  ] as const);
  switch (args.mode) {
    case "cli-error":
      throw new CliErrorObject({ code: "VALIDATION", message: "fixture refusal" });
    case "error":
      throw new Error("fixture crash");
    case "budget": {
      const error = Object.assign(new Error("over the ceiling"), {
        name: "BudgetError",
        code: "BUDGET_EXCEEDED",
        details: { maxAdmissibleUsd: 0 },
      });
      throw error;
    }
    case "progress":
      for (let i = 0; i < 5; i++) emitProgress(`step ${i}`);
      break;
    case "bigint":
      return { outputs: [], metadata: { count: BigInt(1) } }; // JSON.stringify throws
    case "slow":
      await new Promise((resolve) => setTimeout(resolve, 1500)); // the test closes stdout meanwhile
      break;
    case "spawn": {
      const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, "--project", args.project!, "--mode", "ok"], {
        encoding: "utf8",
      });
      if (child.status !== 0) throw new Error(child.stderr);
      break;
    }
  }
  return {
    outputs: args.project ? [`public/projects/${args.project}/pipeline/out.json`, "out/elsewhere.mp4"] : [],
    metadata: { billing: { actualUsd: 0.25 } },
  };
});
