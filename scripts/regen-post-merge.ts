import { parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { regeneratePostMerge } from "../src/lib/release/post-merge";

void runOffline(async () => {
  const args = parseArgs([
    { name: "base", required: true, description: "Base commit before the merge" },
    { name: "head", required: true, description: "Head commit after the merge" },
    { name: "pr", type: "number", description: "Merged PR number to fill in newly added change entries" },
    { name: "date", description: "Inject a YYYY-MM-DD date (default: today in UTC)" },
  ] as const);
  return regeneratePostMerge(process.cwd(), { base: args.base!, head: args.head!, pr: args.pr, date: args.date });
});
