import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  readFileSync,
  openSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  renameSync,
  linkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { CliErrorObject, isBespokeBrief } from "../cli";
import { assertProjectId } from "../render-plan";
import { hashFile, readAssetRegistry } from "../assets/registry";
import {
  EntityCardInputSchema,
  EntityKindSchema,
  EntityVersionSchema,
  EntityManifestSchema,
  EntityApprovalSchema,
  ApprovalActorSchema,
  type EntityKind,
  type EntityCardInput,
  type EntityVersion,
  type EntityApproval,
  type ApprovalActor,
  type EntityRef,
} from "../../types/entities";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const within = (root: string, file: string) => {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
};
function safe(root: string, file: string) {
  if (!within(root, file)) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Entity path escapes project." });
  let ancestor = file;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!within(realpathSync(root), realpathSync(ancestor)))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Entity symlink escapes project." });
  return file;
}
function paths(projectId: string, rootDir: string, kind?: EntityKind, id?: string) {
  assertProjectId(projectId);
  if (id) assertProjectId(id);
  if (kind) EntityKindSchema.parse(kind);
  const projects = path.resolve(rootDir, "public/projects"),
    project = path.join(projects, projectId);
  if (!existsSync(path.join(project, "project.json")) && !isBespokeBrief(path.join(project, "pipeline/brief.json")))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
  if (!within(realpathSync(rootDir), realpathSync(projects)) || !within(realpathSync(projects), realpathSync(project)))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Project symlink escapes workspace." });
  const entities = safe(project, path.join(project, "entities"));
  const directory = kind && id ? safe(project, path.join(entities, kind, id)) : entities;
  return { project, entities, directory, manifest: safe(project, path.join(directory, "entity.json")) };
}
function parsed<T>(schema: { parse(value: unknown): T }, file: string): T {
  if (!existsSync(file)) throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Entity file missing: ${file}` });
  try {
    return schema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Invalid entity document: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
function atomicJson(root: string, file: string, value: unknown, immutable = false) {
  safe(root, file);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = safe(root, path.join(path.dirname(file), `.${randomUUID()}.tmp`));
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (immutable) linkSync(temporary, file);
    else renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function withLock<T>(project: string, directory: string, fn: () => T): T {
  safe(project, directory);
  mkdirSync(directory, { recursive: true });
  const lock = safe(project, path.join(directory, "entity.lock"));
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliErrorObject({ code: "TIMEOUT", message: "Entity is locked. Inspect stale locks before removal." });
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
function revisionFile(directory: string, revision: number, approval = false) {
  if (!Number.isInteger(revision) || revision < 1)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Revision must be a positive integer." });
  return path.join(directory, approval ? "approvals" : "versions", `${String(revision).padStart(6, "0")}.json`);
}
function readVersion(project: string, directory: string, revision: number): EntityVersion {
  const version = parsed(EntityVersionSchema, safe(project, revisionFile(directory, revision)));
  const { contentHash, ...content } = version;
  if (version.revision !== revision || digest(content) !== contentHash)
    throw new CliErrorObject({ code: "VALIDATION", message: "Immutable entity version hash/revision mismatch." });
  return version;
}
function snapshotReferences(
  projectId: string,
  rootDir: string,
  card: EntityVersion["card"],
): EntityVersion["referenceSnapshots"] {
  const registry = readAssetRegistry(projectId, rootDir),
    project = paths(projectId, rootDir).project;
  const roles = new Set<string>();
  return card.references.map((ref) => {
    if (roles.has(ref.role))
      throw new CliErrorObject({ code: "VALIDATION", message: `Duplicate canonical reference role: ${ref.role}` });
    roles.add(ref.role);
    const asset = registry.assets.find((a) => a.id === ref.assetId);
    if (!asset)
      throw new CliErrorObject({
        code: "FILE_NOT_FOUND",
        message: `Entity reference is not registered: ${ref.assetId}`,
      });
    const original = safe(project, path.resolve(rootDir, "public", asset.files.original));
    if (!existsSync(original) || hashFile(original) !== asset.hash)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Entity reference original missing or changed: ${ref.assetId}`,
      });
    return {
      assetId: asset.id,
      hash: asset.hash,
      original: asset.files.original,
      role: ref.role,
      provenance: asset.provenance,
      rights: asset.rights,
    };
  });
}
export type EntityView = {
  version: EntityVersion;
  status: "candidate" | "approved";
  approval?: EntityApproval;
  canonical: boolean;
};
export function getEntityVersion(
  projectId: string,
  kind: EntityKind,
  id: string,
  {
    revision,
    rootDir = process.cwd(),
    requireApproved = false,
  }: { revision?: number; rootDir?: string; requireApproved?: boolean } = {},
): EntityView {
  const p = paths(projectId, rootDir, kind, id),
    manifest = parsed(EntityManifestSchema, p.manifest);
  if (manifest.id !== id || manifest.kind !== kind)
    throw new CliErrorObject({ code: "VALIDATION", message: "Entity manifest identity mismatch." });
  const number = revision ?? manifest.canonicalRevision ?? manifest.latestRevision;
  if (number > manifest.latestRevision)
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: "Revision is not committed in entity manifest." });
  const version = readVersion(p.project, p.directory, number);
  if (version.card.id !== id || version.card.kind !== kind)
    throw new CliErrorObject({ code: "VALIDATION", message: "Entity version identity mismatch." });
  const file = safe(p.project, revisionFile(p.directory, number, true));
  const approval = existsSync(file) ? parsed(EntityApprovalSchema, file) : undefined;
  if (
    approval &&
    (approval.revision !== number ||
      approval.versionHash !== version.contentHash ||
      JSON.stringify(approval.referenceHashes) !== JSON.stringify(version.referenceSnapshots.map((r) => r.hash)))
  )
    throw new CliErrorObject({ code: "VALIDATION", message: "Approval does not match immutable version/references." });
  if (manifest.canonicalRevision === number && !approval)
    throw new CliErrorObject({ code: "VALIDATION", message: "Canonical entity version has no approval record." });
  if (requireApproved && !approval)
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `Entity ${id} revision ${number} needs explicit approval.`,
    });
  return {
    version,
    status: approval ? "approved" : "candidate",
    ...(approval ? { approval } : {}),
    canonical: manifest.canonicalRevision === number,
  };
}
export function listEntities(
  projectId: string,
  rootDir = process.cwd(),
): ReturnType<typeof EntityManifestSchema.parse>[] {
  const p = paths(projectId, rootDir);
  if (!existsSync(p.entities)) return [];
  const result: ReturnType<typeof EntityManifestSchema.parse>[] = [];
  for (const kind of EntityKindSchema.options) {
    const dir = safe(p.project, path.join(p.entities, kind));
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = safe(p.project, path.join(dir, entry.name, "entity.json"));
      if (existsSync(file)) result.push(parsed(EntityManifestSchema, file));
    }
  }
  return result;
}
function validateLinks(projectId: string, rootDir: string, links: EntityRef[], approved: boolean) {
  for (const link of links) {
    if (approved) resolveEntityReferences(projectId, link, rootDir);
    else getEntityVersion(projectId, link.kind, link.entityId, { rootDir, revision: link.revision });
  }
}
export function saveEntityVersion(
  projectId: string,
  input: EntityCardInput,
  {
    expectedRevision = 0,
    baseRevision,
    rootDir = process.cwd(),
  }: { expectedRevision?: number; baseRevision?: number; rootDir?: string } = {},
): EntityView {
  let card: EntityVersion["card"];
  try {
    card = EntityCardInputSchema.parse(input);
  } catch (error) {
    throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
  }
  const p = paths(projectId, rootDir, card.kind, card.id);
  return withLock(p.project, p.directory, () => {
    const manifest = existsSync(p.manifest) ? parsed(EntityManifestSchema, p.manifest) : null;
    if ((manifest?.latestRevision ?? 0) !== expectedRevision)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Stale entity revision: expected ${expectedRevision}, latest ${manifest?.latestRevision ?? 0}.`,
      });
    if (manifest && (manifest.id !== card.id || manifest.kind !== card.kind))
      throw new CliErrorObject({ code: "VALIDATION", message: "Entity manifest identity mismatch." });
    if (manifest) getEntityVersion(projectId, card.kind, card.id, { rootDir, revision: manifest.latestRevision });
    if (baseRevision !== undefined) {
      if (!manifest) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Cannot fork a missing entity." });
      getEntityVersion(projectId, card.kind, card.id, { rootDir, revision: baseRevision });
    }
    validateLinks(projectId, rootDir, card.links, false);
    const snapshots = snapshotReferences(projectId, rootDir, card),
      revision = expectedRevision + 1;
    const content = {
      schemaVersion: 1 as const,
      revision,
      parentRevision: baseRevision ?? (expectedRevision || null),
      createdAt: new Date().toISOString(),
      card,
      referenceSnapshots: snapshots,
    };
    let version = EntityVersionSchema.parse({ ...content, contentHash: digest(content) });
    const file = safe(p.project, revisionFile(p.directory, revision));
    if (existsSync(file)) {
      // An interrupted write can leave a complete uncommitted immutable version.
      const orphan = readVersion(p.project, p.directory, revision);
      if (
        JSON.stringify(orphan.card) !== JSON.stringify(card) ||
        JSON.stringify(orphan.referenceSnapshots) !== JSON.stringify(snapshots) ||
        orphan.parentRevision !== content.parentRevision
      )
        throw new CliErrorObject({
          code: "FILE_EXISTS",
          message: "Uncommitted immutable revision differs; inspect before retrying.",
        });
      version = orphan;
    } else atomicJson(p.project, file, version, true);
    atomicJson(
      p.project,
      p.manifest,
      EntityManifestSchema.parse({
        schemaVersion: 1,
        id: card.id,
        kind: card.kind,
        latestRevision: revision,
        canonicalRevision: manifest?.canonicalRevision ?? null,
        canonicalHistory: manifest?.canonicalHistory ?? [],
      }),
    );
    return { version, status: "candidate", canonical: false };
  });
}
export function approveEntityVersion(
  projectId: string,
  kind: EntityKind,
  id: string,
  revision: number,
  actorInput: ApprovalActor,
  { expectedRevision, rootDir = process.cwd() }: { expectedRevision: number; rootDir?: string },
): EntityView {
  let actor: ApprovalActor;
  try {
    actor = ApprovalActorSchema.parse(actorInput);
  } catch {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Approval requires explicit human actor and authorization evidence.",
    });
  }
  const p = paths(projectId, rootDir, kind, id);
  return withLock(p.project, p.directory, () => {
    const manifest = parsed(EntityManifestSchema, p.manifest);
    if (manifest.latestRevision !== expectedRevision)
      throw new CliErrorObject({ code: "VALIDATION", message: "Stale approval: latest revision changed." });
    const view = getEntityVersion(projectId, kind, id, { rootDir, revision });
    validateLinks(projectId, rootDir, view.version.card.links, true);
    const snapshots = snapshotReferences(projectId, rootDir, view.version.card);
    if (JSON.stringify(snapshots) !== JSON.stringify(view.version.referenceSnapshots))
      throw new CliErrorObject({ code: "VALIDATION", message: "Canonical reference snapshot changed." });
    const approval =
      view.approval ??
      EntityApprovalSchema.parse({
        schemaVersion: 1,
        revision,
        approvedAt: new Date().toISOString(),
        actor,
        versionHash: view.version.contentHash,
        referenceHashes: snapshots.map((r) => r.hash),
        consentInferred: false,
      });
    if (!view.approval) atomicJson(p.project, revisionFile(p.directory, revision, true), approval, true);
    atomicJson(p.project, p.manifest, {
      ...manifest,
      canonicalRevision: revision,
      canonicalHistory: [...manifest.canonicalHistory, { revision, at: new Date().toISOString(), actor }],
    });
    return { version: view.version, approval, status: "approved", canonical: true };
  });
}
/** Resolve pinned approved references; one set serves all output formats. */
export function resolveEntityReferences(projectId: string, ref: EntityRef, rootDir = process.cwd()) {
  const visited = new Set<string>();
  const verify = (current: EntityRef) => {
    const key = `${current.kind}/${current.entityId}@${current.revision}`;
    if (visited.has(key)) return;
    visited.add(key);
    const view = getEntityVersion(projectId, current.kind, current.entityId, {
      revision: current.revision,
      rootDir,
      requireApproved: true,
    });
    const snapshots = snapshotReferences(projectId, rootDir, view.version.card);
    if (JSON.stringify(snapshots) !== JSON.stringify(view.version.referenceSnapshots))
      throw new CliErrorObject({ code: "VALIDATION", message: "Approved references changed." });
    for (const child of view.version.card.links) verify(child);
  };
  verify(ref);
  const view = getEntityVersion(projectId, ref.kind, ref.entityId, {
    revision: ref.revision,
    rootDir,
    requireApproved: true,
  });
  return { ref, card: view.version.card, references: view.version.referenceSnapshots };
}
