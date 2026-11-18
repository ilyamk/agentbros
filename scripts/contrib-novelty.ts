import { CliErrorObject, parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { checkNovelty } from "../src/lib/contrib/novelty";

void runOffline(async () => {
  const args = parseArgs([
    { name: "base", required: true, description: "Base commit for block and playbook novelty comparisons" },
  ] as const);
  const report = checkNovelty({ root: process.cwd(), base: args.base! });
  if (report.blocking.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Novelty overlap requires a change-entry novelty justification naming the existing ids and what is new.",
      details: { report },
    });
  return { metadata: { report } };
});
