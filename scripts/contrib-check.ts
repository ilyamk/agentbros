import { CliErrorObject, parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { checkContribution } from "../src/lib/contrib/check";

void runOffline(async () => {
  const args = parseArgs([
    { name: "base", description: "Diff base; tries upstream/main, origin/main, remote HEAD refs, then main" },
    { name: "category", description: "Run this category's gates; must agree with the change entry" },
    {
      name: "timeout-min",
      type: "number",
      description: "Per-gate timeout in minutes; defaults to 30 for test suites, 5 otherwise",
    },
    { name: "body", description: "PR body file for full intake; otherwise structural intake only" },
    { name: "context", description: "Trusted intake context JSON (CLA, labels, tier, open PRs)" },
    { name: "skip", description: "Comma-separated gate names to skip" },
    { name: "only", description: "Comma-separated gate names to run" },
  ] as const);
  const evidence = await checkContribution({
    root: process.cwd(),
    base: args.base,
    category: args.category,
    timeoutMin: args["timeout-min"],
    body: args.body,
    context: args.context,
    skip: args.skip?.split(","),
    only: args.only?.split(","),
  });
  if (evidence.gates.some((gate) => gate.exitCode !== 0))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Contribution gates failed",
      details: { evidence, outputs: [".contrib/evidence.json"] },
    });
  return { outputs: [".contrib/evidence.json"], metadata: { evidence } };
});
