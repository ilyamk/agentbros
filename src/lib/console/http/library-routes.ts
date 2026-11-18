/**
 * Read routes of the motion library (RFC 0004 WP15, US21), behind the console's session rules (already checked):
 *
 * - `GET /api/library` — the trimmed catalogue ({@link LibraryResponseSchema}); 404 `LIBRARY_NOT_FOUND` without one.
 * - `GET|HEAD /library/preview/<block id>` — the block's preview still (an `<img>`: the cookie authenticates it),
 *   resolved only through the catalogue entry, confined to `docs/library/previews/`; a symlink anywhere on the path
 *   (the folder or any parent below the real-pathed library root, or the file itself) is refused.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { badRequest, notFound, sendJson } from "../../local-server/errors";
import path from "node:path";
import { assertRealDirectory, openRegularFile } from "../../local-server/paths";
import { serveOpenFile } from "../../local-server/range";
import type { LibraryReader } from "../library";

const BLOCK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Whether a path is a library route (the cookie is accepted on `/library/…`, like media). */
export const isLibraryPath = (segments: readonly string[]) =>
  (segments[0] === "api" && segments[1] === "library") || segments[0] === "library";

export function handleLibrary(
  req: IncomingMessage,
  res: ServerResponse,
  segments: readonly string[],
  query: URLSearchParams,
  library: LibraryReader,
): boolean {
  const method = req.method ?? "GET";
  if (segments[0] === "api" && segments[1] === "library" && segments.length === 2 && method === "GET") {
    if (query.size) throw badRequest("The library takes no query");
    const catalogue = library.read();
    if (!catalogue)
      throw notFound("The motion library catalogue is missing (pnpm library:catalogue).", "LIBRARY_NOT_FOUND");
    sendJson(res, 200, catalogue.response);
    return true;
  }
  if (
    segments[0] === "library" &&
    segments[1] === "preview" &&
    segments.length === 3 &&
    (method === "GET" || method === "HEAD")
  ) {
    if (query.size) throw badRequest("A preview takes no query");
    const id = segments[2] ?? "";
    if (!BLOCK_ID.test(id)) throw badRequest("Invalid block id");
    const file = library.read()?.previews.get(id);
    if (!file) throw notFound(`No preview for ${id}`, "FILE_NOT_FOUND");
    // Every directory component is real (realpath equals the path), and O_NOFOLLOW refuses a symlinked file.
    assertRealDirectory(path.dirname(file), "Previews folder");
    const opened = openRegularFile(file);
    const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    serveOpenFile(req, res, {
      fd: opened.fd,
      size: opened.size,
      contentType: TYPES[extension] ?? "application/octet-stream",
    });
    return true;
  }
  return false;
}
