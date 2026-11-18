import { parseArgs, runScript } from "../src/lib/cli";
import { runBench } from "../src/lib/bench/run";
void runScript(async () => {
  const args = parseArgs([
    { name: "task", required: true, description: "Task ID in the pinned suite" },
    { name: "harness", required: true, choices: ["claude-code", "codex"], description: "Supported agent harness" },
    { name: "model", required: true, description: "Pinned harness model ID" },
    { name: "runs", type: "number", default: 3, description: "Replicates per cell (minimum three)" },
    { name: "commit", description: "Git commit to evaluate (default HEAD)" },
    { name: "suite", description: "Suite manifest, including a local hidden split" },
    {
      name: "max-cost-usd",
      type: "number",
      description: "Explicit external media budget per run; required for paid tasks",
    },
    { name: "dry-run", type: "boolean", description: "Validate and print the plan without worktrees or harness calls" },
  ] as const);
  return runBench({
    root: process.cwd(),
    task: args.task!,
    harness: args.harness as "claude-code" | "codex",
    model: args.model!,
    runs: args.runs,
    commit: args.commit,
    suite: args.suite,
    maxCostUsd: args["max-cost-usd"],
    dryRun: args["dry-run"],
  });
});
