import { readLocalImportProvenance } from "../apple/provenance";
import { assertVorkResult } from "../vork/render";
import { digest as vorkDigest } from "../vork/runtime";
import { readVorkImportProvenance } from "../vork/provenance";
import type { ChapterInspectionInputs } from "../longform/inspection-inputs";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  realpathSync,
  statSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  copyFileSync,
  linkSync,
  constants,
} from "node:fs";
import path from "node:path";
import {
  AssetRecordSchema,
  AssetRegistrySchema,
  type AssetRecord,
  type AssetRegistry,
  type AssetProvenanceInput,
  type AssetRightsInput,
} from "../../types/assets";
import { assertProjectId } from "../render-plan";
import { CliErrorObject, isBespokeBrief, isCampaignContainer, assertPathWithin } from "../cli";
import { heicRefusal, isHeif, majorBrand, readHead } from "./heic";
import { inspectAsset } from "./inspect";

const within = (parent: string, file: string) => {
  const relative = path.relative(parent, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
function safePath(root: string, file: string) {
  if (!within(root, file))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Asset registry path escapes project." });
  let parent = file;
  while (!existsSync(parent)) parent = path.dirname(parent);
  if (!within(realpathSync(root), realpathSync(parent)))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Asset registry symlink escapes project." });
  return file;
}
function projectPaths(projectId: string, rootDir: string) {
  assertProjectId(projectId);
  const projects = path.resolve(rootDir, "public/projects"),
    project = path.join(projects, projectId);
  if (
    !existsSync(path.join(project, "project.json")) &&
    !isBespokeBrief(path.join(project, "pipeline/brief.json")) &&
    !isCampaignContainer(project)
  )
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
  if (!within(realpathSync(rootDir), realpathSync(projects)) || !within(realpathSync(projects), realpathSync(project)))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Project symlink escapes projects/." });
  return {
    project,
    pipeline: safePath(project, path.join(project, "pipeline")),
    imported: safePath(project, path.join(project, "assets/imported")),
    registry: safePath(project, path.join(project, "pipeline/asset-registry.json")),
  };
}
export function hashFile(file: string): string {
  const fd = openSync(file, "r"),
    hash = createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  try {
    let size: number;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}
function loadRegistry(
  file: string,
  projectId: string,
  inspection?: ChapterInspectionInputs,
  scope?: string,
): AssetRegistry {
  if (!existsSync(file)) return { schemaVersion: 1, revision: 0, assets: [] };
  try {
    const registry = AssetRegistrySchema.parse(
      inspection ? inspection.json(file, scope!, 4 * 1024 * 1024) : JSON.parse(readFileSync(file, "utf8")),
    );
    for (const asset of registry.assets)
      if (
        !asset.files.original.startsWith(`projects/${projectId}/assets/imported/`) ||
        asset.files.original.includes("..") ||
        asset.files.original.includes("\\")
      )
        throw new Error("Invalid original file reference");
    return registry;
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Invalid asset registry: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
export function readAssetRegistry(
  projectId: string,
  rootDir = process.cwd(),
  inspection?: ChapterInspectionInputs,
): AssetRegistry {
  const paths = projectPaths(projectId, rootDir);
  if (inspection && !existsSync(paths.registry)) inspection.absent(paths.registry, paths.project);
  return loadRegistry(paths.registry, projectId, inspection, paths.project);
}
/** `nonMedia` also accepts GLB/glTF, JSON and text files (provider 3D and model results); off by default. */
export type ImportAssetOptions = {
  nonMedia?: boolean;
  projectId: string;
  sourceFile: string;
  provenance: AssetProvenanceInput;
  rights?: AssetRightsInput;
  entityLinks?: AssetRecord["entityLinks"];
  vorkResult?: AssetRecord["vorkResult"];
  dryRun?: boolean;
  rootDir?: string;
};
export type ImportAssetResult = { asset: AssetRecord; duplicate: boolean; dryRun: boolean; registryPath: string };

/** Immutable import. The registry is the commit marker; a crash may leave a reusable unregistered blob. */
export function importAsset(options: ImportAssetOptions): ImportAssetResult {
  const rootDir = options.rootDir ?? process.cwd();
  const paths = projectPaths(options.projectId, rootDir),
    source = path.resolve(options.sourceFile);
  if (!existsSync(source) || !statSync(source).isFile())
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Import source missing: ${source}` });
  const bytes = statSync(source).size;
  if (bytes <= 0) throw new CliErrorObject({ code: "VALIDATION", message: "Cannot import an empty asset." });
  if (isHeif(source, majorBrand(readHead(source)))) throw heicRefusal(source);
  const hash = hashFile(source),
    inspected = inspectAsset(source, { nonMedia: options.nonMedia === true });
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "model/gltf-binary": "glb",
    "model/gltf+json": "gltf",
    "model/obj": "obj",
    "application/json": "json",
    "text/plain": "txt",
  };
  const filename = `${hash}.${extensions[inspected.mime] ?? "bin"}`;
  const localResult = readLocalImportProvenance(source, hash);
  const discoveredVork = readVorkImportProvenance(source, hash, rootDir);
  if (options.vorkResult && discoveredVork && JSON.stringify(options.vorkResult) !== JSON.stringify(discoveredVork))
    throw new CliErrorObject({ code: "VALIDATION", message: "Vork import metadata differs from the original receipt" });
  const vorkResult = options.vorkResult ?? discoveredVork;
  if (vorkResult) {
    assertVorkResult(vorkResult.receipt, hash, rootDir);
    for (const pin of vorkResult.receipt.inputs)
      assertPathWithin(path.resolve(rootDir), path.resolve(rootDir, pin.file));
    if (
      vorkResult.sourceOutputHash !== hash ||
      vorkResult.receiptHash !== vorkDigest(JSON.stringify(vorkResult.receipt))
    )
      throw new CliErrorObject({ code: "VALIDATION", message: "Vork import receipt or output hash mismatch" });
  }
  let asset: AssetRecord;
  try {
    asset = AssetRecordSchema.parse({
      schemaVersion: 1,
      id: `sha256:${hash}`,
      hash,
      revision: 1,
      createdAt: new Date().toISOString(),
      kind: inspected.kind,
      media: inspected.media,
      ...(localResult ? { localResult } : {}),
      ...(vorkResult ? { vorkResult } : {}),
      files: { original: `projects/${options.projectId}/assets/imported/${filename}`, bytes, mime: inspected.mime },
      provenance: {
        ...options.provenance,
        originalFilename: options.provenance.originalFilename ?? path.basename(source),
      },
      rights: options.rights ?? {},
      entityLinks: options.entityLinks ?? [],
      status: "candidate",
    });
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Invalid import metadata: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const registryPath = path.relative(rootDir, paths.registry);
  const validateRefs = (registry: AssetRegistry) => {
    for (const ref of asset.provenance.referenceAssetIds)
      if (!registry.assets.some((a) => a.id === ref))
        throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Reference asset is not registered: ${ref}` });
  };
  if (options.dryRun) {
    const registry = loadRegistry(paths.registry, options.projectId);
    validateRefs(registry);
    const prior = registry.assets.find((a) => a.id === asset.id);
    if (prior) {
      if (vorkResult && JSON.stringify(prior.vorkResult) !== JSON.stringify(vorkResult))
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Identical bytes already have different Vork provenance",
        });
      if (localResult && JSON.stringify(prior.localResult) !== JSON.stringify(localResult))
        throw new CliErrorObject({
          code: "VALIDATION",
          message:
            "Identical bytes already have different provenance; retain the original native result instead of silently replacing import metadata",
        });
      const original = safePath(paths.project, path.resolve(rootDir, "public", prior.files.original));
      if (!existsSync(original) || hashFile(original) !== prior.hash)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Registered immutable original is missing or corrupted.",
        });
    }
    return { asset: prior ?? asset, duplicate: !!prior, dryRun: true, registryPath };
  }
  mkdirSync(paths.pipeline, { recursive: true });
  const lock = safePath(paths.project, `${paths.registry}.lock`);
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliErrorObject({
        code: "TIMEOUT",
        message: "Asset registry is locked by another import. Inspect stale locks before removal.",
      });
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const registry = loadRegistry(paths.registry, options.projectId);
    validateRefs(registry);
    const prior = registry.assets.find((a) => a.id === asset.id);
    if (prior) {
      if (vorkResult && JSON.stringify(prior.vorkResult) !== JSON.stringify(vorkResult))
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Identical bytes already have different Vork provenance",
        });
      if (localResult && JSON.stringify(prior.localResult) !== JSON.stringify(localResult))
        throw new CliErrorObject({
          code: "VALIDATION",
          message:
            "Identical bytes already have different provenance; retain the original native result instead of silently replacing import metadata",
        });
      const original = safePath(paths.project, path.resolve(rootDir, "public", prior.files.original));
      if (!existsSync(original) || hashFile(original) !== prior.hash)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Registered immutable original is missing or corrupted.",
        });
      return { asset: prior, duplicate: true, dryRun: false, registryPath };
    }
    mkdirSync(paths.imported, { recursive: true });
    const finalFile = safePath(paths.project, path.join(paths.imported, filename));
    if (existsSync(finalFile)) {
      if (hashFile(finalFile) !== hash)
        throw new CliErrorObject({ code: "FILE_EXISTS", message: "Immutable import path contains different bytes." });
    } else {
      const temporary = safePath(paths.project, path.join(paths.imported, `.${randomUUID()}.tmp`));
      try {
        copyFileSync(source, temporary, constants.COPYFILE_EXCL);
        if (hashFile(temporary) !== hash || statSync(temporary).size !== bytes)
          throw new CliErrorObject({ code: "VALIDATION", message: "Import source changed while being copied." });
        const blobFd = openSync(temporary, "r");
        try {
          fsyncSync(blobFd);
        } finally {
          closeSync(blobFd);
        }
        linkSync(temporary, finalFile); // no overwrite even if an unexpected writer races us
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    const updated = AssetRegistrySchema.parse({
      ...registry,
      revision: registry.revision + 1,
      assets: [...registry.assets, asset],
    });
    const tempRegistry = safePath(paths.project, path.join(paths.pipeline, `.${randomUUID()}.registry.tmp`));
    try {
      const registryFd = openSync(tempRegistry, "wx", 0o600);
      try {
        writeFileSync(registryFd, `${JSON.stringify(updated, null, 2)}\n`);
        fsyncSync(registryFd);
      } finally {
        closeSync(registryFd);
      }
      renameSync(tempRegistry, safePath(paths.project, paths.registry));
    } finally {
      if (existsSync(tempRegistry)) unlinkSync(tempRegistry);
    }
    return { asset, duplicate: false, dryRun: false, registryPath };
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
