import { currentPriceMatrix, PRICE_MATRIX_FILE } from "./price-matrix";
import type { PriceMatrix } from "../../types/price-matrix";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FalCatalogEntry, FalPriceRecord, ProviderId } from "../../types/fal-catalog";
import type { HiggsfieldPriceRecord } from "../../types/higgsfield";
import { loadProviderCatalog, resetProviderCatalogCache } from "./fal-catalog";
import { loadFalPrices, resetFalPricesCache } from "./fal-pricing";
import { loadHiggsfieldPrices } from "./hf-pricing";
import { compareModels, type ModelsComparison } from "./models-compare";
import { loadModelSlots } from "./model-slots-loader";
import { renderModelSlotsDoc, writeModelSlotRefresh } from "./model-slots-maintenance";
import { proposeSlotChanges, type FreshnessCatalogs } from "./model-slots-refresh";
export { proposeSlotChanges } from "./model-slots-refresh";
import type { ModelSlotsFile } from "../../types/model-slots";
import { slotModelPrice, type SlotPrices } from "./model-slots";
import { canonicalJson } from "../providers/fal-openapi";

export const ModelsRefreshQuerySchema = z
  .object({
    provider: z.enum(["fal", "higgsfield", "all"]).default("all"),
    dryRun: z.boolean().default(false),
    resume: z.boolean().default(false),
    sampleImage: z.string().url().optional(),
    sampleVideo: z.string().url().optional(),
    sampleAudio: z.string().url().optional(),
  })
  .strict();
export type ModelsRefreshQuery = z.input<typeof ModelsRefreshQuerySchema>;
export type RefreshStep = {
  id: "fal:sync" | "fal:pricing" | "fal:historical" | "hf:sync" | "hf:pricing" | "models:slots";
  provider: ProviderId | "all";
  args: string[];
  enabled: boolean;
  reason?: string;
};
export type RefreshStepResult = { ok: boolean; metadata?: Record<string, unknown> };
export type ModelRefreshSnapshot = {
  entries: FalCatalogEntry[];
  falPrices: FalPriceRecord[];
  hfPrices: HiggsfieldPriceRecord[];
};
export type RefreshDependencies = {
  runStep(step: RefreshStep): Promise<RefreshStepResult>;
  snapshot?(): ModelRefreshSnapshot;
  compare?(): ModelsComparison[];
  writeReport?(file: string, markdown: string): void;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  reportFile?: string;
  slots?(): ModelSlotsFile;
  writeSlots?(before: ModelSlotsFile, next: ModelSlotsFile): void;
  writeSlotsDoc?(markdown: string): void;
  writeMatrix?(matrix: PriceMatrix): void;
  mappedCategories?: string[];
  slotPrices?: SlotPrices;
};
export function modelRefreshSteps(query: ModelsRefreshQuery = {}, env: NodeJS.ProcessEnv = process.env): RefreshStep[] {
  const q = ModelsRefreshQuerySchema.parse(query);
  const steps: RefreshStep[] = [
    {
      id: "fal:sync",
      provider: "fal",
      args: ["--catalog", "--tier", "verified", "--verify-known", "--report"],
      enabled: true,
    },
    // Time boxes (minutes) keep the workflow inside its job timeout; stalest endpoints go first, so daily runs rotate through the catalogue.
    {
      id: "fal:pricing",
      provider: "fal",
      args: ["--sync", "--resume", "--partial", "--budget-minutes", "75"],
      enabled: Boolean(env.FAL_KEY),
      ...(!env.FAL_KEY ? { reason: "FAL_KEY absent" } : {}),
    },
    // Public model pages: no key needed.
    { id: "fal:pricing", provider: "fal", args: ["--docs", "--changed", "--resume"], enabled: true },
    {
      id: "fal:historical",
      provider: "fal",
      args: ["--historical", "--all", "--resume", "--budget-minutes", "120"],
      enabled: Boolean(env.FAL_KEY),
      ...(!env.FAL_KEY ? { reason: "FAL_KEY absent" } : {}),
    },
    { id: "hf:sync", provider: "higgsfield", args: q.resume ? ["--resume"] : [], enabled: true },
    {
      id: "hf:pricing",
      provider: "higgsfield",
      args: ["--sync", "--resume", "--scenarios"],
      enabled: Boolean(env.HIGGSFIELD_API_KEY),
      ...(!env.HIGGSFIELD_API_KEY ? { reason: "HIGGSFIELD_API_KEY absent" } : {}),
    },
    { id: "models:slots", provider: "all", args: ["--write-doc"], enabled: true },
  ];
  const samples = [
    ["--sample-image", q.sampleImage],
    ["--sample-video", q.sampleVideo],
    ["--sample-audio", q.sampleAudio],
  ].flatMap(([flag, value]) => (value ? [flag!, value] : []));
  steps.find((step) => step.id === "hf:pricing")!.args.push(...samples);
  return steps.filter((step) => q.provider === "all" || step.provider === "all" || step.provider === q.provider);
}
/** Retain missing historical samples after a partial failure; fresh matching evidence takes precedence. */
export function retainFailedHiggsfieldPrices(
  previous: readonly HiggsfieldPriceRecord[],
  current: readonly HiggsfieldPriceRecord[],
  failed: readonly string[],
): HiggsfieldPriceRecord[] {
  const prior = new Map(previous.map((row) => [row.endpoint, row]));
  const failures = new Set(failed);
  return current.map((row) => {
    const old = prior.get(row.endpoint);
    if (!failures.has(row.endpoint) || !old || !(old.list || old.tiers.length || old.estimates.length)) return row;
    if (!row.tiers.length && !row.estimates.length) return old;
    const estimates = new Map(old.estimates.map((estimate) => [canonicalJson(estimate.input), estimate]));
    for (const estimate of row.estimates) estimates.set(canonicalJson(estimate.input), estimate);
    const tiers = new Map(old.tiers.map((tier) => [canonicalJson(tier.when), tier]));
    for (const tier of row.tiers) tiers.set(canonicalJson(tier.when), tier);
    return { ...row, list: row.list ?? old.list, estimates: [...estimates.values()], tiers: [...tiers.values()] };
  });
}
export function modelRefreshSnapshot(): ModelRefreshSnapshot {
  resetProviderCatalogCache();
  resetFalPricesCache();
  return {
    entries: ["fal", "higgsfield"].flatMap((provider) => [...loadProviderCatalog(provider as ProviderId).values()]),
    falPrices: [...loadFalPrices().values()],
    hfPrices: [...loadHiggsfieldPrices().values()],
  };
}
function rates(snapshot: ModelRefreshSnapshot) {
  const rows = snapshot.falPrices.map((row) => ({
    provider: "fal" as ProviderId,
    endpoint: row.endpoint,
    kind: "platform-pricing-api",
    unit: row.unit,
    rate: row.unitPrice,
  }));
  for (const row of snapshot.hfPrices) {
    if (row.list)
      rows.push({
        provider: "higgsfield",
        endpoint: row.endpoint,
        kind: "higgsfield-list-floor",
        unit: row.list.unit,
        rate: row.list.amount,
      });
    for (const tier of row.tiers)
      rows.push({
        provider: "higgsfield",
        endpoint: row.endpoint,
        kind: `higgsfield-tier:${canonicalJson(tier.when)}:${tier.rounding}`,
        unit: tier.basis,
        rate: tier.usdPerUnit,
      });
    for (const estimate of row.estimates)
      if (estimate.type === "estimate" && estimate.usd !== undefined)
        rows.push({
          provider: "higgsfield",
          endpoint: row.endpoint,
          kind: `higgsfield-estimate:${canonicalJson(estimate.input)}`,
          unit: "request",
          rate: estimate.usd,
        });
  }
  return rows;
}
const CataloguePriceSchema = z.object({
  family: z.string(),
  primary: z
    .object({
      discount_percentage: z.coerce.number().nullable().optional(),
      discount_expires_at: z.string().nullable().optional(),
      discount_after_expiry_percentage: z.coerce.number().nullable().optional(),
      discount_after_expiry_expires_at: z.string().nullable().optional(),
      amount: z.coerce.number().optional(),
      original_amount: z.coerce.number().nullable().optional(),
    })
    .passthrough(),
});
export function modelRefreshChanges(
  before: ModelRefreshSnapshot,
  after: ModelRefreshSnapshot,
  results: readonly RefreshStepResult[],
  now: Date,
) {
  const key = (row: { provider?: ProviderId; endpoint: string }) => `${row.provider ?? "fal"}:${row.endpoint}`;
  const oldEntries = new Map(before.entries.map((row) => [key(row), row]));
  const newModels = after.entries
    .filter((row) => row.status === "active" && !oldEntries.has(key(row)))
    .map((row) => ({ provider: row.provider ?? "fal", endpoint: row.endpoint, releasedOn: row.releasedOn ?? null }));
  const retiring = after.entries
    .filter((row) => row.retiresAt || row.status === "deprecated")
    .map((row) => ({
      provider: row.provider ?? "fal",
      endpoint: row.endpoint,
      retiresAt: row.retiresAt ?? null,
      replacement: row.replacement ?? null,
    }));
  const gone = after.entries
    .filter((row) => row.status === "gone")
    .map((row) => ({
      provider: row.provider ?? "fal",
      endpoint: row.endpoint,
      newlyGone: oldEntries.get(key(row))?.status !== "gone",
    }));
  const rateKey = (row: ReturnType<typeof rates>[number]) => `${key(row)}:${row.kind}:${row.unit}`;
  const oldRates = new Map(rates(before).map((row) => [rateKey(row), row.rate]));
  const priceChanges = rates(after).flatMap((row) => {
    const old = oldRates.get(rateKey(row));
    if (old === undefined || old === row.rate || (old > 0 && Math.abs(row.rate - old) / old <= 0.01 + 1e-12)) return [];
    return [{ ...row, previousRate: old, changePercent: old > 0 ? ((row.rate - old) / old) * 100 : null }];
  });
  type Discount = {
    provider: ProviderId;
    endpoint: string;
    kind: string;
    percentage: number | null;
    expiresAt: string | null;
    expiryKnown: boolean;
    observedAsOf: string;
  };
  const discounts: Discount[] = [];
  const active = (expiry: string | null | undefined) => !expiry || Date.parse(expiry) > now.valueOf();
  for (const row of after.hfPrices) {
    const list = row.list;
    const followOn =
      list?.discountExpiresAt &&
      !active(list.discountExpiresAt) &&
      list.discountAfterExpiryPercentage &&
      active(list.discountAfterExpiryExpiresAt);
    if (followOn)
      discounts.push({
        provider: "higgsfield",
        endpoint: row.endpoint,
        kind: "higgsfield-list-after-expiry",
        percentage: list.discountAfterExpiryPercentage,
        expiresAt: list.discountAfterExpiryExpiresAt,
        expiryKnown: !!list.discountAfterExpiryExpiresAt,
        observedAsOf: row.observedAsOf,
      });
    if (list?.discountPercentage && active(list.discountExpiresAt))
      discounts.push({
        provider: "higgsfield",
        endpoint: row.endpoint,
        kind: "higgsfield-list",
        percentage: list.discountPercentage,
        expiresAt: list.discountExpiresAt,
        expiryKnown: !!list.discountExpiresAt,
        observedAsOf: row.observedAsOf,
      });
    for (const estimate of row.estimates)
      if ((estimate.discountPercentage || estimate.discountUsd) && active(list?.discountExpiresAt))
        discounts.push({
          provider: "higgsfield",
          endpoint: row.endpoint,
          kind: "higgsfield-estimate",
          percentage: estimate.discountPercentage ?? null,
          expiresAt: list?.discountExpiresAt ?? null,
          expiryKnown: !!list?.discountExpiresAt,
          observedAsOf: estimate.observedAt,
        });
  }
  for (const result of results)
    for (const raw of Array.isArray(result.metadata?.cataloguePricing) ? result.metadata.cataloguePricing : []) {
      const parsed = CataloguePriceSchema.safeParse(raw);
      if (!parsed.success) continue;
      const { family, primary } = parsed.data;
      if (
        primary.discount_expires_at &&
        !active(primary.discount_expires_at) &&
        primary.discount_after_expiry_percentage &&
        active(primary.discount_after_expiry_expires_at)
      )
        discounts.push({
          provider: "higgsfield",
          endpoint: family,
          kind: "higgsfield-catalogue-after-expiry",
          percentage: primary.discount_after_expiry_percentage,
          expiresAt: primary.discount_after_expiry_expires_at ?? null,
          expiryKnown: !!primary.discount_after_expiry_expires_at,
          observedAsOf: now.toISOString().slice(0, 10),
        });
      if (primary.discount_percentage && active(primary.discount_expires_at))
        discounts.push({
          provider: "higgsfield",
          endpoint: family,
          kind: "higgsfield-catalogue",
          percentage: primary.discount_percentage,
          expiresAt: primary.discount_expires_at ?? null,
          expiryKnown: !!primary.discount_expires_at,
          observedAsOf: now.toISOString().slice(0, 10),
        });
    }
  return {
    newModels,
    retiring,
    gone,
    priceChanges,
    discounts,
    discountCoverage:
      "Higgsfield catalogue and estimates; fal tracked prices contain no sale/expiry fields. Unknown expiry is not evidence that a sale remains active.",
  };
}
export async function refreshModels(query: ModelsRefreshQuery, dependencies: RefreshDependencies) {
  const q = ModelsRefreshQuerySchema.parse(query),
    plan = modelRefreshSteps(q, dependencies.env),
    now = dependencies.now ?? new Date();
  const snapshot = dependencies.snapshot ?? modelRefreshSnapshot;
  const propose = (current: ModelRefreshSnapshot) => {
    const slots = (dependencies.slots ?? loadModelSlots)();
    const catalogs: FreshnessCatalogs = {
      fal: new Map(current.entries.filter((e) => (e.provider ?? "fal") === "fal").map((e) => [e.endpoint, e])),
      higgsfield: new Map(current.entries.filter((e) => e.provider === "higgsfield").map((e) => [e.endpoint, e])),
      mappedCategories: dependencies.mappedCategories ?? localMappedCategories(),
    };
    const prices =
      dependencies.slotPrices ??
      new Map(
        current.entries.map((entry) => [
          `${entry.provider ?? "fal"}:${entry.endpoint}`,
          slotModelPrice(entry, { durationSec: 5, resolution: "720p", aspect: "16:9" }, undefined, now),
        ]),
      );
    return { before: slots, catalogs, prices, ...proposeSlotChanges(slots, catalogs, prices, now) };
  };
  if (q.dryRun)
    return {
      ok: true,
      dryRun: true,
      steps: plan.map((step) => ({
        ...step,
        ok: true,
        metadata: {} as Record<string, unknown>,
        status: step.enabled ? "planned" : "skipped",
      })),
      reportFile: null,
      slotProposals: propose(snapshot()).proposals,
    };
  const before = snapshot();
  const steps: (RefreshStep & RefreshStepResult & { status: string })[] = [];
  const run = async (step: RefreshStep) => {
    if (!step.enabled) {
      steps.push({ ...step, ok: true, status: "skipped" });
      return;
    }
    try {
      const result = await dependencies.runStep(step);
      const partial =
        result.metadata?.partial === true ||
        (result.metadata?.partial === undefined &&
          typeof result.metadata?.failed === "number" &&
          result.metadata.failed > 0);
      steps.push({
        ...step,
        ...result,
        ok: result.ok && !partial,
        status: result.ok && !partial ? "succeeded" : "failed",
      });
    } catch {
      steps.push({
        ...step,
        ok: false,
        status: "failed",
        metadata: { error: "Step failed; successful steps and observations are retained." },
      });
    }
  };
  for (const step of plan.filter((step) => step.id !== "models:slots")) await run(step);
  const after = snapshot(),
    slotChanges = propose(after);
  if (slotChanges.changed) {
    (dependencies.writeSlots ?? writeModelSlotRefresh)(slotChanges.before, slotChanges.table);
  }
  const matrix = currentPriceMatrix(slotChanges.table, slotChanges.catalogs, now, dependencies.slotPrices);
  const doc = renderModelSlotsDoc(slotChanges.table, { catalogs: slotChanges.catalogs, now, matrix });
  (dependencies.writeSlotsDoc ?? ((body) => writeFileSync("docs/model-slots.md", body)))(doc);
  (dependencies.writeMatrix ?? ((value) => writeFileSync(PRICE_MATRIX_FILE, `${JSON.stringify(value, null, 2)}\n`)))(
    matrix,
  );
  // Proposals must land before the final command rebuilds all catalogue shards and gap counts.
  await run(plan.find((step) => step.id === "models:slots")!);
  const changes = modelRefreshChanges(before, after, steps, now);
  const savings = (dependencies.compare ?? (() => compareModels({ resolution: "720p", durationSec: 5 }, { now })))()
    .filter((row) => row.savingUsd !== null && row.savingUsd > 0)
    .sort((a, b) => b.savingUsd! - a.savingUsd!)
    .slice(0, 10);
  const ok = steps.every((step) => step.ok),
    reportFile = dependencies.reportFile ?? "out/qa/model-refresh/model-refresh.md";
  const report = {
    generatedAt: now.toISOString(),
    ok,
    dryRun: false,
    steps,
    ...changes,
    slotProposals: slotChanges.proposals,
    savings,
    reportFile,
  };
  const list = (rows: unknown[]) =>
    rows.length ? rows.map((row) => `- ${JSON.stringify(row)}`).join("\n") : "None observed.";
  const markdown = `# Model refresh\n\nRecorded: ${report.generatedAt}. Result: ${ok ? "success" : "partial failure"}. No generation or paid calls.\n\n## Steps\n\n${list(steps.map(({ id, status, reason }) => ({ id, status, ...(reason ? { reason } : {}) })))}\n\n## New models\n\n${list(changes.newModels)}\n\n## Retiring\n\n${list(changes.retiring)}\n\n## Gone\n\n${list(changes.gone)}\n\n## Price changes beyond 1%\n\n${list(changes.priceChanges)}\n\n## Discounts and sales\n\n${changes.discountCoverage}\n\n${list(changes.discounts)}\n\n## Slot proposals\n\n${list(slotChanges.proposals)}\n\n## Top savings\n\nExact comparable requests at 720p, 5 output seconds. Floors excluded; each member carries evidence date and kind.\n\n${list(savings)}\n`;
  (
    dependencies.writeReport ??
    ((file, body) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    })
  )(reportFile, markdown);
  return report;
}

function localMappedCategories(): string[] {
  const file = path.resolve(import.meta.dirname, "model-use-cases.json");
  if (!existsSync(file)) return [];
  const data: unknown = JSON.parse(readFileSync(file, "utf8"));
  const categories = new Set<string>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.category === "string") categories.add(row.category);
    if (Array.isArray(row.categories))
      for (const category of row.categories) if (typeof category === "string") categories.add(category);
    Object.values(row).forEach(walk);
  };
  walk(data);
  return [...categories].sort();
}
