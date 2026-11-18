import { z } from "zod";
import { ModelReferenceSettingSchema } from "./model-slots";
import { FalCategorySchema, ProviderIdSchema } from "./fal-catalog";

const usd = z.number().finite().nonnegative();
export const HistoricalPriceSchema = z
  .object({ endpoint: z.string().min(1), usdPerCall: usd, currency: z.literal("USD"), observedAsOf: z.iso.date() })
  .strict();
export const HistoricalPricesFileSchema = z
  .object({ version: z.literal(1), syncedAt: z.iso.date().nullable(), records: z.array(HistoricalPriceSchema) })
  .strict()
  .superRefine((file, ctx) => {
    if (new Set(file.records.map((row) => row.endpoint)).size !== file.records.length)
      ctx.addIssue({ code: "custom", message: "Duplicate historical endpoint" });
  });
export const PriceScenarioSchema = z
  .object({
    id: z.string().min(1),
    setting: ModelReferenceSettingSchema,
    oneCall: z.boolean(),
    description: z.string().min(1),
  })
  .strict();
export const PriceScenariosFileSchema = z
  .object({
    version: z.literal(1),
    scenarios: z.array(PriceScenarioSchema),
    slots: z.record(z.string(), z.array(z.string()).min(1)),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = new Set(file.scenarios.map((row) => row.id));
    if (ids.size !== file.scenarios.length) ctx.addIssue({ code: "custom", message: "Duplicate scenario" });
    for (const [slot, scenarios] of Object.entries(file.slots))
      for (const id of scenarios)
        if (!ids.has(id)) ctx.addIssue({ code: "custom", message: `${slot}: unknown scenario ${id}` });
  });
export const MatrixCellSchema = z
  .object({
    usd: usd.nullable(),
    kind: z.enum(["exact", "approximate", "typical", "floor", "unknown"]),
    source: z.string(),
    formula: z.string().optional(),
    observedAsOf: z.string().nullable(),
    reason: z.string().optional(),
    linearUnit: z.enum(["durationSec", "inputCharacters", "inputAudioSec", "images"]).optional(),
  })
  .strict();
export const PriceMatrixSchema = z
  .object({
    version: z.literal(1),
    rows: z.array(
      z
        .object({
          slot: z.string(),
          provider: z.enum(["fal", "higgsfield"]),
          endpoint: z.string(),
          perCallTypicalUsd: usd.nullable(),
          perCallObservedAsOf: z.string().nullable(),
          scenarioPrices: z.record(z.string(), MatrixCellSchema),
        })
        .strict(),
    ),
  })
  .strict();
export const CatalogPriceMatrixSchema = z
  .object({
    version: z.literal(1),
    provider: ProviderIdSchema,
    category: FalCategorySchema,
    generatedAt: z.iso.date(),
    rows: z.array(
      z
        .object({
          provider: ProviderIdSchema,
          endpoint: z.string().min(1),
          displayName: z.string(),
          scenarioPrices: z.record(z.string(), MatrixCellSchema),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((file, ctx) => {
    if (file.rows.some((row) => row.provider !== file.provider))
      ctx.addIssue({ code: "custom", message: "Row provider differs from file provider" });
    if (new Set(file.rows.map((row) => row.endpoint)).size !== file.rows.length)
      ctx.addIssue({ code: "custom", message: "Duplicate catalogue endpoint" });
    for (const row of file.rows)
      for (const cell of Object.values(row.scenarioPrices)) {
        if (
          cell.kind === "unknown"
            ? cell.usd !== null || !cell.reason
            : cell.usd === null || !cell.source || !cell.observedAsOf
        )
          ctx.addIssue({ code: "custom", message: `${row.endpoint}: missing price evidence or unknown reason` });
        if (cell.kind === "approximate" && !cell.formula)
          ctx.addIssue({ code: "custom", message: `${row.endpoint}: approximate price needs a formula` });
      }
  });
export type CatalogPriceMatrix = z.infer<typeof CatalogPriceMatrixSchema>;
export type HistoricalPrice = z.infer<typeof HistoricalPriceSchema>;
export type PriceScenario = z.infer<typeof PriceScenarioSchema>;
export type PriceScenarios = z.infer<typeof PriceScenariosFileSchema>;
export type MatrixCell = z.infer<typeof MatrixCellSchema>;
export type PriceMatrix = z.infer<typeof PriceMatrixSchema>;
