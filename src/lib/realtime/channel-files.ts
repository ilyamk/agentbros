import path from "node:path";
import {
  constants,
  openSync,
  closeSync,
  readSync,
  writeFileSync,
  fstatSync,
  lstatSync,
  linkSync,
  unlinkSync,
  fsyncSync,
  mkdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { digest } from "../jobs/model-artifacts";
export function channelBoundary(root: string, file: string) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
    throw Error("Local channel path outside root");
  let at = root;
  for (const part of relative.split(path.sep)) {
    at = path.join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) throw Error("Local channel symlink refused");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
export function channelRead(root: string, file: string, maximum: number) {
  channelBoundary(root, file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximum) throw Error("Local channel regular byte bound exceeded");
    const bytes = Buffer.alloc(before.size);
    let at = 0;
    while (at < bytes.length) {
      const n = readSync(fd, bytes, at, bytes.length - at, null);
      if (!n) throw Error("Local channel file truncated");
      at += n;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw Error("Local channel file grew");
    const after = fstatSync(fd),
      lexical = lstatSync(file);
    if (
      !lexical.isFile() ||
      lexical.isSymbolicLink() ||
      lexical.dev !== before.dev ||
      lexical.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error("Local channel file changed");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function channelJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function channelWrite(root: string, file: string, value: unknown) {
  channelBoundary(root, file);
  mkdirSync(path.dirname(file), { recursive: true });
  channelBoundary(root, file);
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 65536) throw Error("Local channel receipt exceeds 64KiB");
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, file);
    const fdDir = openSync(path.dirname(file), "r");
    try {
      fsyncSync(fdDir);
    } finally {
      closeSync(fdDir);
    }
  } finally {
    if (created) unlinkSync(temporary);
  }
  return digest(bytes);
}
