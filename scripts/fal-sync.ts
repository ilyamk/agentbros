/**
 * Sync the fal catalogue index, the hash-pinned schema cache and the drift report
 * (docs/fal-integration.md). Free read-only GETs on the Platform API; never a paid call.
 *
 * Usage:
 *   pnpm fal:sync --catalog [--verify-known] [--report]       # listing → src/lib/models/fal-catalog/
 *   pnpm fal:sync --schemas fal-ai/flux/schnell,meshy/v7/image-to-3d
 *   pnpm fal:sync --tier verified --pin-verified               # schemas of pinned endpoints; fill null pins
 *   pnpm fal:sync --catalog --all                              # every schema (slow; ≤4 at a time)
 *   pnpm fal:sync --from-fixtures tests/fixtures/fal-catalog --catalog --all --dry-run   # offline
 */
import { parseArgs, runScript, emitProgress, CliErrorObject } from "../src/lib/cli";
import { DRIFT_REPORT_FILE, runFalSync } from "../src/lib/models/fal-sync";

runScript(async () => {
  const args = parseArgs([
    { name: "catalog", type: "boolean", description: "Paginate the active listing" },
    { name: "schemas", description: "Comma list of endpoint IDs whose OpenAPI to fetch" },
    { name: "tier", choices: ["verified"], description: "Fetch schemas of every pinned (verified) endpoint" },
    { name: "all", type: "boolean", description: "Fetch schemas of every known endpoint" },
    {
      name: "verify-known",
      type: "boolean",
      description: "Look up indexed or pinned endpoints the listing missed; 404 marks them gone",
    },
    { name: "pin-verified", type: "boolean", description: "Fill null pins in fal-verified.json with the current hash" },
    { name: "from-fixtures", description: "Offline: directory with catalog-page.json and schemas/" },
    { name: "dry-run", type: "boolean", description: "Compute the drift report without writing" },
    { name: "report", type: "boolean", description: `Also write ${DRIFT_REPORT_FILE}` },
    { name: "out", description: "Index directory (default src/lib/models/fal-catalog)" },
    {
      name: "cache-dir",
      description: "Schema cache directory (default .cache/fal-schemas or AGENTBROS_FAL_SCHEMA_CACHE)",
    },
    { name: "verified-file", description: "Pins file (default src/lib/models/fal-verified.json)" },
    { name: "page-cap", type: "number", default: 40, description: "Hard cap on listing pages" },
  ] as const);
  const modes = [args.schemas, args.tier, args.all || undefined].filter(Boolean);
  if (modes.length > 1)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass one of --schemas, --tier verified or --all." });
  const result = await runFalSync({
    catalog: args.catalog,
    schemas: args.schemas
      ? args.schemas
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : args.tier === "verified"
        ? "verified"
        : args.all
          ? "all"
          : undefined,
    verifyKnown: args["verify-known"],
    pinVerified: args["pin-verified"],
    fromFixtures: args["from-fixtures"],
    dryRun: args["dry-run"],
    outDir: args.out,
    cacheDir: args["cache-dir"],
    verifiedFile: args["verified-file"],
    reportFile: args.report ? DRIFT_REPORT_FILE : undefined,
    pageCap: args["page-cap"],
    log: (message) => emitProgress(message),
  });
  return { outputs: result.written, metadata: result as unknown as Record<string, unknown> };
});
