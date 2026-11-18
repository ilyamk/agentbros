import { parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { planRelease } from "../src/lib/release";

void runOffline(async () => {
  const args = parseArgs([
    { name: "since", description: "Release tag to compare (default: last reachable release tag)" },
    { name: "now", description: "Inject an ISO date for readiness calculations" },
  ] as const);
  return {
    metadata: await planRelease(process.cwd(), { since: args.since, now: args.now ? new Date(args.now) : undefined }),
  };
});
