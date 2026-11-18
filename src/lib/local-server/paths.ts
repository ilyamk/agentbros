/**
 * Path confinement for files a loopback server reads (RFC 0004 D15): request paths are split without URL
 * normalisation, every decoded segment is checked, every existing segment is lstat'ed (no symlinks anywhere below the
 * base), and the file is opened with `O_NOFOLLOW` and must be a regular file.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { forbidden, HttpError, notFound } from "./errors";

/**
 * A safe relative POSIX path: non-empty, at most 1024 characters, no leading `/`, no backslash, no drive or scheme,
 * no control character, no empty, `.` or `..` segment (same rule as `isSafeRelativePath` in src/types/console.ts).
 */
export function isSafeRelativePath(value: string): boolean {
  if (!value || value.length > 1024) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Splits a raw request target into decoded path segments and the query, without the WHATWG normalisation that would
 * silently turn `/a/../b` or `/a/%2e%2e/b` into `/b`. A segment that decodes to something containing `/` stays one
 * segment, so callers that join segments must re-check them ({@link isSafeRelativePath}). Malformed escapes are 400.
 */
export function splitRequestTarget(rawUrl: string | undefined): { segments: string[]; query: URLSearchParams } {
  const raw = rawUrl || "/";
  if (!raw.startsWith("/")) throw new HttpError(400, "INVALID_INPUT", "Request target must be a path");
  const at = raw.indexOf("?");
  const pathname = at < 0 ? raw : raw.slice(0, at);
  const query = new URLSearchParams(at < 0 ? "" : raw.slice(at + 1));
  const segments = pathname
    .slice(1)
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new HttpError(400, "INVALID_INPUT", "Malformed path encoding");
      }
    });
  return { segments: segments.length === 1 && segments[0] === "" ? [] : segments, query };
}

/** The directory must exist, be a directory and be its own real path (no symlink in or at it). */
export function assertRealDirectory(directory: string, what = "Directory"): string {
  let real: string;
  try {
    real = realpathSync(directory);
  } catch {
    throw notFound(`${what} not found`);
  }
  if (real !== path.resolve(directory)) throw forbidden(`${what} must not be a symlink`);
  if (!statSync(real).isDirectory()) throw notFound(`${what} not found`);
  return real;
}

/**
 * Resolves `relative` below `base` (an absolute real directory): refuses unsafe paths and any symlink segment (403),
 * a missing segment is 404 `FILE_NOT_FOUND`. Returns the absolute path; open it with {@link openRegularFile}.
 */
export function resolveConfined(base: string, relative: string): string {
  if (!isSafeRelativePath(relative)) throw forbidden("Path outside the allowed directory");
  let current = base;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      throw notFound("File not found", "FILE_NOT_FOUND");
    }
    if (info.isSymbolicLink()) throw forbidden("Symlinks are not served");
  }
  const back = path.relative(base, current);
  if (!back || back.startsWith("..") || path.isAbsolute(back)) throw forbidden("Path outside the allowed directory");
  return current;
}

export interface OpenFile {
  fd: number;
  size: number;
  mtimeMs: number;
  ino: number;
}

/** Opens without following links or blocking on FIFOs; refuses non-files and closes the descriptor on refusal. */
export function openRegularFile(file: string): OpenFile {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw notFound("File not found", "FILE_NOT_FOUND");
    if (code === "ELOOP") throw forbidden("Symlinks are not served");
    throw forbidden("File cannot be opened");
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw forbidden("Not a regular file");
    return { fd, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
