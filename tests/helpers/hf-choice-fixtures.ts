import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildHiggsfieldEntry,
  findHiggsfieldFamily,
  parseHiggsfieldCatalogue,
} from "../../src/lib/models/hf-catalogue";
import { parseHiggsfieldWorkflowPage } from "../../src/lib/models/hf-docs";
import type { HiggsfieldPriceRecord } from "../../src/types/higgsfield";

export const choiceNow = new Date("2026-11-15T00:00:00Z");
export function hfChoiceCatalog() {
  const root = path.resolve(import.meta.dirname, "../fixtures/higgsfield");
  const workflows = readdirSync(path.join(root, "docs"))
    .sort()
    .flatMap((name) => {
      const row = parseHiggsfieldWorkflowPage(
        readFileSync(path.join(root, "docs", name), "utf8"),
        `https://docs.higgsfield.ai/docs/${name.replaceAll("_", "/")}`,
      );
      return row ? [row] : [];
    });
  const catalogue = parseHiggsfieldCatalogue(
    JSON.parse(readFileSync(path.join(root, "catalog-models.json"), "utf8")).results,
  );
  const entries = [...new Set([...workflows.map((row) => row.endpoint), ...catalogue.byModeId.keys()])].map(
    (endpoint) =>
      buildHiggsfieldEntry(
        workflows.find((row) => row.endpoint === endpoint),
        findHiggsfieldFamily(endpoint, catalogue, workflows),
        { endpoint, today: "2026-11-15" },
      ),
  );
  return new Map(entries.map((entry) => [entry.endpoint, entry]));
}
export function tierPrice(endpoint: string, rate = 0.1): HiggsfieldPriceRecord {
  return {
    endpoint,
    observedAsOf: "2026-11-15",
    list: null,
    estimates: [],
    tiers: [{ when: { resolution: "720p" }, usdPerUnit: rate, basis: "output-second", rounding: null }],
  };
}
export function floorPrice(endpoint: string, amount = 0.001): HiggsfieldPriceRecord {
  return {
    ...tierPrice(endpoint),
    tiers: [],
    list: {
      amount,
      originalAmount: null,
      unit: "second",
      qualifier: "from",
      discountPercentage: null,
      discountExpiresAt: null,
      discountAfterExpiryPercentage: null,
      discountAfterExpiryExpiresAt: null,
    },
  };
}
