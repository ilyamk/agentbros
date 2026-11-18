import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
  fsyncSync,
} from "node:fs";
import path from "node:path";
import { assertPathWithin, validateProjectId, isBespokeBrief, CliErrorObject } from "../cli";
import { IconManifestSchema, IconProfileSchema, type IconProfile } from "../../types/icon-resources";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function projectPath(root: string, id: string) {
  validateProjectId(id);
  const directory = path.resolve(root, "public/projects", id);
  assertPathWithin(path.resolve(root), directory);
  assertPathWithin(path.resolve(root, "public/projects"), directory);
  if (!existsSync(path.join(directory, "project.json")) && !isBespokeBrief(path.join(directory, "pipeline/brief.json")))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project ${id} does not exist` });
  return directory;
}
export function scoped(root: string, id: string, file: string) {
  const directory = projectPath(root, id),
    absolute = path.resolve(root, "public", file);
  assertPathWithin(directory, absolute);
  return absolute;
}
export function iconFile(root: string, id: string, name: string) {
  return scoped(root, id, `projects/${id}/resources/icons/${name}`);
}
export function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function withLock<T>(file: string, action: () => T): T {
  mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliErrorObject({
        code: "TIMEOUT",
        message: "Icon resource store is locked; inspect the owning process before removing a stale lock",
      });
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return action();
  } finally {
    closeSync(fd);
    unlinkSync(file);
  }
}
export function readManifest(root: string, id: string) {
  const file = iconFile(root, id, "manifest.json");
  const manifest = IconManifestSchema.parse(
    existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { version: 1, revision: 0, acquisitions: [], derivatives: [] },
  );
  for (const a of manifest.acquisitions) {
    if (
      a.original !== `projects/${id}/resources/originals/${a.hash}.svg` ||
      a.metadataFile !== `projects/${id}/resources/icons/${a.id}.source.json` ||
      !/^[a-f0-9]{64}$/.test(a.id)
    )
      throw Error("Icon acquisition path differs from its owning hash");
  }
  for (const d of manifest.derivatives) {
    if (d.file !== `projects/${id}/resources/icons/${d.hash}.${d.options.format}`)
      throw Error("Icon export path differs from its owning hash");
  }
  if (
    new Set(manifest.acquisitions.map((a) => a.id)).size !== manifest.acquisitions.length ||
    new Set(manifest.derivatives.map((d) => d.id)).size !== manifest.derivatives.length
  )
    throw Error("Duplicate icon resource identity");
  return manifest;
}
export function profilePath(root: string, id: string) {
  return scoped(root, id, `projects/${id}/resources/icon-profile.json`);
}
export function readProfile(root: string, id: string): IconProfile | undefined {
  const file = profilePath(root, id);
  return existsSync(file) ? IconProfileSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
}
export const profilePresets = [
  "phosphor-thin",
  "phosphor-light",
  "phosphor-regular",
  "phosphor-bold",
  "phosphor-fill",
  "phosphor-duotone",
  "lucide-outline",
  "tabler-outline",
  "tabler-filled",
];
export function setProfile(root: string, id: string, input: unknown, expectedRevision?: number) {
  const file = profilePath(root, id);
  const parsed = IconProfileSchema.parse(input);
  return withLock(iconFile(root, id, "store.lock"), () => {
    const old = readProfile(root, id);
    if (old && expectedRevision !== old.revision)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Profile changed or exists; provide expected-revision ${old.revision}`,
      });
    const profile = IconProfileSchema.parse({ ...parsed, revision: (old?.revision ?? 0) + 1 });
    atomicJson(file, profile);
    return profile;
  });
}
