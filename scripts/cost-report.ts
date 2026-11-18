#!/usr/bin/env tsx
/**
 * Cost reporter — aggregates the per-project cost ledger into a markdown
 * summary suitable for the user-facing pipeline `Done` panel.
 *
 * Reads:
 *   public/projects/{id}/pipeline/cost-ledger.jsonl
 *
 * Writes:
 *   public/projects/{id}/pipeline/cost-report.md
 *
 * Emits the canonical script JSON envelope on stdout. Total USD and per-stage
 * breakdown are surfaced in metadata so an orchestrator can budget-gate.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/cost-report.ts --project <id>
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  parseArgs,
  runScript,
  emitProgress,
  CliErrorObject,
  validateProjectId,
  assertPathWithin,
} from "../src/lib/cli/index.js";
import { readLedger, totalUsd } from "../src/lib/cli/cost-log.js";
import { pipelineDir } from "../src/lib/pipeline/paths.js";
import { OperationStore } from "../src/lib/jobs/store.js";

const SPECS = [
  {
    name: "project",
    short: "p",
    required: true as const,
    description: "Project ID under public/projects/",
  },
  {
    name: "json-only",
    type: "boolean" as const,
    default: false,
    description: "Skip writing cost-report.md; just emit the JSON envelope",
  },
] as const;

interface Aggregate {
  totalUsd: number | null;
  unknownEntries: number;
  knownSubtotalUsd: number;
  totalEntries: number;
  byStage: Record<string, number | null>;
  byService: Record<string, number | null>;
  byModel: Record<string, { units: number; usd: number | null; count: number }>;
}

function aggregate(entries: ReturnType<typeof readLedger>): Aggregate {
  const out: Aggregate = {
    totalUsd: totalUsd(entries),
    totalEntries: entries.length,
    unknownEntries: entries.filter((e) => (e.actualUsd ?? e.estimatedUsd) == null).length,
    knownSubtotalUsd: entries.reduce((sum, e) => sum + (e.actualUsd ?? e.estimatedUsd ?? 0), 0),
    byStage: {},
    byService: {},
    byModel: {},
  };
  for (const e of entries) {
    const cost = e.actualUsd ?? e.estimatedUsd;
    const stage = e.stage ?? "unknown";
    out.byStage[stage] = cost == null || out.byStage[stage] === null ? null : (out.byStage[stage] ?? 0) + cost;
    out.byService[e.service] =
      cost == null || out.byService[e.service] === null ? null : (out.byService[e.service] ?? 0) + cost;
    if (!out.byModel[e.model]) {
      out.byModel[e.model] = { units: 0, usd: 0, count: 0 };
    }
    out.byModel[e.model].units += e.units ?? 0;
    out.byModel[e.model].usd =
      cost == null || out.byModel[e.model].usd === null ? null : out.byModel[e.model].usd! + cost;
    out.byModel[e.model].count += 1;
  }
  return out;
}

function fmtUsd(v: number | null): string {
  if (v === null) return "Unknown";
  return `$${v.toFixed(4).replace(/\.?0+$/, "")}`;
}

type Pending = ReturnType<OperationStore["pendingReconciliation"]>;

function buildMarkdown(
  projectId: string,
  agg: Aggregate,
  raw: ReturnType<typeof readLedger>,
  pending: Pending,
): string {
  const lines: string[] = [];
  lines.push(`# Cost report — ${projectId}\n`);
  lines.push(`**Combined recorded actual/estimated total:** ${fmtUsd(agg.totalUsd)}  `);
  lines.push(`**Known subtotal:** ${fmtUsd(agg.knownSubtotalUsd)}; **Unpriced entries:** ${agg.unknownEntries}  `);
  lines.push(`**Ledger entries:** ${agg.totalEntries}\n`);

  // Durable paid jobs (fal and others) write no ledger rows: a submitted job without a receipt is reserved, not spent.
  if (pending.length) {
    lines.push("## Reserved, awaiting a billing receipt\n");
    lines.push(
      `${fmtUsd(pending.reduce((sum, job) => sum + job.reservedUsd, 0))} reserved and unreconciled; not counted in the total above. Reconcile each with the provider's receipt:\n`,
    );
    for (const job of pending)
      lines.push(
        `- \`${job.operationId}\` (\`${job.endpoint}\`): ${fmtUsd(job.reservedUsd)} reserved. \`pnpm budget --project ${projectId} --operation-id ${job.operationId} --receipt <receipt.json>\``,
      );
    lines.push("");
  }

  if (agg.totalEntries === 0) {
    lines.push(
      pending.length
        ? "_No cost-ledger rows; see the reserved jobs above._\n"
        : "_No paid API calls recorded for this project._\n",
    );
    return lines.join("\n");
  }

  lines.push("## By stage\n");
  lines.push("| Stage | Actual/estimated |");
  lines.push("|---|---|");
  for (const [stage, usd] of Object.entries(agg.byStage).sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))) {
    lines.push(`| ${stage} | ${fmtUsd(usd)} |`);
  }
  lines.push("");

  lines.push("## By service\n");
  lines.push("| Service | Actual/estimated |");
  lines.push("|---|---|");
  for (const [svc, usd] of Object.entries(agg.byService).sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))) {
    lines.push(`| ${svc} | ${fmtUsd(usd)} |`);
  }
  lines.push("");

  lines.push("## By model\n");
  lines.push("| Model | Calls | Units | Actual/estimated |");
  lines.push("|---|---|---|---|");
  const sortedModels = Object.entries(agg.byModel).sort((a, b) => (b[1].usd ?? -1) - (a[1].usd ?? -1));
  for (const [model, data] of sortedModels) {
    lines.push(`| \`${model}\` | ${data.count} | ${data.units.toFixed(1)} | ${fmtUsd(data.usd)} |`);
  }
  lines.push("");

  lines.push("## Detailed ledger (most recent first)\n");
  lines.push("| Time | Stage | Service / model | Asset | Units | Estimated | Actual |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const e of [...raw].reverse()) {
    const cost = e.actualUsd ?? e.estimatedUsd;
    const t = e.ts.split("T")[1]?.split(".")[0] ?? e.ts;
    lines.push(
      `| ${t} | ${e.stage ?? "-"} | ${e.service} / \`${e.model}\` | ${e.assetId ?? "-"} | ${e.units}${e.unitName} | ${fmtUsd(e.estimatedUsd)} | ${e.actualUsd != null ? fmtUsd(e.actualUsd) : "-"} |`,
    );
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push(
    "_Estimates use list-price heuristics from `src/lib/pricing.ts`. Actual provider invoices may differ — fal.ai endpoints flagged `disclosed: false` are best-effort estimates only._",
  );
  return lines.join("\n");
}

runScript(async () => {
  const args = parseArgs(SPECS);
  const projectId = args.project as string;
  const jsonOnly = args["json-only"] as boolean;

  validateProjectId(projectId);
  const dir = pipelineDir(projectId);
  assertPathWithin(path.resolve("public/projects"), path.resolve(dir));
  if (!existsSync(dir)) {
    throw new CliErrorObject({
      code: "PROJECT_NOT_FOUND",
      message: `Pipeline dir not found: ${dir}`,
    });
  }

  emitProgress(`Reading ledger for ${projectId}…`);
  const entries = readLedger(projectId);
  const agg = aggregate(entries);
  const pending = new OperationStore(projectId).pendingReconciliation();
  const reservedMicros = pending.reduce((sum, job) => sum + Math.round(job.reservedUsd * 1_000_000), 0);

  let outPath: string | undefined;
  if (!jsonOnly) {
    outPath = path.join(dir, "cost-report.md");
    writeFileSync(outPath, buildMarkdown(projectId, agg, entries, pending), { encoding: "utf-8" });
    emitProgress(`Wrote ${outPath}`);
  }

  return {
    outputs: outPath ? [outPath] : [],
    metadata: {
      projectId,
      totalUsd: agg.totalUsd,
      totalEntries: agg.totalEntries,
      unknownEntries: agg.unknownEntries,
      knownSubtotalUsd: agg.knownSubtotalUsd,
      byStage: agg.byStage,
      byService: agg.byService,
      byModel: agg.byModel,
      // Reserved, not spent: durable jobs with a paid attempt and no receipt or release (outside totalUsd).
      pendingReconciliation: pending,
      reservedUnreconciledUsd: reservedMicros / 1_000_000,
    },
  };
});
