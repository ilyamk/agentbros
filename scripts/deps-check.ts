import { parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { checkDependencies } from "../src/lib/contrib/dependencies";

void runOffline(async () => {
  const args = parseArgs([
    {
      name: "base",
      required: true,
      description:
        "Trusted base ref for new lockfile packages; audit production dependencies and report install scripts",
    },
  ] as const);
  return { metadata: checkDependencies(process.cwd(), args.base!) };
});
