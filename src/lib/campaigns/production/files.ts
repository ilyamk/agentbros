import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileIdentity, FileMemo } from "../../file-memo";
import { assertPathWithin, CliErrorObject } from "../../cli";
import { CampaignId, CampaignProjectId, type CampaignFile } from "../../../types/campaign-production";
import { stableHash } from "../../longform/plans";

export const digest = stableHash;
export function refuse(message: string): never {
  throw new CliErrorObject({ code: "VALIDATION", message });
}
export function projectDirectory(root: string, id: string) {
  CampaignProjectId.parse(id);
  const directory = path.resolve(root, "public/projects", id);
  assertPathWithin(path.resolve(root, "public/projects"), directory);
  if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink())
    refuse("Campaign project ownership cannot use a directory symlink");
  return directory;
}
export const productionDirectory = (root: string, id: string) =>
  path.join(projectDirectory(root, id), "pipeline/campaign-production");
export function scopedFile(root: string, file: string) {
  const resolved = path.resolve(root, file);
  assertPathWithin(path.resolve(root), resolved);
  if (lstatSync(resolved, { throwIfNoEntry: false })?.isSymbolicLink()) refuse(`Symlinked campaign file: ${file}`);
  return resolved;
}
/**
 * Content hashes memoised by file identity (path, size, mtime, inode): long-lived readers (the console's campaign
 * review) re-verify unchanged pins with a stat instead of re-reading every render. A changed file is re-hashed.
 */
const hashes = new FileMemo<string>(4096);
export function fileHash(file: string) {
  return hashes.get(file, hashFileNow);
}

/**
 * Hashes the open descriptor `fd` of `file` asynchronously (streamed, positional) unless its identity is already
 * memoised, and memoises the result when the path still names the same file. Refuses a file that changes meanwhile.
 * `fd` stays open (the caller owns it).
 */
export async function fileHashAsync(file: string, fd: number, label = path.basename(file)): Promise<string> {
  const before = fstatSync(fd);
  if (!before.isFile()) refuse(`Not a regular file: ${label}`);
  const key = fileIdentity(before);
  const known = hashes.peek(file, key);
  if (known) return known;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream("", { fd, start: 0, autoClose: false, highWaterMark: 1024 * 1024 }))
    hash.update(chunk as Buffer);
  const after = fstatSync(fd);
  if (fileIdentity(after) !== key || after.ctimeMs !== before.ctimeMs)
    refuse(`Campaign file changed while reading: ${label}`);
  const value = hash.digest("hex");
  hashes.set(file, key, value);
  return value;
}

function hashFileNow(file: string) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) refuse(`Not a regular file: ${file}`);
    let size: number;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      refuse(`Campaign file changed while reading: ${file}`);
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
export function pinFile(root: string, file: string): CampaignFile {
  const resolved = scopedFile(root, file);
  return { path: path.relative(root, resolved), sha256: fileHash(resolved) };
}
export function verifyPin(root: string, pin: CampaignFile) {
  const resolved = scopedFile(root, pin.path);
  if (fileHash(resolved) !== pin.sha256) refuse(`Stale campaign input: ${pin.path}`);
  return resolved;
}
export function jsonFile(file: string): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      refuse("Campaign JSON must be a regular file no larger than 16 MiB");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
export function immutableJson(file: string, value: unknown) {
  if (existsSync(file)) {
    if (digest(jsonFile(file)) !== digest(value)) refuse(`Immutable campaign content differs: ${file}`);
    return file;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`,
    fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    try {
      linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return immutableJson(file, value);
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return file;
}
export function atomicJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
/** Reclaim only a proved-dead local process; elapsed time alone never transfers work. */
export function acquireLock(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600),
        token = randomUUID();
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      closeSync(fd);
      return () => {
        if (existsSync(file) && (jsonFile(file) as { token?: string }).token === token) unlinkSync(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const recovery = `${file}.recovery`;
      let fd: number;
      try {
        fd = openSync(recovery, "wx", 0o600);
      } catch {
        return null;
      }
      try {
        if (!existsSync(file)) continue;
        const owner = jsonFile(file) as { pid?: number };
        if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) return null;
        try {
          process.kill(owner.pid!, 0);
          return null;
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== "ESRCH") return null;
        }
        unlinkSync(file);
      } finally {
        closeSync(fd);
        unlinkSync(recovery);
      }
    }
  }
  return null;
}
export function locked<T>(file: string, work: () => T): T {
  const release = acquireLock(file);
  if (!release) throw new CliErrorObject({ code: "VALIDATION", message: `Campaign writer is busy: ${file}` });
  try {
    return work();
  } finally {
    release();
  }
}
export function isCampaignOwner(directory: string) {
  const file = path.join(directory, "pipeline/campaign-production/owner.json");
  if (!existsSync(file)) return false;
  const value = jsonFile(file) as { version?: unknown; campaignId?: unknown };
  return (
    value.version === 1 &&
    value.campaignId === path.basename(directory) &&
    CampaignId.safeParse(value.campaignId).success
  );
}
