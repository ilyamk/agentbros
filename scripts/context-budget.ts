import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { budgetDelta, budgetFor, budgetMarkdown } from "../src/lib/context/budget";
import { simulateRun, simulationMarkdown, type Rounds } from "../src/lib/context/simulate";

void runScript(async () => {
  const args = parseArgs([
    { name: "base", description: "Compare with a local git ref, without a worktree or network (not with --simulate)" },
    { name: "markdown", description: "Write a PR-comment Markdown table to this file" },
    {
      name: "write",
      type: "boolean",
      description: "Write JSON to out/context/budget.json (out/context/simulate.json with --simulate)",
    },
    {
      name: "simulate",
      type: "boolean",
      description: "Estimate a whole run: the orchestrator's conversation step by step and every subagent dispatch",
    },
    { name: "playbook", description: "With --simulate: one playbook id (default: every film and footage playbook)" },
    { name: "all", type: "boolean", description: "With --simulate: every film and footage playbook (the default)" },
    {
      name: "rounds",
      choices: ["expected", "worst"] as const,
      description: "With --simulate: expected (one round per loop, default) or worst (stop.maxRounds)",
    },
    {
      name: "report-bytes",
      type: "number",
      description: "With --simulate: bytes of each subagent's report (default 2048)",
    },
  ] as const);
  const writeFile = (file: string, text: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  if (args.simulate) {
    if (args.base !== undefined)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message:
          "--base is not supported with --simulate: answers and briefs are rendered by the current code, so a historical side would mix two trees.",
      });
    if (args.playbook !== undefined && args.all)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --playbook <id> or --all, not both." });
    const reportBytes = args["report-bytes"];
    if (reportBytes !== undefined && (!Number.isInteger(reportBytes) || reportBytes < 0))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--report-bytes must be a whole number of bytes, 0 or more.",
      });
    const simulation = simulateRun(process.cwd(), args.playbook === undefined ? undefined : [args.playbook], {
      rounds: (args.rounds ?? "expected") as Rounds,
      ...(reportBytes !== undefined ? { reportBytes } : {}),
    });
    const outputs: string[] = [];
    if (args.write) {
      writeFile("out/context/simulate.json", `${JSON.stringify(simulation, null, 2)}\n`);
      outputs.push("out/context/simulate.json");
    }
    if (args.markdown !== undefined) {
      writeFile(args.markdown, simulationMarkdown(simulation));
      outputs.push(args.markdown);
    }
    return { outputs, metadata: simulation };
  }
  for (const flag of ["playbook", "all", "rounds", "report-bytes"] as const)
    if (args[flag] !== undefined && args[flag] !== false)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${flag} needs --simulate.` });
  const budget = budgetFor(process.cwd());
  const delta = args.base === undefined ? undefined : budgetDelta(budget, budgetFor(process.cwd(), args.base));
  const report = { ...budget, ...(delta ? { base: args.base, delta } : {}) };
  const outputs: string[] = [];
  if (args.write) {
    const file = "out/context/budget.json";
    writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
    outputs.push(file);
  }
  if (args.markdown !== undefined) {
    writeFile(args.markdown, budgetMarkdown(budget, delta));
    outputs.push(args.markdown);
  }
  return { outputs, metadata: report };
});
