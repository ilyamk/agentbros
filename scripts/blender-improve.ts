import { readFileSync, writeFileSync } from "node:fs";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import {
  appendImprovement,
  buildImprovementPackets,
  improvementGaps,
  improvementHistory,
  runImprovementHarness,
  scoreImprovement,
} from "../src/lib/blender-arsenal/improvements";

void runScript(async () => {
  const tokens = process.argv.slice(2);
  if (tokens[0] === "--") tokens.shift();
  const action = tokens[0]?.startsWith("-") ? "gaps" : (tokens.shift() ?? "gaps");
  const args = parseArgs(
    [
      { name: "baseline", description: "Baseline PNG, MP4 or numbered PNG directory" },
      { name: "candidate", description: "Candidate media with matching frame coverage" },
      { name: "out", description: "New packet directory or JSON result file" },
      { name: "reference", description: "Professional reference description, frozen before A/B" },
      { name: "key", description: "Private packet key.json; never give to critics" },
      { name: "results", description: "Comma-separated fresh critic JSON files, both orders" },
      { name: "checks", description: "JSON sensors/tests pass and evidence paths" },
      { name: "input", description: "Log entry, critic packet or advisor context JSON" },
      { name: "target", description: "Exact recipe id or kit function for history" },
      { name: "capability", description: "Gap capability tag" },
      { name: "timeout", type: "number", default: 360, description: "Fresh harness timeout, seconds (1–3600)" },
    ] as const,
    tokens,
  );
  const required = (...names: Array<keyof typeof args>) => {
    for (const name of names) if (!args[name]) throw new Error(`Missing --${name}`);
  };
  const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
  const save = (value: unknown) => {
    required("out");
    writeFileSync(args.out!, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    return { outputs: [args.out!], metadata: value as Record<string, unknown> };
  };
  try {
    switch (action) {
      case "packet":
        required("baseline", "candidate", "out", "reference");
        return {
          metadata: buildImprovementPackets({
            baseline: args.baseline!,
            candidate: args.candidate!,
            output: args.out!,
            reference: args.reference!,
          }),
        };
      case "score":
        required("key", "results", "checks");
        return save(scoreImprovement(args.key!, args.results!.split(","), read(args.checks!)));
      case "log":
        required("input");
        return { outputs: [appendImprovement(read(args.input!))] };
      case "gaps":
        return {
          metadata: { gaps: improvementGaps().filter((g) => !args.capability || g.capability === args.capability) },
        };
      case "history":
        required("target");
        return { metadata: { history: improvementHistory(process.cwd(), args.target!) } };
      case "judge":
      case "advise": {
        required("input", "out");
        if (!Number.isFinite(args.timeout) || args.timeout! < 1 || args.timeout! > 3600)
          throw new Error("--timeout must be within 1–3600");
        return save(
          runImprovementHarness({
            role: action === "judge" ? "critic" : "advisor",
            input: args.input!,
            timeoutSec: args.timeout,
          }),
        );
      }
      default:
        throw new Error("Use packet, score, log, gaps, history, judge or advise");
    }
  } catch (error) {
    throw new CliErrorObject({ code: "VALIDATION", message: String(error) });
  }
});
