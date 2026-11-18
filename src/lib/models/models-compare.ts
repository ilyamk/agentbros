import { CliErrorObject } from "../cli";
import { loadCatalogPriceMatrices, loadPriceScenarios, matrixPriceLabel } from "./price-matrix";
import { loadModelSlots } from "./model-slots-loader";
import type { ModelSlotsFile } from "../../types/model-slots";
import { MatrixCellSchema, type CatalogPriceMatrix, type PriceScenarios } from "../../types/price-matrix";
import { z } from "zod";
import {
  FalCategorySchema,
  type FalCatalogEntry,
  type ModelChoicePrice,
  type ModelEquivalents,
  type ProviderId,
} from "../../types/fal-catalog";
import type { HiggsfieldPriceRecord } from "../../types/higgsfield";
import { loadProviderCatalog } from "./fal-catalog";
import { exactChoicePrice, modelChoicePrice, modelPriceInput, type ModelPriceParameters } from "./model-choice-price";

/** Explicit workflow/tier correspondences, from the two tracked catalogue IDs and their docs. */
export const MODEL_EQUIVALENTS = [
  {
    fal: "fal-ai/kling-video/v3/standard/text-to-video",
    higgsfield: "kling-video/v3.0/std/text-to-video",
    family: "Kling 3 standard text-to-video",
    fixedResolution: "720p",
    resolutionEvidence: "tests/fixtures/higgsfield/estimates.json",
    source: "https://docs.higgsfield.ai/docs/models/kling-3/standard-text-to-video.md",
  },
  {
    fal: "fal-ai/kling-video/v3/pro/text-to-video",
    higgsfield: "kling-video/v3.0/pro/text-to-video",
    family: "Kling 3 pro text-to-video",
    fixedResolution: "1080p",
    resolutionEvidence: "tests/fixtures/higgsfield/estimates.json",
    source: "https://docs.higgsfield.ai/docs/models/kling-3/pro-text-to-video.md",
  },
  {
    fal: "fal-ai/kling-video/v3/standard/image-to-video",
    higgsfield: "kling-video/v3.0/std/image-to-video",
    family: "Kling 3 standard image-to-video",
    source: "https://docs.higgsfield.ai/docs/models/kling-3/standard-image-to-video.md",
  },
  {
    fal: "fal-ai/kling-video/v3/pro/image-to-video",
    higgsfield: "kling-video/v3.0/pro/image-to-video",
    family: "Kling 3 pro image-to-video",
    source: "https://docs.higgsfield.ai/docs/models/kling-3/pro-image-to-video.md",
  },
] as const;
export const ModelsCompareQuerySchema = z
  .object({
    category: FalCategorySchema.optional(),
    endpoint: z.string().min(1).optional(),
    resolution: z.string().optional(),
    durationSec: z.number().positive().optional(),
  })
  .strict();
export type ModelsCompareQuery = z.infer<typeof ModelsCompareQuerySchema>;
export const EQUIVALENT_SCHEMA_NOTE =
  "Schemas differ: scaffold the request separately with fal:scaffold --provider fal or --provider higgsfield. Prices are planning evidence, not invoices.";
type Member = { provider: ProviderId; endpoint: string; price: ModelChoicePrice };
/** Savings require exact request totals at both providers; floor amounts never participate. */
export function equivalentPrices(members: Member[], sameParameters = true): ModelEquivalents {
  const [a, b] = [...members].sort((a, b) => a.provider.localeCompare(b.provider));
  const comparable = sameParameters && !!a && !!b && exactChoicePrice(a.price) && exactChoicePrice(b.price);
  const saving = comparable ? Number(Math.abs(a.price.usd! - b.price.usd!).toFixed(8)) : null;
  const high = comparable ? Math.max(a.price.usd!, b.price.usd!) : 0;
  return {
    members: [a!, b!],
    cheaper: comparable && saving! > 0 ? (a!.price.usd! < b!.price.usd! ? a!.provider : b!.provider) : null,
    savingUsd: saving,
    savingPercent: saving !== null && high > 0 ? Number(((saving / high) * 100).toFixed(6)) : null,
    note: `${EQUIVALENT_SCHEMA_NOTE}${comparable ? "" : " Savings unavailable: both prices must be exact for the same parameters; floors and unknowns excluded."}`,
  };
}
export type ModelsComparison = ModelEquivalents & {
  family: string;
  match: "identical-id" | "explicit-table";
  source: string;
  parameters: ModelsCompareQuery;
};
function supports(entry: FalCatalogEntry, q: ModelsCompareQuery, fixedResolution?: string): boolean {
  if (!entry.schema) return false;
  return (
    [
      ["resolution", q.resolution],
      ["duration", q.durationSec],
    ] as const
  ).every(([name, value]) => {
    if (value === undefined) return true;
    const field = entry.inputs.find((field) => field.name === name);
    if (!field) return name === "resolution" && value === fixedResolution;
    return (
      (!field.enum || field.enum.some((item) => String(item) === String(value))) &&
      (typeof value !== "number" ||
        ((field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max)))
    );
  });
}
export function sameModelParameters(a: FalCatalogEntry, b: FalCatalogEntry, parameters: ModelPriceParameters): boolean {
  if (a.category !== b.category || !a.schema || !b.schema) return false;
  const signature = (entry: FalCatalogEntry) => {
    const input = modelPriceInput(entry, parameters);
    const audio = input.generate_audio ?? (input.sound === "on" ? true : input.sound === "off" ? false : undefined);
    return JSON.stringify({
      resolution: input.resolution,
      duration: input.duration,
      aspect: input.aspect_ratio,
      audio,
      count: input.num_images ?? input.num_outputs ?? input.batch_size ?? 1,
    });
  };
  return (
    signature(a) === signature(b) &&
    (!a.category.includes("video") || (parameters.resolution !== undefined && parameters.durationSec !== undefined))
  );
}
export function compareModels(
  query: ModelsCompareQuery = {},
  options: {
    fal?: ReadonlyMap<string, FalCatalogEntry>;
    higgsfield?: ReadonlyMap<string, FalCatalogEntry>;
    hfPrices?: ReadonlyMap<string, HiggsfieldPriceRecord>;
    now?: Date;
  } = {},
): ModelsComparison[] {
  const q = ModelsCompareQuerySchema.parse(query),
    fal = options.fal ?? loadProviderCatalog("fal"),
    hf = options.higgsfield ?? loadProviderCatalog("higgsfield");
  const pairs = [
    ...[...fal.keys()]
      .filter((id) => hf.has(id))
      .map((id) => ({
        fal: id,
        higgsfield: id,
        family: id,
        source: "Identical endpoint ID in both tracked provider catalogues",
        match: "identical-id" as const,
      })),
    ...MODEL_EQUIVALENTS.map((pair) => ({ ...pair, match: "explicit-table" as const })),
  ];
  return pairs
    .flatMap((pair) => {
      const a = fal.get(pair.fal),
        b = hf.get(pair.higgsfield);
      if (
        !a ||
        !b ||
        a.status !== "active" ||
        b.status !== "active" ||
        a.category !== b.category ||
        (q.category && q.category !== a.category) ||
        (q.endpoint && ![pair.fal, pair.higgsfield, pair.family].includes(q.endpoint))
      )
        return [];
      const members = (
        [
          ["fal", a],
          ["higgsfield", b],
        ] as const
      ).map(([provider, entry]) => {
        const price = modelChoicePrice(entry, q, options);
        if (
          !supports(entry, q, "fixedResolution" in pair ? pair.fixedResolution : undefined) &&
          exactChoicePrice(price)
        )
          return {
            provider,
            endpoint: entry.endpoint,
            price: {
              ...price,
              kind: "unknown" as const,
              usd: null,
              label: "Parameters not established by this provider schema",
            },
          };
        return { provider, endpoint: entry.endpoint, price };
      });
      const compared = equivalentPrices(members, sameModelParameters(a, b, q));
      return [{ ...compared, family: pair.family, match: pair.match, source: pair.source, parameters: q }];
    })
    .sort((a, b) => a.family.localeCompare(b.family));
}

/** Scenario rankings are distinct from equivalent-model savings: all catalogue members may participate. */
export const ModelsPricesQuerySchema = z
  .object({
    scenario: z.string().min(1),
    category: FalCategorySchema.optional(),
    slot: z.string().min(1).optional(),
    provider: z.enum(["fal", "higgsfield", "any"]).default("any"),
    kind: z.array(MatrixCellSchema.shape.kind).min(1).optional(),
    maxUsd: z.number().finite().nonnegative().optional(),
    limit: z.number().int().min(1).max(10000).default(30),
  })
  .strict();
export type ModelsPricesQuery = z.input<typeof ModelsPricesQuerySchema>;
export function rankModelPrices(
  query: ModelsPricesQuery,
  options: { matrices?: CatalogPriceMatrix[]; slots?: ModelSlotsFile; scenarios?: PriceScenarios } = {},
) {
  const q = ModelsPricesQuerySchema.parse(query),
    scenarios = options.scenarios ?? loadPriceScenarios();
  if (!scenarios.scenarios.some((scenario) => scenario.id === q.scenario))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown scenario: ${q.scenario}` });
  const slots = options.slots ?? loadModelSlots();
  const slot = q.slot ? slots.slots.find((slot) => slot.id === q.slot) : undefined;
  if (q.slot && !slot) throw new CliErrorObject({ code: "INVALID_INPUT", message: `Unknown slot: ${q.slot}` });
  const membership = slot
    ? new Set(
        slot.candidates
          .filter((candidate) => candidate.status !== "retired")
          .map((candidate) => `${candidate.provider}:${candidate.endpoint}`),
      )
    : undefined;
  const rows = (options.matrices ?? loadCatalogPriceMatrices())
    .flatMap((file) => {
      if ((q.category && file.category !== q.category) || (q.provider !== "any" && file.provider !== q.provider))
        return [];
      return file.rows.flatMap((row) => {
        const cell = row.scenarioPrices[q.scenario];
        if (
          !cell ||
          (membership && !membership.has(`${row.provider}:${row.endpoint}`)) ||
          (q.kind && !q.kind.includes(cell.kind))
        )
          return [];
        // A floor is not a maximum; neither it nor an unknown can satisfy a budget bound.
        if (
          q.maxUsd !== undefined &&
          (cell.usd === null || cell.kind === "floor" || cell.kind === "unknown" || cell.usd > q.maxUsd)
        )
          return [];
        return [
          {
            provider: row.provider,
            endpoint: row.endpoint,
            displayName: row.displayName,
            category: file.category,
            scenario: q.scenario,
            ...cell,
            label: matrixPriceLabel(cell),
          },
        ];
      });
    })
    .sort(
      (a, b) =>
        (a.kind === "unknown" ? Infinity : (a.usd ?? Infinity)) -
          (b.kind === "unknown" ? Infinity : (b.usd ?? Infinity)) ||
        a.provider.localeCompare(b.provider) ||
        a.endpoint.localeCompare(b.endpoint),
    );
  return { offline: true, scenario: q.scenario, total: rows.length, rows: rows.slice(0, q.limit) };
}
