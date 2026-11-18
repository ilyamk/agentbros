import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allModelIds } from "../apis/fal-models";
import { FAL_MUSIC_MODELS } from "../providers/fal-music";
import operationSnapshots from "../providers/schemas/fal-operations.json";
import { catalogDir as defaultCatalogDir, loadCatalog } from "./fal-catalog";
import { LEGACY_ENDPOINTS } from "./registry";

/**
 * fal:doctor as a library: which referenced endpoints are removed, deprecated or retiring,
 * judged against the catalogue index. Read-only.
 */
export type FalDoctorStatus = "active" | "deprecated" | "gone" | "retiring" | "not-in-catalog";
export type FalDoctorFinding = {
  endpoint: string;
  where: string[];
  status: FalDoctorStatus;
  retiresAt?: string;
  replacement?: string;
};
export type FalReference = { endpoint: string; where: string };

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ID = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/;

/** Endpoint IDs in a script's model table, read as text: those scripts run on import. */
export function scriptTableEndpoints(source: string, table: "generate-video" | "generate-lipsync"): string[] {
  if (table === "generate-video")
    return [...source.matchAll(/\b(?:t2vId|i2vId|r2vId):\s*["']([^"']+)["']/g)].map((match) => match[1]!);
  const block = /MODEL_ENDPOINTS[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/:\s*["']([^"']+)["']/g)].map((match) => match[1]!);
}

/** Endpoints the harness itself names: legacy aliases, legacy tables, video and lip-sync scripts, the music allow-list. */
export function staticReferences(root = REPO_ROOT): FalReference[] {
  const refs: FalReference[] = [];
  for (const [alias, operations] of Object.entries(LEGACY_ENDPOINTS)) {
    for (const endpoint of Object.values(operations))
      if (endpoint) refs.push({ endpoint, where: `src/lib/models/registry.ts LEGACY_ENDPOINTS ${alias}` });
  }
  for (const endpoint of allModelIds()) refs.push({ endpoint, where: "src/lib/apis/fal-models.ts" });
  for (const [file, table] of [
    ["scripts/generate-video.ts", "generate-video"],
    ["scripts/generate-lipsync.ts", "generate-lipsync"],
  ] as const) {
    const full = path.join(root, file);
    if (existsSync(full))
      for (const endpoint of scriptTableEndpoints(readFileSync(full, "utf8"), table))
        refs.push({ endpoint, where: file });
  }
  for (const endpoint of Object.keys(FAL_MUSIC_MODELS))
    refs.push({ endpoint, where: "src/lib/providers/fal-music.ts FAL_MUSIC_MODELS" });
  return refs;
}

type Row = { endpoint: string; family: string; variant: string; operation: string; region: string; transport: string };
/** The endpoint a legacy family request names, from the tracked snapshot routing. */
export function legacyRequestEndpoint(request: Record<string, unknown>): string | undefined {
  const region = typeof request.region === "string" ? request.region : "global";
  const transport = typeof request.transport === "string" ? request.transport : undefined;
  const candidates = (operationSnapshots as Row[]).filter(
    (row) =>
      row.family === request.family &&
      row.operation === request.operation &&
      row.region === region &&
      (request.variant === undefined || row.variant === request.variant) &&
      (transport === undefined ? row.transport !== "stream" : row.transport === transport),
  );
  return candidates.length === 1 ? candidates[0]!.endpoint : undefined;
}

const readJson = (file: string): unknown => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** fal jobs in operations.json and fal-model operation requests in the asset plan. */
export function projectReferences(files: { operations?: string; assetPlan?: string; label?: string }): {
  refs: FalReference[];
  unresolved: string[];
} {
  const refs: FalReference[] = [];
  const unresolved: string[] = [];
  const label = files.label ?? "project";
  const operations = files.operations ? readJson(files.operations) : undefined;
  if (isRecord(operations) && isRecord(operations.jobs)) {
    for (const [operationId, job] of Object.entries(operations.jobs)) {
      if (
        isRecord(job) &&
        typeof job.endpoint === "string" &&
        /^fal/i.test(String(job.provider ?? "")) &&
        ID.test(job.endpoint)
      )
        refs.push({ endpoint: job.endpoint, where: `${label} operations.json ${operationId}` });
    }
  }
  const plan = files.assetPlan ? readJson(files.assetPlan) : undefined;
  const assets = isRecord(plan) && Array.isArray(plan.assets) ? plan.assets : [];
  for (const asset of assets) {
    if (!isRecord(asset) || !isRecord(asset.metadata) || !isRecord(asset.metadata.operationRequest)) continue;
    const request = asset.metadata.operationRequest;
    const where = `${label} asset-plan.json ${String(asset.id ?? "?")}`;
    const endpoint = typeof request.endpoint === "string" ? request.endpoint : legacyRequestEndpoint(request);
    if (endpoint && ID.test(endpoint)) refs.push({ endpoint, where });
    else unresolved.push(where);
  }
  return { refs, unresolved };
}

/** One finding per endpoint, its sources merged; the problem statuses first. */
export function diagnose(refs: FalReference[], catalogDir = defaultCatalogDir()): FalDoctorFinding[] {
  const catalog = loadCatalog(catalogDir);
  const byEndpoint = new Map<string, Set<string>>();
  for (const ref of refs) byEndpoint.set(ref.endpoint, (byEndpoint.get(ref.endpoint) ?? new Set()).add(ref.where));
  const order: Record<FalDoctorStatus, number> = {
    gone: 0,
    retiring: 1,
    deprecated: 2,
    "not-in-catalog": 3,
    active: 4,
  };
  return [...byEndpoint]
    .map(([endpoint, where]): FalDoctorFinding => {
      const entry = catalog.get(endpoint);
      const status: FalDoctorStatus = !entry
        ? "not-in-catalog"
        : entry.status === "gone"
          ? "gone"
          : entry.status === "deprecated"
            ? "deprecated"
            : entry.retiresAt
              ? "retiring"
              : "active";
      return {
        endpoint,
        where: [...where].sort(),
        status,
        ...(entry?.retiresAt ? { retiresAt: String(entry.retiresAt) } : {}),
        ...(entry?.replacement ? { replacement: entry.replacement } : {}),
      };
    })
    .sort((a, b) => order[a.status] - order[b.status] || a.endpoint.localeCompare(b.endpoint));
}

export type FalDoctorReport = {
  catalogEntries: number;
  findings: FalDoctorFinding[];
  counts: Record<FalDoctorStatus, number>;
  unresolved: string[];
};
export function runFalDoctor(
  options: {
    catalogDir?: string;
    includeStatic?: boolean;
    root?: string;
    project?: { operations?: string; assetPlan?: string; label?: string };
  } = {},
): FalDoctorReport {
  const refs = options.includeStatic === false ? [] : staticReferences(options.root);
  const project = options.project ? projectReferences(options.project) : { refs: [], unresolved: [] };
  const findings = diagnose([...refs, ...project.refs], options.catalogDir);
  const counts: Record<FalDoctorStatus, number> = {
    active: 0,
    deprecated: 0,
    gone: 0,
    retiring: 0,
    "not-in-catalog": 0,
  };
  for (const finding of findings) counts[finding.status]++;
  return {
    catalogEntries: loadCatalog(options.catalogDir ?? defaultCatalogDir()).size,
    findings,
    counts,
    unresolved: project.unresolved,
  };
}
