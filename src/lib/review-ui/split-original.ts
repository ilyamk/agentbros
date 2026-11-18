import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const LIMIT = 128 * 1024 * 1024;
const crc32 = (bytes: Buffer) => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
};
export function assertStaticImageBytes(file: string, bytes: Buffer) {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    if (
      bytes.length < 4 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes[2] !== 0xff ||
      bytes[bytes.length - 2] !== 0xff ||
      bytes[bytes.length - 1] !== 0xd9
    )
      throw Error("Split requires a static JPEG signature matching the imported extension");
    return;
  }
  if (extension !== ".png" || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw Error("Split image supports static PNG/JPEG only; unknown/animated formats are unavailable");
  let offset = 8,
    header = false,
    data = false,
    ended = false;
  while (offset < bytes.length) {
    if (ended || bytes.length - offset < 12) throw Error("Malformed static PNG chunk stream");
    const length = bytes.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw Error("Malformed static PNG chunk length");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4))
      throw Error("Malformed static PNG chunk checksum");
    if (["acTL", "fcTL", "fdAT"].includes(type))
      throw Error("Animated PNG cannot preserve split phase; use a static original");
    if (!header) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        bytes.readUInt32BE(offset + 8) === 0 ||
        bytes.readUInt32BE(offset + 12) === 0
      )
        throw Error("Malformed static PNG header");
      header = true;
    } else if (type === "IHDR") throw Error("Malformed duplicate PNG header");
    if (type[0] === type[0].toUpperCase() && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type))
      throw Error("Unsupported critical PNG chunk");
    if (type === "IDAT") data = true;
    if (type === "IEND") {
      if (length !== 0 || !data) throw Error("Malformed PNG end");
      ended = true;
    }
    offset = end;
  }
  if (!ended) throw Error("Malformed incomplete PNG chunk stream");
}
/** Preparation-only evidence check. Existing generic Apply remains revision-bound;
 * render-plan separately verifies original SHA before render. No source-safe transaction claim. */
export function assertSplitOriginal(file: string, expectedHash: string, kind: "image" | "video") {
  const initial = lstatSync(file);
  if (initial.isSymbolicLink()) throw Error("Split original must not be a symlink");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd),
      identity = (s: typeof stat) => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > LIMIT)
      throw Error("Split original requires a regular file within128MiB");
    if (identity(stat) !== identity(initial)) throw Error("Split original changed before reading");
    const sha = createHash("sha256"),
      buffer = Buffer.allocUnsafe(65536),
      chunks: Buffer[] = [];
    let offset = 0;
    while (offset < stat.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), null);
      if (n === 0) throw Error("Split original changed during read");
      const chunk = buffer.subarray(0, n);
      sha.update(chunk);
      if (kind === "image") chunks.push(Buffer.from(chunk));
      offset += n;
    }
    const growth = readSync(fd, buffer, 0, 1, null),
      after = fstatSync(fd),
      current = lstatSync(file);
    if (
      growth ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      identity(after) !== identity(stat) ||
      identity(current) !== identity(stat)
    )
      throw Error("Split original changed during read");
    if (sha.digest("hex") !== expectedHash) throw Error("Immutable split original checksum mismatch");
    if (kind === "image") assertStaticImageBytes(file, Buffer.concat(chunks, stat.size));
    const finalDescriptor = fstatSync(fd),
      finalPath = lstatSync(file);
    if (
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      identity(finalDescriptor) !== identity(stat) ||
      identity(finalPath) !== identity(stat)
    )
      throw Error("Split original changed during format validation");
  } finally {
    closeSync(fd);
  }
}
