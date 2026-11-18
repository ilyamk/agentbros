/**
 * Results computed from a file's bytes (a content hash, an ffprobe), memoised per process by the file's identity:
 * path, size, mtime and inode. A changed, replaced or removed file recomputes; an unreadable one is never cached.
 * Long-lived readers (the console's projector rebuilding a view on every change) use it so a large recording or render
 * is hashed and probed once, not on every rebuild.
 */
import { statSync } from "node:fs";
import path from "node:path";

/** `size:mtimeMs:ino` of a stat result: the key {@link FileMemo} compares. */
export const fileIdentity = (info: { size: number; mtimeMs: number; ino: number }) =>
  `${info.size}:${info.mtimeMs}:${info.ino}`;

const identity = (file: string): string | undefined => {
  try {
    const info = statSync(file);
    return info.isFile() ? fileIdentity(info) : undefined;
  } catch {
    return undefined;
  }
};

export class FileMemo<T> {
  private readonly entries = new Map<string, { key: string; value: T }>();
  constructor(private readonly max = 512) {}

  /** `compute(file)` for the file as it is now, from the memo when its identity is unchanged. */
  get(file: string, compute: (file: string) => T, variant = ""): T {
    const absolute = path.resolve(file);
    const key = identity(absolute);
    if (key === undefined) return compute(file);
    const slot = `${absolute}\0${variant}`;
    const known = this.entries.get(slot);
    if (known?.key === key) {
      this.entries.delete(slot);
      this.entries.set(slot, known);
      return known.value;
    }
    const value = compute(file);
    // A file rewritten while it was read is not cached under the old identity.
    if (identity(absolute) !== key) return value;
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(slot, { key, value });
    return value;
  }

  /** The memoised value when the file's identity still equals `expected` (`size:mtimeMs:ino`), else undefined. */
  peek(file: string, expected: string, variant = ""): T | undefined {
    const known = this.entries.get(`${path.resolve(file)}\0${variant}`);
    return known?.key === expected && identity(path.resolve(file)) === expected ? known.value : undefined;
  }

  /** Stores a value computed elsewhere (e.g. asynchronously) for the identity it was computed from. */
  set(file: string, expected: string, value: T, variant = ""): void {
    const absolute = path.resolve(file);
    if (identity(absolute) !== expected) return;
    const slot = `${absolute}\0${variant}`;
    this.entries.delete(slot);
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(slot, { key: expected, value });
  }

  clear(): void {
    this.entries.clear();
  }
}
