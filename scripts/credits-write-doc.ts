import { parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { writeCredits } from "../src/lib/release/credits";

void runOffline(async () => {
  const args = parseArgs([
    { name: "check", type: "boolean", description: "Fail if CREDITS.md differs from credits/*.json; never writes" },
  ] as const);
  const count = writeCredits(process.cwd(), args.check);
  return { outputs: args.check ? [] : ["CREDITS.md"], metadata: { sources: count, checked: args.check } };
});
