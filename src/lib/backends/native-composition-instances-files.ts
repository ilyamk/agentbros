import { openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync, constants } from "node:fs";
import path from "node:path";
import { digest } from "../jobs/model-artifacts";
/** New profile only: one bounded nonblocking regular descriptor, exact EOF/path identity. */
export function snapshotInstanceFile(file: string, root: string, maximum: number) {
  root = realpathSync(root);
  file = path.resolve(file);
  if (process.platform === "darwin")
    for (const alias of ["/var", "/tmp"])
      if ((file === alias || file.startsWith(alias + path.sep)) && realpathSync(alias) === "/private" + alias)
        file = "/private" + file;
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw Error("Instance source escapes root");
  for (let part = file; part !== root; part = path.dirname(part))
    if (lstatSync(part).isSymbolicLink()) throw Error("Instance symlink source");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > maximum)
      throw Error("Instance bounded regular source required");
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const read = readSync(fd, data, offset, data.length - offset, offset);
      if (!read) throw Error("Instance source truncated");
      offset += read;
    }
    const after = fstatSync(fd),
      lexical = lstatSync(file),
      extra = Buffer.alloc(1);
    if (
      readSync(fd, extra, 0, 1, offset) !== 0 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.dev !== lexical.dev ||
      before.ino !== lexical.ino ||
      !lexical.isFile() ||
      lexical.isSymbolicLink()
    )
      throw Error("Instance source changed while reading");
    return { data, sha256: digest(data), bytes: data.length };
  } finally {
    closeSync(fd);
  }
}
