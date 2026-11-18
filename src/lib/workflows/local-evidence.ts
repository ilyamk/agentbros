import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
/** Bounded regular-FD evidence read. No aliases within the project, no FIFO blocking, hash/excerpt use the same bytes. */
export function readWorkflowEvidence(file: string, project: string, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024)
    throw new Error("Invalid evidence byte bound");
  const scope = path.resolve(project),
    absolute = path.resolve(file),
    relative = path.relative(scope, absolute);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("Evidence must remain inside its project");
  const parents: { file: string; stat: Stats }[] = [];
  const parts = relative.split(path.sep);
  let directory = scope;
  for (const part of [".", ...parts.slice(0, -1)]) {
    directory = part === "." ? directory : path.join(directory, part);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Evidence parent aliases/non-directories are forbidden");
    parents.push({ file: directory, stat });
  }
  const rootReal = realpathSync(scope),
    resolved = realpathSync(absolute);
  const realRelative = path.relative(rootReal, resolved);
  if (
    !realRelative ||
    realRelative === ".." ||
    realRelative.startsWith(".." + path.sep) ||
    path.isAbsolute(realRelative)
  )
    throw new Error("Evidence escapes project realpath");
  const before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Evidence must be a regular file without aliases");
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const same = (a: Stats, b: Stats) =>
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      !same(before, stat) ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0 ||
      stat.size > maxBytes
    )
      throw new Error("Evidence identity/size invalid");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes !== stat.size || !same(stat, fstatSync(fd)) || !same(stat, lstatSync(absolute)))
      throw new Error("Evidence changed during read");
    for (const parent of parents) {
      const current = lstatSync(parent.file);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== parent.stat.dev ||
        current.ino !== parent.stat.ino
      )
        throw new Error("Evidence parent changed during read");
    }
    const data = buffer.subarray(0, bytes),
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return { text, sha256: createHash("sha256").update(data).digest("hex"), path: absolute, byteLength: data.length };
  } finally {
    closeSync(fd);
  }
}

/** Presence includes broken aliases so a supplied invalid artifact cannot masquerade as omission. */
export function workflowEvidenceExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
