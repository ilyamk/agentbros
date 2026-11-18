import { parseArgs, runScript } from "../src/lib/cli";
import { contextProbe } from "../src/lib/context/probe";
import { ContextProbeHarnessSchema } from "../src/types/context-probe";

void runScript(async () => {
  const args = parseArgs([
    {
      name: "harness",
      required: true,
      choices: ContextProbeHarnessSchema.options,
      description: "Harness whose instruction loading to probe",
    },
    {
      name: "dry-run",
      type: "boolean",
      description: "Print canaries and invocations without creating a worktree, calling a harness or writing results",
    },
    { name: "seed", description: "Reproducible canary seed; defaults to a fresh random seed" },
  ] as const);
  return contextProbe(process.cwd(), ContextProbeHarnessSchema.parse(args.harness), {
    dryRun: args["dry-run"],
    seed: args.seed,
    binary: process.env.CONTEXT_PROBE_HARNESS_BIN,
  });
});
