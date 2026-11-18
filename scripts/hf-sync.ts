/** Anonymous public catalogue/docs maintenance; --from-fixtures is entirely offline. */
import path from "node:path";
import { syncHiggsfieldRestylePresets } from "../src/lib/models/hf-restyle-presets";
import { emitProgress, parseArgs, runScript } from "../src/lib/cli";
import { runHiggsfieldSync } from "../src/lib/models/hf-sync";

runScript(async () => {
  const args = parseArgs([
    {
      name: "presets",
      type: "boolean",
      description: "Refresh restyle presets only; skips without HIGGSFIELD_API_KEY, or reads --from-fixtures",
    },
    { name: "from-fixtures", description: "Offline: directory containing recorded docs/ and catalog-models.json" },
    { name: "dry-run", type: "boolean", description: "Compute catalogue and drift without writing files" },
    {
      name: "resume",
      type: "boolean",
      description: "Reuse successful GET checkpoints from today's .cache/hf-sync directory",
    },
  ] as const);
  if (args.presets) {
    const result = await syncHiggsfieldRestylePresets({
      credentials: process.env.HIGGSFIELD_API_KEY,
      fixtureFile: args["from-fixtures"] ? path.join(args["from-fixtures"], "restyle-presets.json") : undefined,
      dryRun: args["dry-run"],
    });
    return { outputs: result.written, metadata: result };
  }
  const result = await runHiggsfieldSync({
    fromFixtures: args["from-fixtures"],
    dryRun: args["dry-run"],
    resume: args.resume,
    log: emitProgress,
  });
  return { outputs: result.written, metadata: result as unknown as Record<string, unknown> };
});
