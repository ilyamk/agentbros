/**
 * Thumbnails and single frames (RFC 0004 §9.1 `/thumb/:id/*path?t=&w=`, FR7): one ffmpeg frame as JPEG, cached in
 * `out/console/cache/thumbs/` under a key made of the file's content hash and the parameters, so a re-render under the
 * same name never shows a stale frame. A missing ffmpeg is a 503 `FFMPEG_MISSING` JSON error.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import path from "node:path";
import { CONSOLE_CACHE_DIR } from "../../types/console";
import { HttpError } from "../local-server/errors";
import type { ResolvedMedia } from "./media";

export const THUMB_DEFAULT_WIDTH = 480;
/** Widths are rounded up to one of these, so a client cannot fill the cache with every width. */
export const THUMB_WIDTHS = [96, 160, 240, 320, 480, 640, 960, 1280, 1920] as const;
/** Times are rounded to this step (seconds) and clamped to the video's duration. */
export const THUMB_TIME_STEP = 0.1;
const THUMB_MAX_TIME = 24 * 3600;
const THUMB_TIMEOUT_MS = 8000;
const MAX_CONCURRENT = 2;

export interface ThumbnailOptions {
  rootDir: string;
  /** ffmpeg executable (default `ffmpeg` on PATH). */
  ffmpeg?: string;
  /** ffprobe executable (default: next to `ffmpeg`, else `ffprobe` on PATH). */
  ffprobe?: string;
  timeoutMs?: number;
  /** Requests waiting for an ffmpeg slot beyond this are refused with 503 `BUSY` (default 16). */
  maxQueue?: number;
  /** Cache caps, least recently used first out (default 2000 files, 256 MiB). */
  maxCacheFiles?: number;
  maxCacheBytes?: number;
}

/** Streams the file through SHA-256. */
export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** The smallest bucket at least `w` wide (the largest when `w` exceeds them all). */
export const widthBucket = (w: number) => THUMB_WIDTHS.find((bucket) => bucket >= w) ?? THUMB_WIDTHS.at(-1)!;

/** `t` rounded to the step and clamped to [0, duration - step]. */
export function quantizeTime(t: number, durationSec: number | undefined): number {
  const last = durationSec !== undefined && durationSec > 0 ? Math.max(0, durationSec - THUMB_TIME_STEP) : t;
  const steps = Math.round(Math.min(Math.max(0, t), last) / THUMB_TIME_STEP);
  return Number((steps * THUMB_TIME_STEP).toFixed(3));
}

const missing = () => new HttpError(503, "FFMPEG_MISSING", "ffmpeg is not installed (brew install ffmpeg).");

export class ThumbnailService {
  readonly cacheDir: string;
  private readonly hashes = new Map<string, Promise<string>>();
  private readonly durations = new Map<string, Promise<number | undefined>>();
  private readonly inflight = new Map<string, Promise<string>>();
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly options: ThumbnailOptions) {
    this.cacheDir = path.join(options.rootDir, CONSOLE_CACHE_DIR, "thumbs");
  }

  private get ffprobe(): string {
    if (this.options.ffprobe) return this.options.ffprobe;
    const ffmpeg = this.options.ffmpeg;
    return ffmpeg && path.isAbsolute(ffmpeg) ? path.join(path.dirname(ffmpeg), "ffprobe") : "ffprobe";
  }

  /** Content hash, memoised (and shared while in flight) by path, size, mtime and inode. */
  contentHash(file: string): Promise<string> {
    const info = statSync(file);
    const key = `${file}\0${info.size}\0${info.mtimeMs}\0${info.ino}`;
    const known = this.hashes.get(key);
    if (known) return known;
    if (this.hashes.size > 5000) this.hashes.clear();
    // One pass per file version, shared by concurrent requests (a frame strip asks for many frames at once).
    const pending = hashFile(file);
    this.hashes.set(key, pending);
    pending.catch(() => this.hashes.delete(key));
    return pending;
  }

  /** Container duration in seconds via ffprobe, memoised by content hash. */
  duration(file: string, content: string): Promise<number | undefined> {
    const known = this.durations.get(content);
    if (known) return known;
    if (this.durations.size > 5000) this.durations.clear();
    const pending = new Promise<number | undefined>((resolve, reject) => {
      execFile(
        this.ffprobe,
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file],
        { shell: false, timeout: this.options.timeoutMs ?? THUMB_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return reject(missing());
          const value = Number(String(stdout).trim());
          resolve(!error && Number.isFinite(value) && value > 0 ? value : undefined);
        },
      );
    });
    this.durations.set(content, pending);
    pending.catch(() => this.durations.delete(content));
    return pending;
  }

  /** The cached JPEG for `media` near `t` seconds, about `w` pixels wide (quantized), made on first request. */
  async thumbnail(media: ResolvedMedia, query: { t?: number; w?: number }): Promise<string> {
    const video = media.contentType.startsWith("video/");
    if (!video && !media.contentType.startsWith("image/"))
      throw new HttpError(400, "INVALID_INPUT", "Thumbnails exist for video and image files only");
    const requested = query.t ?? 0;
    if (!Number.isFinite(requested) || requested < 0 || requested > THUMB_MAX_TIME)
      throw new HttpError(400, "INVALID_INPUT", "t must be a time in seconds within the video");
    const w = widthBucket(query.w ?? THUMB_DEFAULT_WIDTH);
    const content = await this.contentHash(media.file);
    const t = video ? quantizeTime(requested, await this.duration(media.file, content)) : 0;
    const key = createHash("sha256").update(`v2|${content}|t=${t}|w=${w}`).digest("hex");
    const target = path.join(this.cacheDir, key.slice(0, 2), `${key}.jpg`);
    if (existsSync(target)) {
      try {
        const now = new Date();
        utimesSync(target, now, now); // least recently used goes first
      } catch {
        // pruned meanwhile; served or rebuilt below
      }
      if (existsSync(target)) return target;
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.limited(() => this.extract(media.file, target, video ? t : undefined, w)).finally(() =>
        this.inflight.delete(key),
      );
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async limited<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_CONCURRENT) {
      if (this.queue.length >= (this.options.maxQueue ?? 16))
        throw new HttpError(503, "BUSY", "Too many thumbnails are being made; retry shortly.");
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  /** Removes the least recently used thumbnails beyond the file and byte caps. */
  prune(): void {
    const maxFiles = this.options.maxCacheFiles ?? 2000;
    const maxBytes = this.options.maxCacheBytes ?? 256 * 1024 * 1024;
    const files: Array<{ file: string; size: number; mtimeMs: number }> = [];
    try {
      for (const dir of readdirSync(this.cacheDir)) {
        const sub = path.join(this.cacheDir, dir);
        for (const name of readdirSync(sub)) {
          if (!name.endsWith(".jpg") || name.includes(".tmp")) continue;
          const info = statSync(path.join(sub, name));
          files.push({ file: path.join(sub, name), size: info.size, mtimeMs: info.mtimeMs });
        }
      }
    } catch {
      return;
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let bytes = files.reduce((sum, entry) => sum + entry.size, 0);
    let count = files.length;
    for (const entry of files) {
      if (count <= maxFiles && bytes <= maxBytes) break;
      rmSync(entry.file, { force: true });
      count--;
      bytes -= entry.size;
    }
  }

  private extract(file: string, target: string, t: number | undefined, w: number): Promise<string> {
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp.jpg`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...(t !== undefined ? ["-ss", String(t)] : []),
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      `scale=${w}:-2`,
      "-q:v",
      "4",
      "-y",
      temporary,
    ];
    return new Promise((resolve, reject) => {
      execFile(
        this.options.ffmpeg ?? "ffmpeg",
        args,
        { shell: false, timeout: this.options.timeoutMs ?? THUMB_TIMEOUT_MS, windowsHide: true },
        (error) => {
          try {
            const made = existsSync(temporary) && statSync(temporary).size > 0;
            if (error || !made) {
              rmSync(temporary, { force: true });
              const code = (error as NodeJS.ErrnoException | null)?.code;
              if (code === "ENOENT") reject(missing());
              else if (!error) reject(new HttpError(400, "INVALID_INPUT", "No frame at that time"));
              else reject(new HttpError(500, "FFMPEG_FAILED", "ffmpeg could not extract a frame"));
              return;
            }
            renameSync(temporary, target);
            this.prune();
            resolve(target);
          } catch {
            // A failed rename or stat (disk full, permissions) fails this request, never the server.
            try {
              rmSync(temporary, { force: true });
            } catch {
              // nothing more to do
            }
            reject(new HttpError(500, "INTERNAL", "The thumbnail could not be stored"));
          }
        },
      );
    });
  }
}
