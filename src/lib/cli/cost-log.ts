/**
 * Append-only cost ledger writer.
 *
 * Every paid external-API call should append one JSON line to
 *   public/projects/{projectId}/pipeline/cost-ledger.jsonl
 *
 * The ledger is the source of truth for `scripts/cost-report.ts`.
 *
 * Each entry is a single JSON line (JSONL — no array wrapper) so concurrent
 * writers never corrupt the file and we can append cheaply without re-parsing.
 *
 * Use `logCost` from any production script. The function silently skips when
 * `projectId` is undefined (single-shot scripts that don't belong to a project
 * can opt out — see `--no-cost-log` convention).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { PricingQuote } from "../pricing.js";
import { validateProjectId, assertPathWithin } from "./index.js";
import { estimate as estimateModel } from "../pricing.js";

export interface CostEntry {
  /** ISO timestamp */
  ts: string;
  projectId: string;
  provider?: string;
  operationId?: string;
  /** Pipeline stage that triggered this cost (best-effort) */
  stage?: string;
  /** Script filename (e.g. "generate-image.ts") */
  scriptId?: string;
  /** Asset id from asset-plan.json if applicable */
  assetId?: string;
  /** Logical service name (display only) */
  service: string;
  /** Pricing-table model key */
  model: string;
  /** Units consumed and the unit type */
  units: number | null;
  unitName: "image" | "second" | "minute" | "1k_chars" | "request";
  /** Multiplier (quality, resolution adjustment) — defaults to 1 */
  multiplier?: number;
  /** Estimated cost in USD (computed via pricing.estimate when not provided) */
  estimatedUsd: number | null;
  quote?: PricingQuote;
  /** Real cost when provider returns it (preferred over estimate) */
  actualUsd?: number | null;
  /** Free-text notes — model variant, resolution, anything useful */
  notes?: string;
}

export interface LogCostInput {
  projectId?: string;
  stage?: string;
  scriptId?: string;
  assetId?: string;
  service: string;
  model: string;
  units: number | null;
  unitName: CostEntry["unitName"];
  multiplier?: number;
  actualUsd?: number | null;
  notes?: string;
  /** The durable job's operation id when an `OperationStore` job already counts this spend (readers dedupe on it). */
  operationId?: string;
  provider?: string;
}

function ledgerPath(projectId: string): string {
  validateProjectId(projectId);
  const filePath = path.join(process.cwd(), "public", "projects", projectId, "pipeline", "cost-ledger.jsonl");
  assertPathWithin(path.resolve("public/projects"), filePath);
  return filePath;
}

/**
 * Append a single cost entry to the ledger. No-op when `projectId` is missing.
 *
 * Returns the entry that was written (or null when skipped) so callers can
 * surface the value in stdout JSON metadata if they wish.
 */
export function logCost(input: LogCostInput): CostEntry | null {
  if (!input.projectId) return null;
  if (input.actualUsd != null && (!Number.isFinite(input.actualUsd) || input.actualUsd < 0))
    throw new RangeError("Actual billing must be finite and nonnegative");

  const est = estimateModel({
    model: input.model,
    units: input.units,
    multiplier: input.multiplier,
  });

  const entry: CostEntry = {
    ts: new Date().toISOString(),
    projectId: input.projectId,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    stage: input.stage,
    scriptId: input.scriptId,
    assetId: input.assetId,
    service: input.service,
    model: input.model,
    units: input.units,
    unitName: input.unitName,
    multiplier: input.multiplier,
    estimatedUsd: est.estimatedUsd,
    quote: est.quote,
    actualUsd: input.actualUsd ?? null,
    notes: input.notes ?? est.notes,
  };

  const filePath = ledgerPath(input.projectId);
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(filePath, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
  return entry;
}

/** Idempotent reader for cost-report and budget-gate consumers. */
export function readLedger(projectId: string): CostEntry[] {
  const filePath = ledgerPath(projectId);
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CostEntry);
}

/** Returns null when any unresolved entry has no estimate or actual bill. */
export function totalUsd(entries: CostEntry[]): number | null {
  let total = 0;
  for (const entry of entries) {
    const cost = entry.actualUsd ?? entry.estimatedUsd;
    if (cost === null || cost === undefined) return null;
    if (!Number.isFinite(cost) || cost < 0) throw new RangeError("Invalid ledger cost");
    total += cost;
  }
  return total;
}
