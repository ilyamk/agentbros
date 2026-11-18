import { constants, openSync, closeSync, fstatSync, readSync, realpathSync, lstatSync, type Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const LOCAL_MEDIA_PROTOCOLS = "file,pipe";
export const MEDIA_PROBE_TIMEOUT_MS = 30000;
export const LOCAL_AUDIO_TIMEOUT_MS = 7200000;

/** Open before inspecting: a FIFO or a racing FIFO replacement must not block. */
function openRegular(file: string) {
  if (!file || (/^[a-z][a-z0-9+.-]*:/i.test(file) && !path.isAbsolute(file)))
    throw new Error("Local audio input must be a filesystem path");
  const absolute = path.resolve(file);
  const before = lstatSync(absolute);
  if (before.isSymbolicLink()) throw new Error(`Local audio input must not be a final symlink: ${file}`);
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Local audio input must be a regular file: ${file}`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0)
      throw new Error("Local audio input size exceeds safe limits");
    assertSourceIdentity(absolute, fd, before);
    return { fd, stat, absolute };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertSourceIdentity(file: string, fd: number, initial: Stats) {
  const descriptor = fstatSync(fd);
  let current: Stats;
  try {
    current = lstatSync(file);
  } catch {
    throw new Error("Local audio source changed during read");
  }
  for (const stat of [descriptor, current]) {
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.dev !== initial.dev ||
      stat.ino !== initial.ino ||
      stat.size !== initial.size ||
      stat.mtimeMs !== initial.mtimeMs ||
      stat.ctimeMs !== initial.ctimeMs
    )
      throw new Error("Local audio source changed during read");
  }
}

export function assertRegularLocalInput(file: string) {
  const { fd, absolute } = openRegular(file);
  closeSync(fd);
  return absolute;
}
export function localInputHash(file: string) {
  const { fd, stat } = openRegular(file);
  try {
    const hash = createHash("sha256"),
      buffer = Buffer.allocUnsafe(65536);
    let bytes = 0;
    while (bytes < stat.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - bytes), null);
      if (count === 0) throw new Error("Local audio source changed during fingerprint capture");
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    // A growing producer cannot extend the loop beyond captured size + this probe.
    const growth = readSync(fd, buffer, 0, 1, null);
    assertSourceIdentity(file, fd, stat);
    if (growth !== 0) throw new Error("Local audio source changed during fingerprint capture");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
export function readLocalJson(file: string, maxBytes = 4 * 1024 * 1024): unknown {
  const { fd, stat } = openRegular(file);
  try {
    if (stat.size > maxBytes) throw new Error("Local audio metadata exceeds its size bound");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0,
      count: number;
    while (bytes < buffer.length && (count = readSync(fd, buffer, bytes, buffer.length - bytes, null)) > 0)
      bytes += count;
    if (bytes !== stat.size) throw new Error("Local audio metadata changed during read");
    assertSourceIdentity(file, fd, stat);
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
export function localPublicSource(file: string, rootDir: string) {
  const publicRoot = realpathSync(path.join(rootDir, "public"));
  const absolute = realpathSync(assertRegularLocalInput(file));
  const relative = path.relative(publicRoot, absolute);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("Project audio source must remain inside public");
  return relative.split(path.sep).join("/");
}
export function audioChildTimeout(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > LOCAL_AUDIO_TIMEOUT_MS)
    throw new Error("Invalid local audio child timeout");
  return value;
}
