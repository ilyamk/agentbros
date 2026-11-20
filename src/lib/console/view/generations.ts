/**
 * Generations (2026-11-20): the paid model jobs of the job store (`pipeline/operations.json`) as first-class canvas
 * content, plus the latest model preparation (`pipeline/model-preparations/<id>/`). Read-only, like every section: the
 * job store stays the source of truth, and a job's result is shown only when it is published and its file exists.
 *
 * Never projected: uploaded or signed provider URLs (`image_urls`, `video_url`, `uploads`, `providerUrls`, `result`).
 * From a request body only `prompt` and `resolution` are kept.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import {
  isSafeRelativePath,
  type AssetSummary,
  type Generation,
  type Generations,
  type MediaRef,
  type ModelPreparationView,
} from "../../../types/console";
import type { GenerationJob } from "../../jobs/types";
import { locate, mediaKind, readJsonFile, statOf, text, type ProjectPaths } from "./files";
import { jobCostUsd, openStore } from "./money";

const MAX_JOBS = 200;
const MAX_PROMPT = 8000;
const SHOWN = new Set(["validated", "published"]);
const TERMINAL = new Set(["validated", "published", "failed", "cancelled"]);

const iso = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

/** `prompt` and `resolution` of a JSON request body; nothing else of it. */
function requestFields(body: unknown): { prompt?: string; resolution?: string } {
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const prompt =
    typeof record.prompt === "string" && record.prompt.trim() ? record.prompt.slice(0, MAX_PROMPT) : undefined;
  const resolution = text(record.resolution, 32);
  return { ...(prompt ? { prompt } : {}), ...(resolution ? { resolution } : {}) };
}

/** A project file as a MediaRef when it exists and the media route would serve it. */
export function mediaRef(paths: ProjectPaths, file: string, label?: string): MediaRef | undefined {
  const where = locate(paths, file);
  if (!where || where.root !== "project" || !isSafeRelativePath(where.path)) return undefined;
  const kind = mediaKind(where.path);
  if (!kind || kind === "document") return undefined;
  if (!statOf(path.join(paths.projectDir, where.path))?.isFile()) return undefined;
  return { path: where.path, kind, ...(label ? { label: label.slice(0, 160) } : {}) };
}

function errorOf(job: GenerationJob): string | undefined {
  if (job.error) return text(job.error, 2000);
  if (job.state !== "failed" && job.state !== "cancelled" && job.state !== "unknown") return undefined;
  const note = [...job.history].reverse().find((entry) => entry.note)?.note;
  return text(note, 2000);
}

/** Registry asset id → the user's original filename, for references stored under a hash name. */
function originalNames(paths: ProjectPaths): Map<string, string> {
  const names = new Map<string, string>();
  const raw = readJsonFile(path.join(paths.projectDir, "pipeline", "asset-registry.json")) as
    { assets?: unknown } | undefined;
  for (const asset of Array.isArray(raw?.assets) ? raw.assets : []) {
    const name = text(asset?.provenance?.originalFilename, 160);
    if (typeof asset?.id === "string" && name && !name.startsWith(".")) names.set(asset.id, name);
  }
  return names;
}

function generationOf(
  job: GenerationJob,
  paths: ProjectPaths,
  assets: Map<string, AssetSummary>,
  names: Map<string, string> = new Map(),
): Generation {
  const at = (states: string[]) => job.history.find((entry) => states.includes(entry.state))?.at;
  const finished = TERMINAL.has(job.state)
    ? [...job.history].reverse().find((entry) => entry.state === job.state)?.at
    : undefined;
  const planned = job.publication?.output ? locate(paths, job.publication.output) : undefined;
  const outputPath = planned?.root === "project" && isSafeRelativePath(planned.path) ? planned.path : undefined;
  const output =
    outputPath && SHOWN.has(job.state)
      ? mediaRef(paths, path.join(paths.projectDir, outputPath), outputPath.split("/").at(-1))
      : undefined;
  const fields = requestFields(job.requestBody ?? job.quotedRequestBody);
  const references = (job.publication?.referenceAssetIds ?? []).flatMap((id): MediaRef[] => {
    const asset = assets.get(id);
    if (!asset || (asset.kind !== "image" && asset.kind !== "video")) return [];
    const name = asset.path.split("/").at(-1) ?? asset.path;
    const ref = mediaRef(
      paths,
      path.join(paths.projectDir, asset.path),
      /^[a-f0-9]{64}\./.test(name) ? (names.get(id) ?? asset.kind) : name,
    );
    return ref ? [ref] : [];
  });
  const submitted = at(["submitting", "queued", "running"]);
  const source = references.find((ref) => ref.kind === "video");
  return {
    id: job.operationId.slice(0, 128),
    provider: text(job.provider, 64) ?? "unknown",
    ...(text(job.endpoint, 256) ? { endpoint: text(job.endpoint, 256) } : {}),
    ...(text(job.publication?.model, 256) && job.publication?.model !== job.endpoint
      ? { model: text(job.publication?.model, 256) }
      : {}),
    ...(text(job.stage, 64) ? { step: text(job.stage, 64) } : {}),
    state: job.state,
    ...(errorOf(job) ? { error: errorOf(job) } : {}),
    reservedUsd: job.reservedMicros / 1_000_000,
    ...(job.receipt ? { costUsd: jobCostUsd(job) } : {}),
    ...(job.release?.reason === "confirmed-no-charge" || job.refundedFailure ? { noCharge: true } : {}),
    priceKnown: job.quote.confidence !== "user-bound",
    ...(job.quote.confidence !== "user-bound" && !job.receipt ? { quotedUsd: job.quote.expectedUsd } : {}),
    ...(iso(job.createdAt) ? { createdAt: iso(job.createdAt) } : {}),
    ...(iso(submitted) ? { submittedAt: iso(submitted) } : {}),
    ...(iso(finished) ? { finishedAt: iso(finished) } : {}),
    ...fields,
    ...(job.publication?.modelPreparation?.id ? { preparation: job.publication.modelPreparation.id.slice(0, 80) } : {}),
    ...(outputPath ? { outputPath } : {}),
    ...(output ? { output } : {}),
    ...(references.length ? { references: references.slice(0, 16) } : {}),
    ...(source ? { source } : {}),
  };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The newest preparation by its receipt's `createdAt` (folder time when the receipt has none). */
export function readLatestPreparation(paths: ProjectPaths): ModelPreparationView | undefined {
  const base = path.join(paths.projectDir, "pipeline", "model-preparations");
  let names: string[];
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(entry.name),
      )
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  if (!names.length) return undefined;
  const dated = names.map((name) => {
    const receipt = record(readJsonFile(path.join(base, name, "receipt.json")));
    const created = Date.parse(String(receipt?.createdAt ?? ""));
    return {
      name,
      receipt,
      at: Number.isFinite(created) ? created : (statOf(path.join(base, name))?.mtimeMs ?? 0),
    };
  });
  dated.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  const { name, receipt } = dated[0]!;
  const dir = path.join(base, name);
  const relative = (file: string) => `pipeline/model-preparations/${name}/${file}`;
  const spec = record(receipt?.spec);
  const request = record(readJsonFile(path.join(dir, "request.json")));
  const fields = requestFields(record(request?.input));
  const references = (Array.isArray(receipt?.references) ? receipt.references : []).flatMap((item): MediaRef[] => {
    const reference = record(item);
    const original = record(reference?.media)?.original;
    if (typeof original !== "string") return [];
    const label = [text(reference?.entityId, 64), text(reference?.role, 64)].filter(Boolean).join(" · ");
    const ref = mediaRef(paths, original, label || undefined);
    return ref ? [ref] : [];
  });
  const board = (Array.isArray(receipt?.reviewFiles) ? receipt.reviewFiles : [])
    .flatMap((item): MediaRef[] => {
      const file = text(record(item)?.path, 200);
      if (!file || file.includes("/")) return [];
      const ref = mediaRef(paths, path.join(dir, file), file);
      return ref ? [ref] : [];
    })
    .slice(0, 16);
  const sourceOriginal = record(receipt?.preparedSource)?.original ?? record(receipt?.source)?.original;
  const source = typeof sourceOriginal === "string" ? mediaRef(paths, sourceOriginal, "source") : undefined;
  const approval = record(readJsonFile(path.join(dir, "approval.json")));
  const rights = record(readJsonFile(path.join(dir, "rights.json")));
  return {
    id: name,
    ...(iso(receipt?.createdAt) ? { createdAt: iso(receipt?.createdAt) } : {}),
    ...(text(receipt?.endpoint ?? request?.endpoint, 256)
      ? { endpoint: text(receipt?.endpoint ?? request?.endpoint, 256) }
      : {}),
    ...(text(spec?.mode, 64) ? { mode: text(spec?.mode, 64) } : {}),
    ...fields,
    ...(fields.resolution ? {} : text(spec?.resolution, 32) ? { resolution: text(spec?.resolution, 32) } : {}),
    references: references.slice(0, 16),
    board,
    ...(source ? { source } : {}),
    ...(approval
      ? {
          approval: {
            ...(iso(approval.approvedAt) ? { at: iso(approval.approvedAt) } : {}),
            ...(typeof approval.userStatement === "string"
              ? { userStatement: approval.userStatement.slice(0, 2000) }
              : {}),
          },
        }
      : {}),
    ...(text(rights?.status, 64)
      ? {
          rights: {
            status: text(rights?.status, 64)!,
            ...(typeof rights?.userStatement === "string"
              ? { userStatement: rights.userStatement.slice(0, 2000) }
              : {}),
          },
        }
      : {}),
    count: names.length,
  };
}

/** True when a directory holds at least one non-hidden file (recursively, bounded). */
function hasFiles(directory: string, budget = { left: 500 }): boolean {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (budget.left-- <= 0) return true;
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile()) return true;
    if (entry.isDirectory() && hasFiles(path.join(directory, entry.name), budget)) return true;
  }
  return false;
}

/**
 * A timeline project with nothing of its route yet: no film code (`src/projects/<id>/`), no render under `out/<id>/`,
 * no music and no voiceover. Its project.json is then only the template `project:new` wrote.
 */
export function timelineWithoutMaterial(paths: ProjectPaths, hasRenders: boolean): boolean {
  if (hasRenders) return false;
  if (hasFiles(path.join(paths.rootDir, "src", "projects", paths.id))) return false;
  if (hasFiles(path.join(paths.projectDir, "music"))) return false;
  if (hasFiles(path.join(paths.projectDir, "voiceover"))) return false;
  return true;
}

/** The job store's jobs, or none when there is no readable store (money already reports an unreadable one). */
export function readStoreJobs(paths: ProjectPaths): GenerationJob[] {
  try {
    const opened = openStore(paths);
    return opened ? Object.values(opened.database.jobs) : [];
  } catch {
    return [];
  }
}

export function readGenerations(
  paths: ProjectPaths,
  assets: readonly AssetSummary[],
  advisories: string[],
  jobs: readonly GenerationJob[] = readStoreJobs(paths),
): Generations | undefined {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const names = jobs.length ? originalNames(paths) : new Map<string, string>();
  const generations = jobs
    .map((job) => {
      try {
        return generationOf(job, paths, byId, names);
      } catch (error) {
        advisories.push(
          `generations: job ${job.operationId.slice(0, 64)} cannot be shown (${String(error)})`.slice(0, 2000),
        );
        return undefined;
      }
    })
    .filter((job): job is Generation => !!job)
    .sort(
      (a, b) =>
        (b.submittedAt ?? b.createdAt ?? "").localeCompare(a.submittedAt ?? a.createdAt ?? "") ||
        a.id.localeCompare(b.id),
    )
    .slice(0, MAX_JOBS);
  let preparation: ModelPreparationView | undefined;
  try {
    preparation = readLatestPreparation(paths);
  } catch (error) {
    advisories.push(`generations: model preparations cannot be read (${String(error)})`.slice(0, 2000));
  }
  if (!generations.length && !preparation) return undefined;
  return { jobs: generations, ...(preparation ? { preparation } : {}) };
}
