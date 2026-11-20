/**
 * The Media tab's albums (2026-11-20): every media file of the project grouped by how it was made. Read-only and derived
 * from what the project already records, never a second registry:
 *
 * - the asset registry (`pipeline/asset-registry.json`): origin, tool, `generationJobId`, reference ids, hash;
 * - the job store: which registered files went into a job (preparation) and which files a job published (generation);
 * - model preparations (`pipeline/model-preparations/<id>/receipt.json`): the source and the prepared clip;
 * - renders under `out/<id>/` (builds);
 * - files under `footage/` and `assets/` that none of these lists: shown as not registered. Bytes equal to a registered
 *   file make an alias of it (content hash, memoised by path, size and mtime).
 *
 * A job's own result is not repeated here: the Generations album shows `generations.jobs`.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import type { Gallery, MediaAlbum, MediaItem, MediaRef, ProjectView } from "../../../types/console";
import { AssetRegistrySchema, type AssetRecord } from "../../../types/assets";
import type { GenerationJob } from "../../jobs/types";
import { hashFile, locate, mediaKind, readJsonFile, statOf, toIso, type ProjectPaths } from "./files";
import { mediaRef } from "./generations";

const MAX_ITEMS = 2000;
const MAX_WALK = 4000;
/** Unregistered files above this size are listed without a content hash (no alias detection). */
const MAX_HASH_BYTES = 2 * 1024 * 1024 * 1024;
const ALBUM_ORDER: MediaAlbum[] = ["sources", "preparation", "generations", "builds", "unregistered"];
const GENERATED_ORIGINS = new Set(["provider"]);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const iso = (value: unknown): string | undefined => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

/** A human label: the original filename unless it is a temporary or hash name. */
function labelOf(asset: AssetRecord, fallback: string): string {
  const original = asset.provenance.originalFilename;
  if (original && !original.startsWith(".") && !/^[a-f0-9]{40,}(-\d+)?\./.test(original)) return original.slice(0, 160);
  return fallback.slice(0, 160);
}

type Preparations = {
  /** Prepared clip asset id → its source file and preparation id. */
  prepared: Map<string, { parent?: string; preparation: string }>;
  /** Asset ids a preparation names as its source. */
  sources: Set<string>;
};

function readPreparations(paths: ProjectPaths): Preparations {
  const prepared: Preparations["prepared"] = new Map();
  const sources = new Set<string>();
  const base = path.join(paths.projectDir, "pipeline", "model-preparations");
  let names: string[] = [];
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .slice(0, 500);
  } catch {
    return { prepared, sources };
  }
  for (const name of names) {
    const receipt = record(readJsonFile(path.join(base, name, "receipt.json")));
    const source = record(receipt?.source);
    const preparedSource = record(receipt?.preparedSource);
    if (typeof source?.assetId === "string") sources.add(source.assetId);
    if (typeof preparedSource?.assetId === "string" && preparedSource.assetId !== source?.assetId)
      prepared.set(preparedSource.assetId, {
        preparation: name.slice(0, 80),
        ...(typeof source?.original === "string" ? { parent: source.original } : {}),
      });
  }
  return { prepared, sources };
}

/** Media files under `directory` (relative to the project), skipping hidden entries and `skip` folders. */
function walk(paths: ProjectPaths, relative: string, skip: Set<string>, found: string[], budget: { left: number }) {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(path.join(paths.projectDir, relative), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left-- <= 0) return;
    if (entry.name.startsWith(".")) continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skip.has(child)) walk(paths, child, skip, found, budget);
    } else if (entry.isFile() && mediaKind(child) && mediaKind(child) !== "document") found.push(child);
  }
}

function readRegistry(paths: ProjectPaths, advisories: string[]): AssetRecord[] {
  const raw = readJsonFile(path.join(paths.projectDir, "pipeline", "asset-registry.json"));
  if (raw === undefined) return [];
  const parsed = AssetRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    advisories.push("gallery: pipeline/asset-registry.json does not validate; registered files are listed as files.");
    return [];
  }
  return parsed.data.assets;
}

export function readGallery(
  paths: ProjectPaths,
  jobs: readonly GenerationJob[],
  media: ProjectView["media"],
  advisories: string[],
): Gallery | undefined {
  const registry = readRegistry(paths, advisories);
  const byId = new Map(registry.map((asset) => [asset.id, asset]));
  const preparations = readPreparations(paths);
  const jobIds = new Set(jobs.map((job) => job.operationId));
  // Files the store's jobs plan or published: shown on their job card, not again here.
  const jobPaths = new Set<string>();
  const jobHashes = new Set<string>();
  // Registered videos a job took as input: material prepared for a generation.
  const jobInputs = new Set<string>();
  for (const job of jobs) {
    const planned = job.publication?.output ? locate(paths, job.publication.output) : undefined;
    if (planned?.root === "project") jobPaths.add(planned.path);
    const published = record(record(job.result)?.published);
    for (const hash of Array.isArray(published?.hashes) ? published.hashes : [])
      if (typeof hash === "string") jobHashes.add(hash);
    for (const id of job.publication?.referenceAssetIds ?? []) if (byId.get(id)?.kind === "video") jobInputs.add(id);
  }
  const footageNames = new Set<string>();
  const footage: string[] = [];
  walk(paths, "footage", new Set(), footage, { left: MAX_WALK });
  for (const file of footage) footageNames.add(file.split("/").at(-1)!);

  const items = new Map<string, MediaItem>();
  const refOf = (relative: string, label: string, sha256?: string): MediaRef | undefined => {
    const ref = mediaRef(paths, path.join(paths.projectDir, relative), label);
    return ref ? { ...ref, ...(sha256 ? { sha256 } : {}) } : undefined;
  };
  const parentRef = (asset: AssetRecord, prepared?: { parent?: string }): MediaRef | undefined => {
    if (prepared?.parent) {
      const source = registry.find(
        (candidate) => locate(paths, candidate.files.original)?.path === locate(paths, prepared.parent!)?.path,
      );
      return mediaRef(paths, prepared.parent, source ? labelOf(source, "source") : "source");
    }
    const parent = asset.provenance.referenceAssetIds
      .map((id) => byId.get(id))
      .find((candidate) => candidate && candidate.kind === asset.kind);
    return parent ? mediaRef(paths, parent.files.original, labelOf(parent, parent.kind)) : undefined;
  };

  for (const asset of registry) {
    const generationJobId = asset.provenance.generationJobId;
    if (generationJobId && jobIds.has(generationJobId)) {
      jobHashes.add(asset.hash);
      continue;
    }
    if (jobHashes.has(asset.hash)) continue;
    const where = locate(paths, asset.files.original);
    if (!where || where.root !== "project") continue;
    const kind = mediaKind(where.path);
    if (!kind || kind === "document") continue;
    const prepared = preparations.prepared.get(asset.id);
    const ref = refOf(
      where.path,
      labelOf(asset, prepared ? `${prepared.preparation} · prepared` : where.path.split("/").at(-1)!),
      asset.hash,
    );
    if (!ref) continue;
    const tool = asset.provenance.tool;
    const isSource = preparations.sources.has(asset.id) || footageNames.has(asset.provenance.originalFilename ?? "");
    const album: MediaAlbum =
      generationJobId || GENERATED_ORIGINS.has(asset.provenance.origin)
        ? "generations"
        : prepared || tool === "model:prepare"
          ? "preparation"
          : isSource || kind !== "video"
            ? "sources"
            : jobInputs.has(asset.id)
              ? "preparation"
              : "builds";
    const parent = album === "sources" ? undefined : parentRef(asset, prepared);
    items.set(asset.hash, {
      id: asset.id,
      album,
      media: ref,
      registered: true,
      origin: asset.provenance.origin.slice(0, 64),
      ...(tool && tool !== "unknown" ? { tool: tool.slice(0, 64) } : {}),
      ...(iso(asset.createdAt) ? { createdAt: iso(asset.createdAt) } : {}),
      ...(parent && parent.path !== ref.path ? { parent } : {}),
      ...(generationJobId ? { generation: generationJobId.slice(0, 128) } : {}),
      ...(prepared ? { preparation: prepared.preparation } : {}),
    });
  }

  // Files no registry entry lists: an alias when the bytes match, else shown as not registered.
  const loose: string[] = [...footage];
  walk(paths, "assets", new Set(["assets/imported"]), loose, { left: MAX_WALK });
  for (const relative of loose) {
    if (jobPaths.has(relative)) continue;
    const file = path.join(paths.projectDir, relative);
    const info = statOf(file);
    if (!info?.isFile()) continue;
    const hash = info.size <= MAX_HASH_BYTES ? hashFile(file) : undefined;
    if (hash && jobHashes.has(hash)) continue;
    const known = hash ? items.get(hash) : undefined;
    if (known) {
      if (known.registered && (known.aliases?.length ?? 0) < 8) known.aliases = [...(known.aliases ?? []), relative];
      continue;
    }
    const ref = refOf(relative, relative.split("/").at(-1)!, hash);
    if (!ref) continue;
    items.set(hash ?? `file:${relative}`, {
      id: `file:${relative}`.slice(0, 1100),
      album: relative.startsWith("footage/") ? "sources" : "unregistered",
      media: ref,
      registered: false,
      createdAt: toIso(info.mtimeMs),
    });
  }

  // The route's renders.
  for (const render of [media.latestRender, media.animatic, ...(media.renders ?? [])]) {
    if (!render) continue;
    items.set(`out:${render.path}`, {
      id: `out:${render.path}`.slice(0, 1100),
      album: "builds",
      media: render,
      // Renders are the route's own output, recorded by their receipts; never "not registered".
      registered: true,
      ...(render.renderedAt ? { createdAt: render.renderedAt } : {}),
    });
  }

  if (!items.size) return undefined;
  const sorted = [...items.values()].sort(
    (a, b) =>
      ALBUM_ORDER.indexOf(a.album) - ALBUM_ORDER.indexOf(b.album) ||
      (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
      a.id.localeCompare(b.id),
  );
  return {
    items: sorted.slice(0, MAX_ITEMS),
    ...(sorted.length > MAX_ITEMS ? { truncated: true } : {}),
  };
}
