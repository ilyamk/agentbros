import { appendFileSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithin, validateProjectId, CliErrorObject } from "../cli";
import { QualityTierSchema } from "../../types/pipeline";
import {
  ModelPreferencesSchema,
  ModelVerdictSchema,
  type ModelSlotsFile,
  type ModelVerdict,
} from "../../types/model-slots";
import { OperationDatabaseSchema } from "../jobs/types";
import type { CostEntry } from "../cli/cost-log";

export function modelProjectPath(project: string, root = process.cwd()): string {
  validateProjectId(project);
  const base = path.resolve(root, "public/projects"),
    directory = path.join(base, project);
  assertPathWithin(root, directory);
  assertPathWithin(base, directory);
  if (!existsSync(directory))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project not found: ${project}` });
  return directory;
}
function projectFile(directory: string, name: string): string {
  const file = path.join(directory, "pipeline", name);
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Project model file cannot be a symlink" });
  assertPathWithin(directory, file);
  return file;
}
export function readModelPreferences(project: string, root?: string) {
  const directory = modelProjectPath(project, root),
    file = projectFile(directory, "model-preferences.json");
  const preferences = existsSync(file)
    ? ModelPreferencesSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    : undefined;
  let qualityTier: z.infer<typeof QualityTierSchema> | undefined;
  for (const name of ["brief.json"]) {
    const source = projectFile(directory, name);
    if (!existsSync(source)) continue;
    const data = JSON.parse(readFileSync(source, "utf8")) as {
      qualityTier?: unknown;
      brief?: { qualityTier?: unknown };
    };
    const tier = data.qualityTier ?? data.brief?.qualityTier;
    if (tier !== undefined) {
      qualityTier = QualityTierSchema.parse(tier);
      break;
    }
  }
  return { preferences, qualityTier };
}
function lines(file: string): unknown[] {
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown)
    : [];
}
export function writeModelVerdict(
  project: string,
  input: Omit<ModelVerdict, "version" | "at">,
  options: { root?: string; now?: Date } = {},
): ModelVerdict {
  const directory = modelProjectPath(project, options.root),
    operations = projectFile(directory, "operations.json");
  if (!existsSync(operations))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "No operations file; cannot attach a verdict to an unknown operation",
    });
  const database = OperationDatabaseSchema.parse(JSON.parse(readFileSync(operations, "utf8")));
  if (
    database.projectId !== project ||
    !Object.hasOwn(database.jobs, input.operationId) ||
    database.jobs[input.operationId]?.operationId !== input.operationId
  )
    throw new CliErrorObject({ code: "VALIDATION", message: "Operation does not belong to this project" });
  const verdict = ModelVerdictSchema.parse({ ...input, version: 1, at: (options.now ?? new Date()).toISOString() });
  appendFileSync(projectFile(directory, "model-verdicts.jsonl"), `${JSON.stringify(verdict)}\n`);
  return verdict;
}
export function modelStats(file: ModelSlotsFile, options: { project?: string; all?: boolean; root?: string } = {}) {
  const root = options.root ?? process.cwd(),
    base = path.resolve(root, "public/projects");
  if (Boolean(options.project) === Boolean(options.all))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Supply --project or --all" });
  const projects = options.project
    ? [options.project]
    : existsSync(base)
      ? readdirSync(base, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
      : [];
  type Aggregate = {
    slot: string | null;
    provider: string;
    endpoint: string;
    generations: number;
    accepted: number;
    rejected: number;
    failures: number;
    knownCostGenerations: number;
    totalCostUsd: number;
  };
  const aggregates = new Map<string, Aggregate>();
  for (const project of projects) {
    const directory = modelProjectPath(project, root),
      operations = projectFile(directory, "operations.json");
    const database = existsSync(operations)
      ? OperationDatabaseSchema.parse(JSON.parse(readFileSync(operations, "utf8")))
      : undefined;
    if (database && database.projectId !== project)
      throw new CliErrorObject({ code: "VALIDATION", message: "Operation database project mismatch" });
    const verdicts = new Map<string, ModelVerdict>();
    for (const line of lines(projectFile(directory, "model-verdicts.jsonl"))) {
      const verdict = ModelVerdictSchema.parse(line);
      if (!verdicts.has(verdict.operationId)) verdicts.set(verdict.operationId, verdict);
    }
    const ledger = lines(projectFile(directory, "cost-ledger.jsonl")) as CostEntry[];
    const jobs = Object.values(database?.jobs ?? {});
    const records = jobs.map((job) => {
      const costs = ledger.filter((row) => row.operationId === job.operationId);
      const cost =
        job.receipt?.actualUsd ?? (costs.length ? (costs.at(-1)!.actualUsd ?? costs.at(-1)!.estimatedUsd) : null);
      return { operationId: job.operationId, provider: job.provider, endpoint: job.endpoint, status: job.state, cost };
    });
    for (const [index, row] of ledger.entries()) {
      if (row.operationId && jobs.some((job) => job.operationId === row.operationId)) continue;
      if (row.operationId && ledger.findIndex((other) => other.operationId === row.operationId) !== index) continue;
      const costs = row.operationId ? ledger.filter((other) => other.operationId === row.operationId) : [row];
      const latest = costs.at(-1)!;
      records.push({
        operationId: row.operationId ?? `legacy-ledger-${index}`,
        provider: row.provider ?? row.service,
        endpoint: row.model,
        status: "published",
        cost: latest.actualUsd ?? latest.estimatedUsd,
      });
    }
    for (const record of records) {
      if (!["published", "failed", "nsfw", "cancelled"].includes(record.status)) continue;
      if (record.cost != null && (!Number.isFinite(record.cost) || record.cost < 0))
        throw new CliErrorObject({ code: "VALIDATION", message: "Invalid recorded cost" });
      const slots = file.slots.filter((s) =>
        s.candidates.some((c) => c.provider === record.provider && c.endpoint === record.endpoint),
      );
      for (const slot of slots.length ? slots.map((s) => s.id) : [null]) {
        const id = JSON.stringify([slot, record.provider, record.endpoint]);
        const row = aggregates.get(id) ?? {
          slot,
          provider: record.provider,
          endpoint: record.endpoint,
          generations: 0,
          accepted: 0,
          rejected: 0,
          failures: 0,
          knownCostGenerations: 0,
          totalCostUsd: 0,
        };
        row.generations++;
        if (["failed", "nsfw", "cancelled"].includes(record.status)) row.failures++;
        const verdict = verdicts.get(record.operationId);
        if (verdict) row[verdict.verdict]++;
        if (record.cost != null) {
          row.totalCostUsd += record.cost;
          row.knownCostGenerations++;
        }
        aggregates.set(id, row);
      }
    }
  }
  return [...aggregates.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => ({
      ...row,
      unknownCostGenerations: row.generations - row.knownCostGenerations,
      firstPassAcceptance: row.accepted + row.rejected ? row.accepted / (row.accepted + row.rejected) : null,
      avgCostUsd: row.knownCostGenerations ? row.totalCostUsd / row.knownCostGenerations : null,
    }));
}
