/**
 * Small, never-throwing file helpers of the projector (RFC 0004 WP3): JSON reads, content hashes memoised by path,
 * size and mtime (a render's sources and bound files are hashed once per change, not once per view), path forms the
 * contract accepts (project-relative, or `@out/…` for `out/<id>/`), and the canonical hashes decision ids and
 * `--expect` are built from.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { isSafeRelativePath, type MediaRef } from "../../../types/console";
import { FileMemo } from "../../file-memo";
import { MEDIA_TYPES, TEXT_TYPES } from "../media";
import { OUT_PREFIX } from "../urls";

export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** sha256 of a canonical JSON (object keys sorted) of `value`. */
export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

export function statOf(file: string): Stats | undefined {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** A JSON object, `undefined` when absent, or `"corrupt"` when the file exists but is not a JSON object. */
export function readJsonObject(file: string): Record<string, unknown> | undefined | "corrupt" {
  if (!statOf(file)?.isFile()) return undefined;
  const value = readJsonFile(file);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : "corrupt";
}

const HASH_MEMO_MAX = 20_000;
const hashMemo = new FileMemo<string | undefined>(HASH_MEMO_MAX);

const hashBytes = (file: string): string | undefined => {
  try {
    const hash = createHash("sha256");
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer))
        hash.update(buffer.subarray(0, read));
    } finally {
      closeSync(fd);
    }
    return hash.digest("hex");
  } catch {
    return undefined;
  }
};

/** Content hash of a regular file, memoised by (path, size, mtime, inode); undefined when absent or unreadable. */
export function hashFile(file: string): string | undefined {
  if (!statOf(file)?.isFile()) return undefined;
  return hashMemo.get(file, hashBytes);
}

/** Where a project's files live, absolute. */
export type ProjectPaths = { rootDir: string; projectDir: string; outDir: string; id: string };

export const projectPaths = (rootDir: string, id: string): ProjectPaths => ({
  rootDir,
  id,
  projectDir: path.join(rootDir, "public", "projects", id),
  outDir: path.join(rootDir, "out", id),
});

const posix = (value: string) => value.split(path.sep).join("/");

/**
 * The contract's form of a file: `{ root: "project", path }` inside `public/projects/<id>/`, `{ root: "out", path }`
 * inside `out/<id>/`, else undefined. Accepts absolute, root-relative (`public/projects/<id>/…`, `out/<id>/…`) and
 * asset-registry (`projects/<id>/…`) paths.
 */
export function locate(paths: ProjectPaths, file: string): { root: "project" | "out"; path: string } | undefined {
  let absolute: string;
  if (path.isAbsolute(file)) absolute = path.resolve(file);
  else if (file.startsWith(`projects/${paths.id}/`)) absolute = path.join(paths.rootDir, "public", file);
  else absolute = path.resolve(paths.rootDir, file);
  for (const [root, base] of [
    ["project", paths.projectDir],
    ["out", paths.outDir],
  ] as const) {
    const relative = posix(path.relative(base, absolute));
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && isSafeRelativePath(relative))
      return { root, path: relative };
  }
  return undefined;
}

/** A binding path: project-relative, or `@out/<path>` for a file under `out/<id>/` (the server's media convention). */
export const bindingPath = (where: { root: "project" | "out"; path: string }): string =>
  where.root === "out" ? `${OUT_PREFIX}/${where.path}` : where.path;

/** Absolute file of a binding path (inverse of {@link bindingPath}). */
export function bindingFile(paths: ProjectPaths, binding: string): string {
  return binding.startsWith(`${OUT_PREFIX}/`)
    ? path.join(paths.outDir, binding.slice(OUT_PREFIX.length + 1))
    : path.join(paths.projectDir, binding);
}

/** The kind of file offered by the media route. */
export function mediaKind(file: string): MediaRef["kind"] | undefined {
  const extension = path.extname(file).toLowerCase();
  if (TEXT_TYPES.has(extension)) return "document";
  const family = MEDIA_TYPES[extension]?.split("/", 1)[0];
  if (family === "text") return "document";
  if (family === "image" || family === "video" || family === "audio") return family;
  return undefined;
}

export const toIso = (ms: number): string => new Date(Math.max(0, Math.floor(ms))).toISOString();

/** A string bounded for a `Text(max)` field, or undefined. */
export const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
