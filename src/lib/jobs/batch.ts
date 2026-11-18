import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FalAnyRequest } from "../../types/generation";
import { FalBatchSpecSchema, type FalBatchSpec, type OutputKind } from "../../types/fal-catalog";
import { assertPathWithin, CliErrorObject, requireProject } from "../cli";
import { verifyFalPublication } from "./model-artifacts";
import { findCatalogEntry } from "../models/fal-catalog";
import { pipelineDir, projectDir } from "../pipeline/paths";
import { generationInputHash } from "./runner";
import { canonicalInputIdentity } from "./identity";
import { OperationStore } from "./store";
import {
  BudgetPolicySchema,
  OperationInputSchema,
  PriceQuoteSchema,
  type GenerationJob,
  type PriceQuote,
} from "./types";

export interface BatchOperation {
  operationId: string;
  assetId: string;
  output: string;
  requestFile: string;
  request: {
    endpoint: string;
    input: Record<string, unknown>;
    context?: z.output<typeof FalBatchSpecSchema>["context"];
  };
}
export interface BatchPlan {
  spec: z.output<typeof FalBatchSpecSchema>;
  operations: BatchOperation[];
}
export interface BatchPlanOptions {
  projectId: string;
  revision?: string;
  write?: boolean;
  scopeRoot?: string;
}
const fail = (message: string): never => {
  throw new CliErrorObject({ code: "VALIDATION", message });
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Objects merge recursively; arrays and scalars replace, including explicit null. */
export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) fail("Unsafe input patch key.");
    Object.defineProperty(result, key, {
      value: object(value)
        ? deepMerge(object(result[key]) ? (result[key] as Record<string, unknown>) : {}, value)
        : structuredClone(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}
const extensions: Record<OutputKind, string> = {
  image: "png",
  video: "mp4",
  audio: "wav",
  model3d: "glb",
  text: "json",
  json: "json",
  weights: "safetensors",
  file: "bin",
};
function immutable(file: string, value: Record<string, unknown>, write: boolean): void {
  if (existsSync(file)) {
    if (canonicalInputIdentity(JSON.parse(readFileSync(file, "utf8"))).sha256 !== canonicalInputIdentity(value).sha256)
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: `Immutable batch content changed: ${file}. Use --revision for a new batch ID.`,
      });
  } else if (write) {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      immutable(file, value, false);
    }
  }
}
/** Expand and optionally materialise immutable endpoint request files in the project's pipeline. */
export function planBatch(input: FalBatchSpec, options: BatchPlanOptions): BatchPlan {
  const parsed = FalBatchSpecSchema.parse(input);
  const spec = FalBatchSpecSchema.parse({
    ...parsed,
    batchId: options.revision ? `${parsed.batchId}.${options.revision}` : parsed.batchId,
  });
  const root = path.resolve(projectDir(options.projectId));
  const directory = path.resolve(pipelineDir(options.projectId), "batches", spec.batchId);
  assertPathWithin(root, directory);
  const manifest = path.join(directory, "batch.json");
  assertPathWithin(root, manifest);
  const frozen = existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, "utf8")) as { operations?: { output?: string }[] })
    : undefined;
  const kind = findCatalogEntry(spec.endpoint)?.outputs.kinds[0];
  const extension = frozen?.operations?.[0]?.output
    ? path.extname(frozen.operations[0].output).slice(1)
    : kind
      ? extensions[kind]
      : undefined;
  if (!extension || !Object.values(extensions).includes(extension))
    fail(`No primary catalogue output kind or frozen batch output for ${spec.endpoint}.`);
  const outputDir = path.resolve(spec.outputDir);
  if (options.scopeRoot) assertPathWithin(options.scopeRoot, outputDir);
  const operations = spec.variations.map((variation) => {
    const operationId = OperationInputSchema.shape.operationId.parse(`${spec.batchId}.${variation.id}`);
    const requestFile = path.join(directory, `${variation.id}.request.json`);
    const output = path.join(outputDir, `${variation.id}.${extension}`);
    assertPathWithin(directory, requestFile);
    assertPathWithin(outputDir, output);
    return {
      operationId,
      assetId: `${spec.assetIdPrefix}-${variation.id}`,
      output,
      requestFile,
      request: {
        endpoint: spec.endpoint,
        input: deepMerge(spec.baseInput, variation.inputPatch),
        ...(spec.context ? { context: spec.context } : {}),
      },
    };
  });
  // Preflight every existing file before writing any missing file.
  immutable(manifest, { spec, operations }, false);
  for (const operation of operations) immutable(operation.requestFile, operation.request, false);
  if (options.write !== false) {
    immutable(manifest, { spec, operations }, true);
    for (const operation of operations) immutable(operation.requestFile, operation.request, true);
  }
  return { spec, operations };
}
export interface BatchExecution {
  operation: BatchOperation;
  projectId: string;
  dryRun: boolean;
  maxCostUsd?: number;
  stage?: string;
  materialised: boolean;
  request?: FalAnyRequest;
}
export type BatchExecutor = (
  execution: BatchExecution,
) => Promise<{ ok: boolean; metadata?: Record<string, unknown>; error?: string; message?: string }>;
const codeRoot = path.resolve(import.meta.dirname, "../../..");
/** The only production executor: literal argv, one envelope, no retry of a submit. */
export const generateModelExecutor: BatchExecutor = async (execution) => {
  const { operation, projectId, dryRun, maxCostUsd, stage, materialised } = execution;
  const argv = [
    "--import",
    path.join(codeRoot, "node_modules/tsx/dist/loader.mjs"),
    path.join(codeRoot, "scripts/generate-model.ts"),
    "--request",
    materialised ? operation.requestFile : "-",
    "--project",
    projectId,
    "--output",
    operation.output,
    "--operation-id",
    operation.operationId,
    "--asset-id",
    operation.assetId,
  ];
  if (dryRun) argv.push("--dry-run");
  if (maxCostUsd !== undefined) argv.push("--max-cost-usd", String(maxCostUsd));
  if (stage) argv.push("--stage", stage);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdin.on("error", () => {
      /* A child can reject arguments before reading stdin. */
    });
    child.stdin.end(materialised ? undefined : JSON.stringify(execution.request ?? operation.request));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const lines = Buffer.concat(chunks).toString("utf8").trimEnd().split(/\r?\n/);
        if (lines.length !== 1 || bytes > 64 * 1024 * 1024)
          fail("generate:model must return one bounded JSON envelope.");
        const result = z
          .object({
            ok: z.boolean(),
            metadata: z.record(z.string(), z.unknown()).optional(),
            error: z.string().optional(),
            message: z.string().optional(),
          })
          .parse(JSON.parse(lines[0]!));
        if (code !== (result.ok ? 0 : 1)) fail("generate:model exit status disagrees with its envelope.");
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
};

/** Same policy and accounting authority as budget; an unconfigured project previews the executor's initial policy. */
export function readBatchBudget(projectId: string, store = new OperationStore(projectId)) {
  if (existsSync(store.file)) {
    const snapshot = store.snapshot();
    return { policy: snapshot.policy, summary: store.summary(), jobs: snapshot.jobs, configured: true };
  }
  const briefFile = path.join(pipelineDir(projectId), "brief.json");
  const brief = existsSync(briefFile) ? (JSON.parse(readFileSync(briefFile, "utf8")) as { budgetUsd?: unknown }) : {};
  const ceiling =
    typeof brief.budgetUsd === "number" && Number.isFinite(brief.budgetUsd) && brief.budgetUsd >= 0
      ? Math.min(10, brief.budgetUsd)
      : 10;
  return {
    policy: BudgetPolicySchema.parse({ ceilingUsd: ceiling, maxJobUsd: ceiling }),
    summary: { availableUsd: ceiling },
    jobs: {} as Record<string, GenerationJob>,
    configured: false,
  };
}
export type BatchVerdict = "fits" | "exceeds-ceiling" | "op-exceeds-max-job" | "unknown-price-needs-bound" | "invalid";
export interface BatchOptions extends BatchPlanOptions {
  executor?: BatchExecutor;
  execute?: boolean;
  maxTotalUsd?: number;
  store?: OperationStore;
}
const micros = (usd: number) => Math.ceil(usd * 1e6 - 1e-7);
const floorMicros = (usd: number) => Math.floor(usd * 1e6 + 1e-7);
export async function runBatch(input: FalBatchSpec, options: BatchOptions) {
  requireProject(options.projectId);
  const plan = planBatch(input, options);
  const budget = readBatchBudget(options.projectId, options.store);
  const executor = options.executor ?? generateModelExecutor;
  const errors: { operationId: string; message: string }[] = [],
    warnings: string[] = [];
  const operations: {
    operation: BatchOperation;
    quote: PriceQuote | null;
    quoteInput: unknown;
    inputHash?: string;
    evidenceKind?: string;
    existingState?: string;
  }[] = [];
  let low = 0,
    expected = 0,
    high = 0,
    incremental = 0,
    unknownCount = 0,
    maxJobExceeded = false,
    attemptExceeded = false,
    needsBound = false;
  const jobs = Object.values(budget.jobs);
  for (const operation of plan.operations) {
    try {
      const existing = Object.hasOwn(budget.jobs, operation.operationId)
        ? budget.jobs[operation.operationId]
        : undefined;
      const bindingFile = operation.requestFile.replace(/\.request\.json$/, ".binding.json");
      assertPathWithin(path.resolve(projectDir(options.projectId)), bindingFile);
      const requestHash = generationInputHash(operation.request);
      const canonicalSchema = z.object({ version: z.literal(2), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
      const binding = existsSync(bindingFile)
        ? z
            .object({
              requestHash: z.string(),
              inputHash: z.string(),
              canonicalRequest: canonicalSchema.optional(),
              canonicalInput: canonicalSchema.optional(),
            })
            .strict()
            .parse(JSON.parse(readFileSync(bindingFile, "utf8")))
        : undefined;
      if (
        binding &&
        (binding.canonicalRequest
          ? binding.canonicalRequest.sha256 !== canonicalInputIdentity(operation.request).sha256
          : binding.requestHash !== requestHash)
      )
        fail("Batch request differs from its historical identity receipt.");
      const canonicalMatch = existing?.canonicalInput && binding?.canonicalInput;
      if (canonicalMatch && existing.canonicalInput!.sha256 !== binding.canonicalInput!.sha256)
        fail("Batch provider input differs from its canonical identity receipt.");
      const result: Awaited<ReturnType<BatchExecutor>> = existing
        ? {
            ok: true,
            metadata: {
              quote: existing.quote,
              inputHash: canonicalMatch
                ? existing.inputHash
                : (binding?.inputHash ?? generationInputHash(operation.request.input)),
            } as Record<string, unknown>,
          }
        : await executor({
            operation,
            projectId: options.projectId,
            dryRun: true,
            maxCostUsd: plan.spec.maxCostUsdPerOp,
            stage: plan.spec.stage,
            materialised: options.write !== false,
          });
      if (!result.ok) fail(result.message ?? result.error ?? "Dry-run failed.");
      const metadata = result.metadata ?? {};
      const inputHash = typeof metadata.inputHash === "string" ? metadata.inputHash : undefined;
      const providerInput =
        object(metadata.plan) && object(metadata.plan.input)
          ? metadata.plan.input
          : inputHash === generationInputHash(operation.request.input)
            ? operation.request.input
            : undefined;
      if (
        existing &&
        (inputHash !== existing.inputHash ||
          existing.provider !== "fal.ai" ||
          existing.repair ||
          existing.endpoint !== plan.spec.endpoint ||
          existing.assetId !== operation.assetId ||
          existing.stage !== (plan.spec.stage ?? "assets") ||
          existing.publication?.output !== operation.output ||
          existing.publication.model !== plan.spec.endpoint)
      )
        fail(
          "Batch operation identity differs from the stored job; transformed historical inputs require an identity receipt.",
        );
      if (!existing && inputHash && options.write !== false)
        immutable(
          bindingFile,
          binding ?? {
            requestHash,
            inputHash,
            canonicalRequest: canonicalInputIdentity(operation.request),
            ...(providerInput ? { canonicalInput: canonicalInputIdentity(providerInput) } : {}),
          },
          true,
        );
      if (metadata.executable === false)
        errors.push({ operationId: operation.operationId, message: "Endpoint plan is not executable." });
      let quoted: PriceQuote | null =
        existing?.quote ?? (metadata.quote ? PriceQuoteSchema.parse(metadata.quote) : null);
      if (!quoted) {
        unknownCount++;
        needsBound ||= plan.spec.maxCostUsdPerOp === undefined;
        if (plan.spec.maxCostUsdPerOp !== undefined)
          quoted = {
            currency: "USD",
            lowUsd: 0,
            expectedUsd: plan.spec.maxCostUsdPerOp,
            highUsd: plan.spec.maxCostUsdPerOp,
            bounded: true,
            source: "Explicit batch per-operation planning bound",
            asOf: new Date().toISOString(),
            confidence: "user-bound",
          };
      } else if (quoted.confidence === "user-bound") unknownCount++;
      if (quoted) {
        low += micros(quoted.lowUsd);
        expected += micros(quoted.expectedUsd);
        high += micros(quoted.highUsd);
        if (!existing) {
          incremental += micros(quoted.highUsd);
          if (micros(quoted.highUsd) > floorMicros(budget.policy.maxJobUsd)) maxJobExceeded = true;
        }
        if (plan.spec.maxCostUsdPerOp !== undefined && quoted.highUsd > plan.spec.maxCostUsdPerOp)
          fail("Quote exceeds maxCostUsdPerOp.");
      }
      if (!existing) {
        const peers = jobs.filter((job) => job.assetId === operation.assetId);
        const attempts = peers.reduce(
          (sum, job) => sum + job.paidAttempts + (job.state === "reserved" && !job.release && !job.receipt ? 1 : 0),
          0,
        );
        if (
          attempts >= budget.policy.maxPaidAttemptsPerAsset ||
          peers.some((job) => ["unknown", "submitting"].includes(job.state))
        ) {
          attemptExceeded = true;
          errors.push({
            operationId: operation.operationId,
            message: "Paid attempt limit or ambiguous submission blocks this asset.",
          });
        }
      }
      const childWarnings =
        object(metadata.plan) && Array.isArray(metadata.plan.warnings) ? metadata.plan.warnings : [];
      warnings.push(...childWarnings.filter((value): value is string => typeof value === "string"));
      operations.push({
        operation,
        quote: quoted,
        quoteInput: metadata.quoteInput ?? { request: operation.request, inputHash, plan: metadata.plan },
        inputHash,
        evidenceKind: quoted?.pricingEvidence?.kind,
        existingState: existing?.state,
      });
    } catch (error) {
      errors.push({
        operationId: operation.operationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const productionUsed = jobs
    .filter((job) => !job.repair)
    .reduce(
      (sum, job) =>
        sum +
        job.reservedMicros +
        (job.receipt
          ? micros(job.receipt.actualUsd) -
            job.refunds.reduce((total, refund) => total + floorMicros(refund.refundUsd), 0)
          : 0),
      0,
    );
  const cap = floorMicros(budget.policy.ceilingUsd);
  const productionAvailable = Math.max(0, cap - Math.floor(cap * budget.policy.repairReserveFraction) - productionUsed);
  const available = Math.min(floorMicros(budget.summary.availableUsd), productionAvailable);
  const verdict: BatchVerdict = needsBound
    ? "unknown-price-needs-bound"
    : maxJobExceeded
      ? "op-exceeds-max-job"
      : incremental > available
        ? "exceeds-ceiling"
        : errors.length || attemptExceeded
          ? "invalid"
          : "fits";
  if (!budget.configured) warnings.push("Budget is unconfigured; preview uses the executor initial policy.");
  if (unknownCount) warnings.push("Unknown prices use explicit planning bounds only; provider billing is not capped.");
  const forecast = {
    batchId: plan.spec.batchId,
    quote: { low: low / 1e6, expected: expected / 1e6, high: high / 1e6, bounded: !needsBound && errors.length === 0 },
    unknownCount,
    errors,
    warnings: [...new Set(warnings)],
    verdict,
    policy: budget.policy,
    remainingCeilingUsd: budget.summary.availableUsd,
    productionHeadroomUsd: available / 1e6,
    incrementalHighUsd: incremental / 1e6,
    operations,
  };
  if (!options.execute) return { ...forecast, results: [] };
  if (verdict !== "fits") fail(`Batch cannot execute: ${verdict}.`);
  if (options.maxTotalUsd === undefined || !Number.isFinite(options.maxTotalUsd) || options.maxTotalUsd < high / 1e6)
    fail("--execute requires explicit --max-total-usd at least the aggregate high bound.");
  const results: { operationId: string; skipped?: boolean; result?: Awaited<ReturnType<BatchExecutor>> }[] = [];
  for (const row of operations) {
    if (row.existingState === "published") {
      verifyFalPublication(budget.jobs[row.operation.operationId]!.result?.published, {
        projectId: options.projectId,
        scopeRoot: options.scopeRoot,
        operationId: row.operation.operationId,
      });
      results.push({ operationId: row.operation.operationId, skipped: true });
      continue;
    }
    try {
      const result = await executor({
        operation: row.operation,
        projectId: options.projectId,
        dryRun: false,
        maxCostUsd: row.quote
          ? Math.min(row.quote.highUsd, plan.spec.maxCostUsdPerOp ?? row.quote.highUsd)
          : plan.spec.maxCostUsdPerOp,
        stage: plan.spec.stage,
        materialised: options.write !== false,
      });
      results.push({ operationId: row.operation.operationId, result });
      if (!result.ok || ["failed", "cancelled", "unknown"].includes(String(result.metadata?.state)))
        return { ...forecast, results, failedOperationId: row.operation.operationId };
    } catch (error) {
      return {
        ...forecast,
        results,
        failedOperationId: row.operation.operationId,
        executionError: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ...forecast, results };
}
export function batchStatus(spec: FalBatchSpec, options: BatchPlanOptions & { store?: OperationStore }) {
  const parsed = FalBatchSpecSchema.parse(spec);
  const batchId = FalBatchSpecSchema.shape.batchId.parse(
    options.revision ? `${parsed.batchId}.${options.revision}` : parsed.batchId,
  );
  const { jobs } = readBatchBudget(options.projectId, options.store);
  return parsed.variations.map((variation) => {
    const operationId = OperationInputSchema.shape.operationId.parse(`${batchId}.${variation.id}`);
    return { operationId, job: Object.hasOwn(jobs, operationId) ? jobs[operationId] : null };
  });
}

/** Platform estimate request shape from the fal integration contract; quantities are provider units, not bounds. */
export function providerEstimateBody(endpoints: Record<string, number>) {
  for (const quantity of Object.values(endpoints))
    if (!Number.isFinite(quantity) || quantity <= 0) fail("Provider unit quantities must be positive and finite.");
  return {
    estimate_type: "unit_price" as const,
    endpoints: Object.fromEntries(Object.entries(endpoints).map(([id, unit_quantity]) => [id, { unit_quantity }])),
  };
}
export async function fetchProviderEstimate(
  endpoints: Record<string, number>,
  options: { fetch?: typeof fetch; key?: string } = {},
) {
  const key = options.key ?? process.env.FAL_KEY;
  if (!key) throw new CliErrorObject({ code: "MISSING_API_KEY", message: "--provider-estimate requires FAL_KEY." });
  const request = providerEstimateBody(endpoints);
  const response = await (options.fetch ?? fetch)("https://api.fal.ai/v1/models/pricing/estimate", {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new CliErrorObject({ code: "NETWORK", message: `Provider estimate failed: HTTP ${response.status}` });
  return {
    kind: "providerEstimate" as const,
    source: "https://api.fal.ai/v1/models/pricing/estimate",
    observedAt: new Date().toISOString(),
    request,
    response: (await response.json()) as unknown,
    reservationBound: false,
  };
}
