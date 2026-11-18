import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliErrorObject, emitResult, parseArgs, runScript } from "../src/lib/cli";
import { retainFailedHiggsfieldPrices } from "../src/lib/models/models-refresh";
import { loadProviderCatalog, resolveProviderSnapshot } from "../src/lib/models/fal-catalog";
import {
  hfPricesPath,
  higgsfieldPricesFromFixtures,
  loadHiggsfieldPrices,
  reparseHiggsfieldPrices,
  serialiseHiggsfieldPrices,
  summariseHiggsfieldUsage,
  syncHiggsfieldPrices,
  syncHiggsfieldScenarioEstimates,
  type HiggsfieldFetch,
} from "../src/lib/models/hf-pricing";
import { loadPriceScenarios } from "../src/lib/models/price-matrix";

export async function hfPricingCommand(fetchImpl: HiggsfieldFetch = (url, init) => fetch(url, init)) {
  const startedAt = Date.now();
  const args = parseArgs([
    {
      name: "reparse",
      type: "boolean",
      description: "Rebuild stored tiers and reasons offline without changing observations",
    },
    { name: "sync", type: "boolean", description: "Free catalogue and estimate requests; requires HIGGSFIELD_API_KEY" },
    {
      name: "scenarios",
      type: "boolean",
      description: "With --sync, estimate every applicable standard scenario (free)",
    },
    { name: "endpoints", description: "With --sync --scenarios, comma-separated catalogue endpoint IDs" },
    {
      name: "check-usage",
      type: "boolean",
      description: "With --sync --scenarios, include account usage analytics before estimates",
    },
    {
      name: "from-fixtures",
      description: "Recorded estimates.json file; catalogue defaults to its sibling catalog-models.json",
    },
    { name: "catalogue", description: "Offline catalogue fixture file" },
    { name: "dry-run", type: "boolean", description: "Do not write prices or checkpoints" },
    { name: "resume", type: "boolean", description: "Skip endpoints completed in the dated checkpoint" },
    { name: "as-of", description: "Sync date YYYY-MM-DD (resume on the original date)" },
    { name: "sample-image", description: "Public image sample URL for minimal estimate inputs" },
    { name: "sample-video", description: "Public video sample URL for minimal estimate inputs" },
    { name: "sample-audio", description: "Public audio sample URL for minimal estimate inputs" },
  ] as const);
  if ([args.sync, args["from-fixtures"], args.reparse].filter(Boolean).length !== 1)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose --sync, --reparse or --from-fixtures FILE." });
  if ((args.scenarios || args.endpoints || args["check-usage"]) && !(args.sync && args.scenarios))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--scenarios, --endpoints and --check-usage require --sync --scenarios.",
    });
  if (args.reparse) {
    const file = hfPricesPath();
    const stored = JSON.parse(readFileSync(file, "utf8")) as { syncedAt: string | null };
    const before = [...loadHiggsfieldPrices(file).values()];
    const records = reparseHiggsfieldPrices(before);
    const counts = (rows: typeof records) => {
      const parsed = rows.filter(
        (row) => row.tiers.length || row.estimates.some((estimate) => estimate.type === "estimate"),
      ).length;
      return { parsed, unknown: rows.length - parsed };
    };
    if (!args["dry-run"]) writeFileSync(file, serialiseHiggsfieldPrices(records, stored.syncedAt));
    return {
      outputs: args["dry-run"] ? [] : [file],
      metadata: {
        records: records.length,
        before: counts(before),
        after: counts(records),
        unknowns: records
          .filter((row) => !row.tiers.length && !row.estimates.some((estimate) => estimate.type === "estimate"))
          .map((row) => ({ endpoint: row.endpoint, reason: row.unparsed })),
        dryRun: Boolean(args["dry-run"]),
      },
    };
  }
  if (args.sync && !process.env.HIGGSFIELD_API_KEY)
    throw new CliErrorObject({
      code: "MISSING_API_KEY",
      message: "HIGGSFIELD_API_KEY is required for a free estimate sync.",
    });
  const now = args["as-of"] ? new Date(`${args["as-of"]}T00:00:00Z`) : new Date();
  if (!Number.isFinite(now.valueOf()))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid --as-of date." });
  if (args.scenarios) {
    const date = now.toISOString().slice(0, 10);
    const checkpointFile = path.resolve(".cache/hf-pricing", `scenarios-${date}.jsonl`);
    const catalogue = loadProviderCatalog("higgsfield");
    const selected = args.endpoints
      ? [
          ...new Set(
            args.endpoints
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ]
      : [...catalogue.keys()];
    if (!selected.length || selected.some((endpoint) => !catalogue.has(endpoint)))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Every --endpoints value must exist in the Higgsfield catalogue.",
      });
    const usageBefore = args["check-usage"] ? await summariseHiggsfieldUsage(date, fetchImpl, { now }) : undefined;
    const result = await syncHiggsfieldScenarioEstimates(
      selected.map((endpoint) => catalogue.get(endpoint)!),
      loadPriceScenarios(),
      fetchImpl,
      {
        now,
        samples: { image: args["sample-image"], video: args["sample-video"], audio: args["sample-audio"] },
        ...(args["dry-run"] ? {} : { checkpointFile }),
        resume: Boolean(args.resume),
      },
    );
    const file = hfPricesPath();
    if (!args["dry-run"]) writeFileSync(file, serialiseHiggsfieldPrices(result.records, result.partial ? null : date));
    const output = {
      outputs: args["dry-run"] ? [] : [file],
      metadata: {
        requests: result.requests,
        resumed: result.resumed,
        perScenario: result.perScenario,
        results: result.results.map(({ estimate: _estimate, ...row }) => row),
        failed: result.failed.length,
        failures: result.failed,
        records: result.records.length,
        partial: result.partial,
        checkpointFile,
        dryRun: Boolean(args["dry-run"]),
        ...(usageBefore ? { usageBefore } : {}),
      },
    };
    if (result.partial)
      emitResult({
        ok: false,
        error: "NETWORK",
        message: "Higgsfield scenario sync is partial; previous and successful estimates are retained.",
        ...output,
        elapsedMs: Date.now() - startedAt,
      });
    return output;
  }
  const checkpointFile = path.resolve(".cache/hf-pricing", `${now.toISOString().slice(0, 10)}.jsonl`);
  const result = args["from-fixtures"]
    ? higgsfieldPricesFromFixtures(
        JSON.parse(readFileSync(args["from-fixtures"], "utf8")),
        JSON.parse(
          readFileSync(args.catalogue ?? path.join(path.dirname(args["from-fixtures"]), "catalog-models.json"), "utf8"),
        ),
      )
    : await syncHiggsfieldPrices(
        [...loadProviderCatalog("higgsfield").values()].map((entry) => ({
          endpoint: entry.endpoint,
          family: entry.family?.slug,
          schema: resolveProviderSnapshot("higgsfield", entry.endpoint)?.input,
        })),
        fetchImpl,
        {
          now,
          samples: { image: args["sample-image"], video: args["sample-video"], audio: args["sample-audio"] },
          ...(args["dry-run"] ? {} : { checkpointFile }),
          resume: Boolean(args.resume),
        },
      );
  const file = hfPricesPath();
  const previous = existsSync(file) ? [...loadHiggsfieldPrices(file).values()] : [];
  const records = retainFailedHiggsfieldPrices(
    previous,
    result.records,
    result.failed.map((row) => row.endpoint),
  );
  if (!args["dry-run"])
    writeFileSync(
      file,
      serialiseHiggsfieldPrices(
        records,
        result.partial
          ? null
          : args["from-fixtures"]
            ? (result.records[0]?.observedAsOf ?? null)
            : now.toISOString().slice(0, 10),
      ),
    );
  const output = {
    outputs: args["dry-run"] ? [] : [file],
    metadata: {
      ...result,
      failed: result.failed.length,
      failures: result.failed,
      records: records.length,
      retainedHistoricalPrices: records.filter((row) => previous.includes(row)).map((row) => row.endpoint),
      checkpointFile,
      dryRun: Boolean(args["dry-run"]),
    },
  };
  if (result.partial)
    emitResult({
      ok: false,
      error: "NETWORK",
      message: "Higgsfield pricing sync is partial; successful historical evidence is retained.",
      ...output,
      elapsedMs: Date.now() - startedAt,
    });
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runScript(() => hfPricingCommand());
