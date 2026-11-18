import { CliErrorObject, parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { regenerate } from "../src/lib/contrib/regen";

void runOffline(async () => {
  parseArgs([]);
  const result = regenerate(process.cwd());
  if (result.gates.some((gate) => gate.exitCode))
    throw new CliErrorObject({ code: "VALIDATION", message: "Regeneration failed", details: result });
  return { outputs: result.changed, metadata: result };
});
