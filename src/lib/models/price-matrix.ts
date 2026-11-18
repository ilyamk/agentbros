import path from "node:path";
import { scenariosForCategory } from "./price-scenario-categories";
import scenarioData from "./price-scenarios.json";
import { loadFalHistoricalPrices } from "./fal-historical-pricing";
import { loadHiggsfieldPrices } from "./hf-pricing";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CatalogPriceMatrixSchema,
  PriceMatrixSchema,
  PriceScenariosFileSchema,
  type CatalogPriceMatrix,
  type PriceScenario,
  type HistoricalPrice,
  type MatrixCell,
  type PriceMatrix,
  type PriceScenarios,
} from "../../types/price-matrix";
import type { ModelReferenceSetting, ModelSlotCandidate, ModelSlotsFile } from "../../types/model-slots";
import type { FalCatalogEntry, ModelChoicePrice, ProviderId } from "../../types/fal-catalog";
import type { HiggsfieldPriceRecord } from "../../types/higgsfield";
import type { SlotCatalogs, SlotPrices } from "./model-slots";
import { checkModelConstraints } from "./model-constraints";
import { modelChoicePrice, planningChoicePrice } from "./model-choice-price";

export const PRICE_MATRIX_FILE = fileURLToPath(new URL("./price-matrix.json", import.meta.url));
export function loadPriceScenarios(): PriceScenarios {
  return PriceScenariosFileSchema.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL("./price-scenarios.json", import.meta.url)), "utf8")),
  );
}
const unknown: ModelChoicePrice = {
  kind: "unknown",
  label: "No price record",
  usd: null,
  unitPrice: null,
  unit: null,
  asOf: null,
  evidenceKind: "none",
  basis: null,
};
const round = (value: number) => Math.ceil(value * 10000 - 1e-9) / 10000;
export type ScenarioPriceSources = {
  prices: SlotPrices;
  hfPrices: ReadonlyMap<string, HiggsfieldPriceRecord>;
  historical: ReadonlyMap<string, HistoricalPrice>;
  now?: Date;
};
/** The resolver and evidence are supplied by the caller; no file reads or wall clock. */
export function scenarioCell(
  entry: FalCatalogEntry | undefined,
  provider: ProviderId,
  scenario: PriceScenario,
  sources: ScenarioPriceSources,
  candidate?: ModelSlotCandidate,
): MatrixCell {
  const { prices, hfPrices, historical } = sources;
  const endpoint = candidate?.endpoint ?? entry?.endpoint ?? "";
  const typical = provider === "fal" ? historical.get(endpoint) : undefined;
  // Video-to-video output length is the source length: a 10 s scenario means a 10 s source clip,
  // which lets per-source-second tariffs price it instead of falling back to a catalogue floor.
  const setting =
    entry?.category === "video-to-video" &&
    scenario.setting.durationSec !== undefined &&
    scenario.setting.inputVideoDurationSec === undefined
      ? { ...scenario.setting, inputVideoDurationSec: scenario.setting.durationSec }
      : scenario.setting;
  const price = !entry
    ? unknown
    : provider === "higgsfield"
      ? modelChoicePrice(entry, setting, {
          now: sources.now ?? new Date(`${hfPrices.get(entry.endpoint)?.observedAsOf ?? "1970-01-01"}T00:00:00Z`),
          hfPrices,
        })
      : typeof prices === "function"
        ? prices(entry, setting)
        : (prices.get(`${provider}:${endpoint}`) ?? unknown);
  const checked =
    entry &&
    checkModelConstraints(entry, {
      categories: [],
      inputs: [],
      outputs: [],
      durationSec: setting.durationSec,
      aspect: setting.aspect,
      resolution: setting.resolution,
      includeRetiring: true,
      includeSchemaless: true,
    });
  const common = {
    source:
      price.label.match(/https?:\/\/[^ ;)]+/)?.[0] ??
      `${price.evidenceKind}: ${provider === "fal" ? "src/lib/models/registry.ts / fal-prices.json" : "src/lib/models/hf-prices.json"}`,
    observedAsOf: price.asOf,
  };
  if (checked?.rejectedBecause.length)
    return { ...common, usd: null, kind: "unknown", reason: checked.rejectedBecause.join("; ") };
  let cell: MatrixCell;
  if (price.kind !== "typical" && planningChoicePrice(price)) {
    const basis = price.basis;
    const linearUnit: MatrixCell["linearUnit"] =
      basis === "generated-second" || (basis === "video-tokens" && !setting.inputVideoDurationSec)
        ? "durationSec"
        : basis === "input-kilo-characters"
          ? "inputCharacters"
          : basis === "input-audio-minute"
            ? "inputAudioSec"
            : basis === "output" || basis === "image"
              ? "images"
              : undefined;
    cell = {
      ...common,
      usd: price.usd,
      kind: price.kind === "approximate" ? "approximate" : "exact",
      formula: price.label,
      ...(linearUnit ? { linearUnit } : {}),
    };
  } else if (
    candidate?.referenceEstimate &&
    (candidate?.referenceEstimate.per !== "second" || setting.durationSec !== undefined)
  ) {
    const estimate = candidate.referenceEstimate;
    const units =
      estimate.per === "second" ? setting.durationSec! : estimate.per === "image" ? (setting.images ?? 1) : 1;
    cell = {
      usd: round(estimate.usd * units),
      kind: "approximate",
      source: estimate.source,
      observedAsOf: estimate.observedAsOf,
      formula: `${units} ${estimate.per} × $${estimate.usd}; ${estimate.setting}`,
      ...(estimate.per === "second"
        ? { linearUnit: "durationSec" as const }
        : estimate.per === "image"
          ? { linearUnit: "images" as const }
          : {}),
    };
  } else if (typical && scenario.oneCall) {
    cell = {
      usd: typical.usdPerCall,
      kind: "typical",
      source: "typical: fal historical average per call",
      observedAsOf: typical.observedAsOf,
      formula: "1 call × historical average; not specific to size or quality",
    };
  } else if (price.kind === "floor")
    cell = { ...common, usd: price.unitPrice, kind: "floor", reason: "Catalogue floor is not a scenario total" };
  else
    cell = {
      ...common,
      usd: null,
      kind: "unknown",
      reason: !entry
        ? "Endpoint missing from catalogue"
        : `${price.label}${typical ? "; historical average per call cannot price this scaled scenario" : ""}`,
    };
  if (checked?.warnings.length) cell.reason = [cell.reason, ...checked.warnings].filter(Boolean).join("; ");
  return cell;
}
/** Pure given the supplied catalogue, price resolver, history, scenarios and clock. */
export function buildPriceMatrix(
  slots: ModelSlotsFile,
  catalogs: SlotCatalogs,
  prices: SlotPrices,
  hfPrices: ReadonlyMap<string, HiggsfieldPriceRecord>,
  historical: ReadonlyMap<string, HistoricalPrice>,
  now: Date,
  scenarios: PriceScenarios = PriceScenariosFileSchema.parse(scenarioData),
): PriceMatrix {
  const definitions = new Map(scenarios.scenarios.map((s) => [s.id, s]));
  return PriceMatrixSchema.parse({
    version: 1,
    rows: slots.slots.flatMap((slot) =>
      slot.candidates.map((candidate) => {
        const entry = catalogs[candidate.provider]?.get(candidate.endpoint);
        const typical = candidate.provider === "fal" ? historical.get(candidate.endpoint) : undefined;
        const scenarioPrices = Object.fromEntries(
          (scenarios.slots[slot.id] ?? []).map((id) => {
            const scenario = definitions.get(id)!;
            return [
              id,
              scenarioCell(entry, candidate.provider, scenario, { prices, hfPrices, historical, now }, candidate),
            ];
          }),
        );
        return {
          slot: slot.id,
          provider: candidate.provider,
          endpoint: candidate.endpoint,
          perCallTypicalUsd: typical?.usdPerCall ?? null,
          perCallObservedAsOf: typical?.observedAsOf ?? null,
          scenarioPrices,
        };
      }),
    ),
  });
}
/** Only scale an evidenced linear quantity. Shape/audio/area/reference inputs must still match. */
export function priceFromScenarios(
  row: PriceMatrix["rows"][number],
  setting: ModelReferenceSetting,
  scenarios: PriceScenarios,
): MatrixCell | undefined {
  const eligible = scenarios.scenarios
    .flatMap((scenario) => {
      const cell = row.scenarioPrices[scenario.id];
      if (!cell || cell.usd === null || cell.kind === "floor" || cell.kind === "unknown") return [];
      const keys = new Set([
        ...Object.keys(setting),
        ...Object.keys(scenario.setting),
      ] as (keyof ModelReferenceSetting)[]);
      const different = [...keys].filter((key) => setting[key] !== scenario.setting[key]);
      if (!different.length) return [{ cell, id: scenario.id, factor: 1, distance: 0, exact: true }];
      const unit = cell.linearUnit;
      if (
        !unit ||
        cell.kind === "typical" ||
        different.some((key) => key !== unit) ||
        !setting[unit] ||
        !scenario.setting[unit]
      )
        return [];
      const quantity = (value: number) => (unit === "inputCharacters" ? Math.max(1, Math.ceil(value / 1000)) : value);
      const factor = quantity(setting[unit]!) / quantity(scenario.setting[unit]!);
      return [{ cell, id: scenario.id, factor, distance: Math.abs(Math.log(factor)), exact: false }];
    })
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const match = eligible[0];
  if (
    !match ||
    !Number.isFinite(match.cell.usd! * match.factor) ||
    match.cell.usd! * match.factor * 10000 > Number.MAX_SAFE_INTEGER
  )
    return undefined;
  return match.exact
    ? { ...match.cell, formula: `${match.cell.formula ?? match.cell.source}; scenario ${match.id}` }
    : {
        ...match.cell,
        kind: "approximate",
        usd: round(match.cell.usd! * match.factor),
        formula: `≈ from scenario ${match.id} scaled ×${match.factor}; ${match.cell.formula ?? match.cell.source}`,
      };
}
export function matrixPriceLabel(cell: MatrixCell): string {
  if (cell.usd === null || cell.kind === "unknown") return "?";
  return `${cell.kind === "approximate" ? "≈" : cell.kind === "typical" ? "~" : cell.kind === "floor" ? "≥" : ""}$${Number(cell.usd.toPrecision(4))}${cell.kind === "typical" ? " typ" : ""}`;
}

export function currentPriceMatrix(
  slots: ModelSlotsFile,
  catalogs: SlotCatalogs,
  now: Date,
  prices?: SlotPrices,
  historical = loadFalHistoricalPrices(),
): PriceMatrix {
  const hfPrices = loadHiggsfieldPrices();
  return buildPriceMatrix(
    slots,
    catalogs,
    prices ?? ((entry, setting) => modelChoicePrice(entry, setting, { now, hfPrices })),
    hfPrices,
    historical,
    now,
  );
}

export const PRICE_MATRIX_CATALOG_DIR = fileURLToPath(new URL("./price-matrix-catalog", import.meta.url));
export const PRICE_GAPS_FILE = fileURLToPath(new URL("../../../out/qa/model-prices/price-gaps.md", import.meta.url));
export function catalogPriceMatrixDirectory(): string {
  return process.env.AGENTBROS_PRICE_MATRIX_CATALOG_DIR ?? PRICE_MATRIX_CATALOG_DIR;
}
const catalogMatrixName = (file: CatalogPriceMatrix) => `${file.provider}-${file.category}.json`;
/** Stable provider/category shards; neither catalogue iteration order nor the wall clock dates the output. */
export function buildCatalogPriceMatrix(
  catalogs: SlotCatalogs,
  sources: Omit<ScenarioPriceSources, "now">,
  scenarios: PriceScenarios,
  slots: ModelSlotsFile,
  _now: Date,
): CatalogPriceMatrix[] {
  const files: CatalogPriceMatrix[] = [];
  for (const provider of ["fal", "higgsfield"] as const) {
    const entries = [...(catalogs[provider]?.values() ?? [])]
      .filter((entry) => entry.status === "active")
      .sort((a, b) => a.endpoint.localeCompare(b.endpoint));
    const categories = [...new Set(entries.map((entry) => entry.category))].sort();
    for (const category of categories) {
      const group = entries.filter((entry) => entry.category === category);
      const definitions = scenariosForCategory(category, slots, scenarios);
      const dates = group.flatMap((entry) => [
        entry.lastSeen,
        entry.schema?.asOf,
        entry.price?.observedAsOf,
        provider === "fal"
          ? sources.historical.get(entry.endpoint)?.observedAsOf
          : sources.hfPrices.get(entry.endpoint)?.observedAsOf,
      ]);
      // Snapshot comparisons use the evidence date, including discount freshness, rather than today's clock.
      const sourceDay =
        dates
          .filter((date): date is string => !!date)
          .map((date) => date.slice(0, 10))
          .sort()
          .at(-1) ?? "1970-01-01";
      const sourceNow = new Date(`${sourceDay}T00:00:00Z`);
      const rows = group.map((entry) => ({
        provider,
        endpoint: entry.endpoint,
        displayName: entry.displayName,
        scenarioPrices: Object.fromEntries(
          definitions.map((scenario) => [
            scenario.id,
            scenarioCell(entry, provider, scenario, { ...sources, now: sourceNow }),
          ]),
        ),
      }));
      dates.push(
        ...rows.flatMap((row) => Object.values(row.scenarioPrices).map((cell) => cell.observedAsOf ?? undefined)),
      );
      const generatedAt =
        dates
          .filter((date): date is string => !!date)
          .map((date) => date.slice(0, 10))
          .sort()
          .at(-1) ?? "1970-01-01";
      files.push(CatalogPriceMatrixSchema.parse({ version: 1, provider, category, generatedAt, rows }));
    }
  }
  return files;
}
/** Compact cells, with one row per line so catalogue changes remain reviewable. */
export function serialiseCatalogPriceMatrix(file: CatalogPriceMatrix): string {
  const { rows, ...header } = file;
  return `${JSON.stringify(header).slice(0, -1)},"rows":[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]}\n`;
}
export function loadCatalogPriceMatrices(directory = catalogPriceMatrixDirectory()): CatalogPriceMatrix[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => CatalogPriceMatrixSchema.parse(JSON.parse(readFileSync(path.join(directory, file), "utf8"))));
}
/** Check the complete shard set too, including categories removed by a refresh. */
export function updateCatalogPriceMatrices(
  files: CatalogPriceMatrix[],
  check: boolean,
  directory = catalogPriceMatrixDirectory(),
): { current: boolean; bytes: number; outputs: string[] } {
  const expected = new Map(files.map((file) => [catalogMatrixName(file), serialiseCatalogPriceMatrix(file)]));
  const existing = existsSync(directory) ? readdirSync(directory).filter((file) => file.endsWith(".json")) : [];
  const current =
    existing.length === expected.size &&
    existing.every(
      (file) => expected.has(file) && readFileSync(path.join(directory, file), "utf8") === expected.get(file),
    );
  if (!check) {
    mkdirSync(directory, { recursive: true });
    for (const file of existing) if (!expected.has(file)) unlinkSync(path.join(directory, file));
    for (const [file, body] of expected) writeFileSync(path.join(directory, file), body);
  }
  return {
    current,
    bytes: [...expected.values()].reduce((total, body) => total + Buffer.byteLength(body), 0),
    outputs: [...expected.keys()].map((file) => path.join(directory, file)),
  };
}
const cellKinds = ["exact", "approximate", "typical", "floor", "unknown"] as const;
type Coverage = Record<(typeof cellKinds)[number], number> & { rows: number; cells: number };
function coverage(rows: { scenarioPrices: Record<string, MatrixCell> }[]): Coverage {
  const counts: Coverage = { rows: rows.length, cells: 0, exact: 0, approximate: 0, typical: 0, floor: 0, unknown: 0 };
  for (const row of rows)
    for (const cell of Object.values(row.scenarioPrices)) {
      counts.cells++;
      counts[cell.kind]++;
    }
  return counts;
}
/** Group the cause rather than endpoint names, quantities, URLs or appended warnings. */
export function normalisePriceGapReason(reason: string): string {
  return reason
    .replace(/^Unknown price;\s*/i, "")
    .split(";")[0]!
    .replace(/https?:\/\/\S+/g, "<source>")
    .replace(/\b[\w.-]+\/[\w/.-]+/g, "<endpoint>")
    .replace(/\d+(?:\.\d+)?/g, "#")
    .trim()
    .toLowerCase();
}
const tableValue = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
export function renderPriceGaps(
  matrix: PriceMatrix,
  catalog: CatalogPriceMatrix[],
  catalogs: SlotCatalogs,
  previousDocument = "",
): string {
  const slotRows = matrix.rows,
    catalogRows = catalog.flatMap((file) => file.rows);
  const current = { slot: coverage(slotRows), catalogue: coverage(catalogRows) };
  type Counts = typeof current;
  let previous: Counts | null = null;
  const old = previousDocument.match(/<!-- price-gaps (.+) -->/);
  if (old) {
    const saved = JSON.parse(old[1]!) as { current: Counts; previous: Counts | null };
    previous = JSON.stringify(saved.current) === JSON.stringify(current) ? saved.previous : saved.current;
  }
  const records = [
    ...slotRows.flatMap((row) =>
      Object.entries(row.scenarioPrices).map(([scenario, cell]) => ({
        scope: "slot",
        category: catalogs[row.provider]?.get(row.endpoint)?.category ?? "unknown",
        scenario,
        cell,
      })),
    ),
    ...catalog.flatMap((file) =>
      file.rows.flatMap((row) =>
        Object.entries(row.scenarioPrices).map(([scenario, cell]) => ({
          scope: "catalogue",
          category: file.category,
          scenario,
          cell,
        })),
      ),
    ),
  ].filter((row) => row.cell.kind === "unknown");
  const reasons = new Map<string, { slot: number; catalogue: number }>();
  const groups = new Map<string, number>();
  for (const row of records) {
    const reason = normalisePriceGapReason(row.cell.reason ?? "Missing reason"),
      counts = reasons.get(reason) ?? { slot: 0, catalogue: 0 };
    if (row.scope === "slot") counts.slot++;
    else counts.catalogue++;
    reasons.set(reason, counts);
    const key = `${row.scope} | ${row.category} | ${row.scenario}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const endpoints = new Map<string, { count: number; scenarios: Set<string>; slots: Set<string> }>();
  for (const row of slotRows)
    for (const [id, cell] of Object.entries(row.scenarioPrices))
      if (cell.kind === "unknown") {
        const key = `${row.provider}:${row.endpoint}`,
          item = endpoints.get(key) ?? { count: 0, scenarios: new Set<string>(), slots: new Set<string>() };
        item.count++;
        item.scenarios.add(id);
        item.slots.add(row.slot);
        endpoints.set(key, item);
      }
  const delta = (value: number) => (value > 0 ? `+${value}` : String(value));
  const lines = [
    "# Price gaps",
    "",
    `Source date: ${
      catalog
        .map((file) => file.generatedAt)
        .sort()
        .at(-1) ?? "unknown"
    }. Offline tracked evidence; no provider calls.`,
    "",
    `<!-- price-gaps ${JSON.stringify({ current, previous })} -->`,
    "",
    "## Coverage by cell kind",
    "",
    "| Matrix | Rows | Cells | Exact | Approximate | Typical | Floor | Unknown |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const [scope, counts] of Object.entries(current))
    lines.push(
      `| ${scope} | ${counts.rows} | ${counts.cells} | ${cellKinds.map((kind) => counts[kind]).join(" | ")} |`,
    );
  lines.push(
    "",
    "## Delta from the previous tracked counts",
    "",
    previous
      ? "Positive values mean more cells of that kind; new catalogue entries can increase unknowns."
      : "Initial catalogue baseline; no previous tracked gaps counts available.",
    "",
    "| Matrix | Rows | Cells | Exact | Approximate | Typical | Floor | Unknown |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  if (previous)
    for (const scope of ["slot", "catalogue"] as const)
      lines.push(
        `| ${scope} | ${delta(current[scope].rows - previous[scope].rows)} | ${delta(current[scope].cells - previous[scope].cells)} | ${cellKinds.map((kind) => delta(current[scope][kind] - previous[scope][kind])).join(" | ")} |`,
      );
  lines.push(
    "",
    "## Unknown reasons (normalised prefix)",
    "",
    "| Reason | Slot cells | Catalogue cells |",
    "|---|---:|---:|",
  );
  for (const [reason, counts] of [...reasons].sort(
    (a, b) => b[1].slot + b[1].catalogue - a[1].slot - a[1].catalogue || a[0].localeCompare(b[0]),
  ))
    lines.push(`| ${tableValue(reason)} | ${counts.slot} | ${counts.catalogue} |`);
  lines.push(
    "",
    "## Unknown by category × scenario",
    "",
    "| Matrix | Category | Scenario | Unknown cells |",
    "|---|---|---|---:|",
  );
  for (const [key, count] of [...groups].sort(([a], [b]) => a.localeCompare(b))) lines.push(`| ${key} | ${count} |`);
  lines.push(
    "",
    "## Top 30 slot-candidate endpoints still unknown",
    "",
    "Counts include repeated endpoint membership in different slots.",
    "",
    "| Provider:endpoint | Unknown cells | Scenarios | Slots |",
    "|---|---:|---|---|",
  );
  for (const [key, item] of [...endpoints]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 30))
    lines.push(
      `| ${tableValue(key)} | ${item.count} | ${[...item.scenarios].sort().join(", ")} | ${[...item.slots].sort().join(", ")} |`,
    );
  lines.push(
    "",
    "Unknowns are never free. Approximate cells retain their formula and source; historical typicals do not establish scaled scenario totals. Floors are unbounded catalogue minima.",
    "",
  );
  return lines.join("\n");
}
