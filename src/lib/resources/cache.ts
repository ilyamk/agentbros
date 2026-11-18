import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

const object = z.record(z.string(), z.unknown());
const cacheEntry = z.object({ at: z.number(), value: object }).strict();

export type ResponseCacheOptions = {
  /** Time a stored response stays fresh. */
  ttlMs: number;
  now?: () => number;
  /** Disk directory; undefined keeps the cache in memory only. */
  directory?: string;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
};

/**
 * Bounded metadata cache shared by resource clients: memory LRU, optional private disk copy
 * (0600 files, atomic rename, oldest pruned) and coalesced in-flight requests.
 * Keys come from `cacheKey`, which drops credential query parameters so secrets never reach disk.
 */
export class ResponseCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly directory?: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly memory = new Map<string, { at: number; value: Record<string, unknown>; bytes: number }>();
  private memoryBytes = 0;
  private readonly pending = new Map<string, Promise<Record<string, unknown>>>();
  constructor(options: ResponseCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw Error("Cache TTL must be positive.");
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.directory = options.directory;
    this.maxEntries = options.maxEntries ?? 500;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.maxEntryBytes = options.maxEntryBytes ?? 4 * 1024 * 1024;
  }
  private file(key: string) {
    return this.directory && path.join(this.directory, `${key}.json`);
  }
  get(key: string): Record<string, unknown> | undefined {
    let entry: { at: number; value: Record<string, unknown> } | undefined = this.memory.get(key);
    const file = this.file(key);
    if (!entry && file && existsSync(file)) {
      try {
        const stat = lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= this.maxEntryBytes + 1024)
          entry = cacheEntry.parse(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        /* An invalid cache entry is a miss. */
      }
    }
    if (!entry || entry.at > this.now() || this.now() - entry.at >= this.ttlMs) return undefined;
    return structuredClone(entry.value);
  }
  set(key: string, value: Record<string, unknown>) {
    const entry = { at: this.now(), value };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    this.memoryBytes -= this.memory.get(key)?.bytes ?? 0;
    this.memory.delete(key);
    this.memory.set(key, { ...entry, bytes });
    this.memoryBytes += bytes;
    while (this.memory.size > this.maxEntries || this.memoryBytes > this.maxBytes) {
      const oldest = this.memory.keys().next().value!;
      this.memoryBytes -= this.memory.get(oldest)!.bytes;
      this.memory.delete(oldest);
    }
    const file = this.file(key);
    if (!file) return;
    let temporary: string | undefined;
    try {
      mkdirSync(this.directory!, { recursive: true, mode: 0o700 });
      if (lstatSync(this.directory!).isSymbolicLink()) return;
      temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
      temporary = undefined;
      const rows = readdirSync(this.directory!)
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => ({ name, stat: lstatSync(path.join(this.directory!, name)) }))
        .filter((row) => row.stat.isFile())
        .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
      let total = rows.reduce((sum, row) => sum + row.stat.size, 0),
        count = rows.length;
      for (const row of rows) {
        if (total <= this.maxBytes && count <= this.maxEntries) break;
        unlinkSync(path.join(this.directory!, row.name));
        total -= row.stat.size;
        count--;
      }
    } catch {
      /* Cache availability must not turn public discovery into a failure. */
    } finally {
      if (temporary && existsSync(temporary)) unlinkSync(temporary);
    }
  }
  /** Cached value, else one shared load for concurrent callers; `fresh` bypasses and does not store. */
  async through(
    key: string,
    load: () => Promise<Record<string, unknown>>,
    options: { fresh?: boolean } = {},
  ): Promise<Record<string, any>> {
    if (options.fresh) return structuredClone(await load());
    const value = this.get(key);
    if (value) return value;
    const pending = this.pending.get(key);
    if (pending) return structuredClone(await pending);
    const work = load();
    this.pending.set(key, work);
    try {
      const loaded = await work;
      this.set(key, loaded);
      return structuredClone(loaded);
    } finally {
      this.pending.delete(key);
    }
  }
}

/** Stable sha256 of a URL with sorted query and the named credential parameters removed. */
export function cacheKey(url: string, secretParams: readonly string[] = []): string {
  const parsed = new URL(url);
  for (const name of secretParams) parsed.searchParams.delete(name);
  parsed.searchParams.sort();
  return createHash("sha256").update(parsed.toString()).digest("hex");
}
