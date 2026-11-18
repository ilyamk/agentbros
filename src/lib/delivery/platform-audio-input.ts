import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  writeSync,
  fsyncSync,
  mkdirSync,
  linkSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { randomUUID } from "node:crypto";
/** New native-handoff inputs only: finite same-FD hash, no aliases/FIFO, exact initial-size+growth probe. */
function consume(file: string, scope: string, maximum: number, onChunk?: (bytes: Buffer) => void) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 512 * 1024 * 1024)
    throw Error("Invalid native input bound");
  const absolute = path.resolve(file),
    root = path.resolve(scope),
    relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw Error("Native input escapes scope");
  const parents: { file: string; stat: Stats }[] = [];
  let directory = root;
  for (const part of [".", ...relative.split(path.sep).slice(0, -1)]) {
    directory = part === "." ? directory : path.join(directory, part);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Native input parent alias forbidden");
    parents.push({ file: directory, stat });
  }
  const before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum)
    throw Error("Native input must be bounded nonempty regular file");
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const same = (a: Stats, b: Stats) =>
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  try {
    const initial = fstatSync(fd);
    if (!initial.isFile() || !same(initial, before)) throw Error("Native input changed at open");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(Math.min(initial.size + 1, 65536));
    let count = 0;
    while (count < initial.size) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, initial.size - count), null);
      if (!bytes) throw Error("Native input shrank");
      hash.update(buffer.subarray(0, bytes));
      onChunk?.(buffer.subarray(0, bytes));
      count += bytes;
    }
    if (readSync(fd, buffer, 0, 1, null) !== 0 || !same(initial, fstatSync(fd)) || !same(initial, lstatSync(absolute)))
      throw Error("Native input changed during hash");
    for (const parent of parents) {
      const now = lstatSync(parent.file);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== parent.stat.dev || now.ino !== parent.stat.ino)
        throw Error("Native input parent changed");
    }
    return { sha256: hash.digest("hex"), bytes: count };
  } finally {
    closeSync(fd);
  }
}

export function readPlatformAudioPin(file: string, scope: string, maximum = 512 * 1024 * 1024) {
  return consume(file, scope, maximum);
}
export function readPlatformAudioJson(file: string, scope: string, maximum: number) {
  const chunks: Buffer[] = [];
  const pin = consume(file, scope, maximum, (chunk) => chunks.push(Buffer.from(chunk)));
  return {
    ...pin,
    value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown,
  };
}
/** Only computed packet paths. Exclusive publication retains any partial file on failure. */
export function platformAudioDirectory(directory: string, scope: string) {
  const relative = path.relative(path.resolve(scope), path.resolve(directory));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw Error("Packet directory escapes scope");
  let current = path.resolve(scope);
  const root = lstatSync(current);
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error("Packet root alias forbidden");
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      mkdirSync(current);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Packet directory alias forbidden");
  }
}
function publish(target: string, scope: string, expected: string, maximum: number, writer: (fd: number) => void) {
  const parent = path.dirname(target);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw Error("Packet parent alias forbidden");
  try {
    const existing = readPlatformAudioPin(target, scope, maximum);
    if (existing.sha256 !== expected) throw Error("Immutable packet conflict");
    return existing;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const temp = path.join(parent, ".pending-" + randomUUID()),
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      0o600,
    );
  try {
    writer(fd);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const actual = readPlatformAudioPin(temp, scope, maximum);
  if (actual.sha256 !== expected) throw Error("Packet copy source changed");
  const now = lstatSync(parent);
  if (now.dev !== parentStat.dev || now.ino !== parentStat.ino || now.isSymbolicLink())
    throw Error("Packet parent changed");
  try {
    linkSync(temp, target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (readPlatformAudioPin(target, scope, maximum).sha256 !== expected)
      throw Error("Immutable packet publication conflict");
  }
  if (readPlatformAudioPin(target, scope, maximum).sha256 !== expected)
    throw Error("Packet publication readback conflict");
  unlinkSync(temp);
  const dir = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
  return actual;
}
function writeAll(fd: number, bytes: Buffer) {
  let n = 0;
  while (n < bytes.length) {
    const count = writeSync(fd, bytes, n, bytes.length - n);
    if (count <= 0) throw Error("Packet write made no progress");
    n += count;
  }
}
export function writePlatformAudioBytes(target: string, scope: string, bytes: Buffer, maximum = 1024 * 1024) {
  if (!bytes.length || bytes.length > maximum) throw Error("Packet document byte bound exceeded");
  const hash = createHash("sha256").update(bytes).digest("hex");
  return publish(target, scope, hash, maximum, (fd) => writeAll(fd, bytes));
}
export function copyPlatformAudioFile(
  source: string,
  sourceScope: string,
  target: string,
  targetScope: string,
  expected: string,
  maximum = 512 * 1024 * 1024,
) {
  const before = readPlatformAudioPin(source, sourceScope, maximum);
  if (before.sha256 !== expected) throw Error("Packet source stale");
  return publish(target, targetScope, expected, maximum, (fd) => {
    const pin = consume(source, sourceScope, maximum, (bytes) => writeAll(fd, bytes));
    if (pin.sha256 !== expected) throw Error("Packet source changed during copy");
  });
}
