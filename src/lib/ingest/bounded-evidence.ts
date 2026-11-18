import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
/** Trusted reader, not a serializable option/callback. Capture finite original bytes, never follow growth. */
function capture(file: string, maximum: number, retain: boolean) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(fd),
      identity = (s: Stats) => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]);
    if (!initial.isFile() || !Number.isSafeInteger(initial.size) || initial.size < 0 || initial.size > maximum)
      throw new Error("Evidence requires bounded regular original");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536),
      chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes < initial.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, initial.size - bytes), null);
      if (!n) throw new Error("Evidence changed during read");
      bytes += n;
      hash.update(buffer.subarray(0, n));
      if (retain) chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    if (
      readSync(fd, buffer, 0, 1, null) !== 0 ||
      identity(fstatSync(fd)) !== identity(initial) ||
      identity(lstatSync(file)) !== identity(initial)
    )
      throw new Error("Evidence changed during read");
    return { hash: hash.digest("hex"), bytes: retain ? Buffer.concat(chunks) : undefined };
  } finally {
    closeSync(fd);
  }
}
export function boundedEvidenceHash(file: string, maximum = 32 * 1024 ** 3) {
  return capture(file, maximum, false).hash;
}
export function boundedEvidenceJson(file: string, maximum = 16 * 1024 * 1024) {
  const result = capture(file, maximum, true);
  return { value: JSON.parse(result.bytes!.toString("utf8")), hash: result.hash };
}
