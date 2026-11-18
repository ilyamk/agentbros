/**
 * The review `/file` response, shared by `review:ui` and the console's review host (RFC 0004 WP13): only files in
 * `ReviewService.file`'s allowlist, opened with `O_NOFOLLOW`, regular files only, `@realtime/…` descriptors re-hashed
 * against the opened descriptor, non-media served as `text/plain` and capped at 2 MiB. Range, HEAD and 416 come from
 * `serveOpenFile`. Errors are plain `Error`s (400 at both servers).
 */
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { serveOpenFile } from "../local-server/range";
import type { ReviewService } from "./service";

export const REVIEW_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

/** Largest non-media report served (as text). */
export const REVIEW_REPORT_LIMIT = 2 * 1024 * 1024;

export function serveReviewFile(req: IncomingMessage, res: ServerResponse, service: ReviewService, requested: string) {
  const file = service.file(requested),
    ext = path.extname(file).toLowerCase();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = fstatSync(fd);
  if (requested.startsWith("@realtime/")) {
    try {
      service.realtime.verifyDescriptor(requested, fd);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  if (!info.isFile()) {
    closeSync(fd);
    throw new Error("Not a regular file");
  }
  // Non-media reports are displayed as text, never executable HTML documents.
  const type = REVIEW_MEDIA_TYPES[ext] || "text/plain; charset=utf-8";
  if (!REVIEW_MEDIA_TYPES[ext] && info.size > REVIEW_REPORT_LIMIT) {
    closeSync(fd);
    throw new Error("Review report exceeds 2 MiB");
  }
  serveOpenFile(req, res, { fd, size: info.size, contentType: type });
}
