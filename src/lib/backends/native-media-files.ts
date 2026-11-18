import { openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
/** No aliases/FIFO/growing-file EOF; bounded exact descriptor identity. */
export function nativeFilePin(file: string, root: string, maximum = 64 * 1024 * 1024, captureBytes = false) {
  root = realpathSync(root);
  let absolute = path.resolve(file);
  if (process.platform === "darwin")
    for (const alias of ["/var", "/tmp"])
      if ((absolute === alias || absolute.startsWith(alias + path.sep)) && realpathSync(alias) === "/private" + alias)
        absolute = "/private" + absolute;
  const relative = path.relative(root, absolute);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw Error("Native preparation path escapes staging");
  let current = absolute;
  while (current !== root) {
    if (lstatSync(current).isSymbolicLink()) throw Error("Native preparation symlink forbidden");
    current = path.dirname(current);
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = fstatSync(fd);
    if (!initial.isFile() || initial.size <= 0 || initial.size > maximum)
      throw Error("Native preparation requires bounded regular file");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024),
      chunks: Buffer[] = [];
    if (captureBytes && maximum > 2 * 1024 * 1024) throw Error("Native JSON read exceeds bound");
    let offset = 0;
    while (offset < initial.size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, initial.size - offset), offset);
      if (n === 0) throw Error("Native preparation file truncated");
      hash.update(buffer.subarray(0, n));
      if (captureBytes) chunks.push(Buffer.from(buffer.subarray(0, n)));
      offset += n;
    }
    const final = fstatSync(fd),
      lexical = lstatSync(absolute);
    if (
      readSync(fd, buffer, 0, 1, offset) !== 0 ||
      initial.size !== final.size ||
      initial.mtimeMs !== final.mtimeMs ||
      initial.ctimeMs !== final.ctimeMs ||
      initial.ino !== lexical.ino ||
      initial.dev !== lexical.dev ||
      !lexical.isFile() ||
      lexical.isSymbolicLink()
    )
      throw Error("Native preparation file changed while hashing");
    return {
      path: relative.split(path.sep).join("/"),
      bytes: initial.size,
      sha256: hash.digest("hex"),
      ...(captureBytes ? { data: Buffer.concat(chunks) } : {}),
    };
  } finally {
    closeSync(fd);
  }
}

export function readNativeJson(file: string, root: string, maximum = 256 * 1024) {
  return JSON.parse(nativeFilePin(file, root, maximum, true).data!.toString());
}
