/**
 * Range-served project media (RFC 0004 §9.1 `/media/:id/*path`, FR7, D15): confined to `public/projects/<id>/` or,
 * with the `@out/` prefix, `out/<id>/`; no symlink at any level, no hidden segment (so a project-local `.env` is never
 * served), only known media and plain-text document types. Text documents are `text/plain` and capped at 2 MiB.
 */
import { closeSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { OUT_DIR, PROJECTS_DIR, ProjectIdSchema } from "../../types/console";
import { forbidden, HttpError, notFound } from "../local-server/errors";
import { assertRealDirectory, isSafeRelativePath, openRegularFile, resolveConfined } from "../local-server/paths";
import { serveOpenFile } from "../local-server/range";
import { OUT_PREFIX } from "./urls";

export const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".vtt": "text/vtt; charset=utf-8",
};
/**
 * Documents shown as text, never as executable HTML. JSON, journals, logs and HTML are refused: structured project
 * state (project.json, jobs, provider records, events.jsonl) reaches the UI only through the view API.
 */
export const TEXT_TYPES = new Set([".md", ".txt", ".srt", ".csv"]);
export const TEXT_LIMIT = 2 * 1024 * 1024;
/** Folders of `out/` that belong to the harness, never to a project, even if a project of that name existed. */
export const RESERVED_OUT = new Set(["console", "qa", "setup", "bench", "showcase", "site"]);

export interface ResolvedMedia {
  /** Absolute path, every segment checked. */
  file: string;
  root: "project" | "out";
  /** Relative to the root. */
  relative: string;
  contentType: string;
  text: boolean;
}

/** Resolves the decoded path segments after `/media/<project>/` (or `/thumb/<project>/`). */
export function resolveMedia(rootDir: string, project: string, segments: string[]): ResolvedMedia {
  if (!ProjectIdSchema.safeParse(project).success) throw forbidden("Invalid project id");
  const out = segments[0] === OUT_PREFIX;
  const rest = out ? segments.slice(1) : segments;
  if (!rest.length) throw forbidden("A file path is required");
  for (const segment of rest)
    if (segment.includes("/") || segment.startsWith(".")) throw forbidden("Path outside the allowed directory");
  const relative = rest.join("/");
  if (!isSafeRelativePath(relative)) throw forbidden("Path outside the allowed directory");
  const ext = path.extname(relative).toLowerCase();
  const text = TEXT_TYPES.has(ext);
  const contentType = MEDIA_TYPES[ext] ?? (text ? "text/plain; charset=utf-8" : undefined);
  if (!contentType) throw forbidden("This file type is not served");
  if (out) {
    // out/<slug>/ is a project's renders only when the project exists; out/console, out/qa and the like never are.
    if (RESERVED_OUT.has(project)) throw forbidden("Not a project's output directory");
    try {
      assertRealDirectory(path.join(rootDir, PROJECTS_DIR), "Projects directory");
      assertRealDirectory(path.join(rootDir, PROJECTS_DIR, project), "Project");
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) throw notFound("Project not found", "PROJECT_NOT_FOUND");
      throw error;
    }
  }
  const base = out ? path.join(rootDir, OUT_DIR, project) : path.join(rootDir, PROJECTS_DIR, project);
  assertRealDirectory(path.dirname(base), out ? "Output directory" : "Projects directory");
  let realBase: string;
  try {
    realBase = assertRealDirectory(base, out ? "Output directory" : "Project");
  } catch (error) {
    if (error instanceof HttpError && error.status === 404)
      throw notFound(out ? "No outputs for this project" : "Project not found", "PROJECT_NOT_FOUND");
    throw error;
  }
  return { file: resolveConfined(realBase, relative), root: out ? "out" : "project", relative, contentType, text };
}

/** Serves a resolved media file with Range and HEAD. */
export function serveMedia(req: IncomingMessage, res: ServerResponse, media: ResolvedMedia): void {
  const opened = openRegularFile(media.file);
  if (media.text && opened.size > TEXT_LIMIT) {
    closeSync(opened.fd);
    throw new HttpError(403, "FORBIDDEN", "Text document exceeds 2 MiB");
  }
  serveOpenFile(req, res, { fd: opened.fd, size: opened.size, contentType: media.contentType });
}
