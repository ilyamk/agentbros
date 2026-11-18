import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { checkModelSlots, loadModelSlots } from "../src/lib/models/model-slots";
import {
  buildCatalogPriceMatrix,
  currentPriceMatrix,
  loadPriceScenarios,
  PRICE_GAPS_FILE,
  PRICE_MATRIX_FILE,
  renderPriceGaps,
  updateCatalogPriceMatrices,
} from "../src/lib/models/price-matrix";
import { loadFalHistoricalPrices } from "../src/lib/models/fal-historical-pricing";
import { loadHiggsfieldPrices } from "../src/lib/models/hf-pricing";
import { modelChoicePrice } from "../src/lib/models/model-choice-price";
import { slotCatalogs } from "../src/lib/models/model-slots";
import { renderModelSlotsDoc } from "../src/lib/models/model-slots-maintenance";

runScript(async () => {
  const args = parseArgs([
    { name: "list", type: "boolean", description: "List slots (default)" },
    { name: "show", description: "Show one slot" },
    { name: "check", type: "boolean", description: "Check catalogue, evidence, class and concept coverage" },
    {
      name: "write-doc",
      type: "boolean",
      description: "Regenerate slot docs, both price matrices and the price gaps report",
    },
    { name: "check-doc", type: "boolean", description: "Check generated docs and matrices without writes" },
    { name: "project", description: "Optional MCP project scope" },
  ] as const);
  if ([args.list, args.show, args.check, args["write-doc"], args["check-doc"]].filter(Boolean).length > 1)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose one slots action" });
  const file = loadModelSlots();
  if (args["write-doc"] || args["check-doc"]) {
    const catalogs = slotCatalogs(),
      now = new Date(),
      matrix = currentPriceMatrix(file, catalogs, now);
    const serialised = `${JSON.stringify(matrix, null, 2)}\n`;
    const target = fileURLToPath(new URL("../docs/model-slots.md", import.meta.url)),
      document = renderModelSlotsDoc(file, { catalogs, now, matrix });
    const hfPrices = loadHiggsfieldPrices(),
      historical = loadFalHistoricalPrices();
    const catalogue = buildCatalogPriceMatrix(
      catalogs,
      { prices: (entry, setting) => modelChoicePrice(entry, setting, { now, hfPrices }), hfPrices, historical },
      loadPriceScenarios(),
      file,
      now,
    );
    // Validate every artefact before a check returns; a write also prunes obsolete category shards.
    const shards = updateCatalogPriceMatrices(catalogue, Boolean(args["check-doc"]));
    if (
      args["check-doc"] &&
      (readFileSync(target, "utf8") !== document ||
        readFileSync(PRICE_MATRIX_FILE, "utf8") !== serialised ||
        !shards.current)
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Stale model slots docs or price matrices; run pnpm models:slots --write-doc",
      });
    if (args["write-doc"]) {
      const previous = existsSync(PRICE_GAPS_FILE) ? readFileSync(PRICE_GAPS_FILE, "utf8") : "";
      let gaps: string;
      try {
        gaps = renderPriceGaps(matrix, catalogue, catalogs, previous);
      } catch {
        gaps = renderPriceGaps(matrix, catalogue, catalogs);
      }
      writeFileSync(target, document);
      writeFileSync(PRICE_MATRIX_FILE, serialised);
      mkdirSync(path.dirname(PRICE_GAPS_FILE), { recursive: true });
      writeFileSync(PRICE_GAPS_FILE, gaps);
    }
    return {
      outputs: args["write-doc"]
        ? [
            "docs/model-slots.md",
            "src/lib/models/price-matrix.json",
            ...shards.outputs,
            path.relative(process.cwd(), PRICE_GAPS_FILE),
          ]
        : [],
      metadata: {
        current: true,
        catalogMatrixBytes: shards.bytes,
        catalogRows: catalogue.reduce((count, shard) => count + shard.rows.length, 0),
      },
    };
  }
  if (args.check) {
    const report = checkModelSlots(file);
    if (report.errors.length)
      throw new CliErrorObject({ code: "VALIDATION", message: "Model slots check failed", details: report });
    return { metadata: report };
  }
  if (args.show) {
    const slot = file.slots.find((slot) => slot.id === args.show);
    if (!slot) throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown slot: ${args.show}` });
    return { metadata: { slot } };
  }
  return {
    metadata: {
      slots: file.slots.map(({ candidates, ...slot }) => ({ ...slot, candidates: candidates.length })),
      catalogueOnlyConcepts: file.catalogueOnlyConcepts,
    },
  };
});
