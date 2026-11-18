import { parseArgs, runScript } from "../src/lib/cli";
import { readLedger } from "../src/lib/cli/cost-log";
import { fetchHiggsfieldUsage, reconcileHiggsfieldUsage } from "../src/lib/models/hf-pricing";

runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project whose cost ledger is compared with account analytics" },
    { name: "start", description: "Start date or timestamp" },
    { name: "end", description: "End date or timestamp" },
  ] as const);
  const options = { start: args.start, end: args.end };
  const ledger = readLedger(args.project!);
  const usage = await fetchHiggsfieldUsage((url, init) => fetch(url, init), options);
  return { outputs: [], metadata: reconcileHiggsfieldUsage(usage, ledger, options) };
});
