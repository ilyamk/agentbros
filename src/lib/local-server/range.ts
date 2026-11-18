/**
 * HTTP Range serving of an already opened file (RFC 0004 FR7): one `bytes=` range gives 206 with `Content-Range`, an
 * unsatisfiable or multi-range request gives 416 with `bytes *\/<size>`, HEAD sends the headers only. The descriptor is
 * always closed.
 */
import { closeSync, createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

export type ByteRange = { start: number; end: number; partial: boolean };

/** Parses a `Range` header against `size`; `null` means unsatisfiable (416). An absent header is the whole file. */
export function parseRange(header: string | undefined, size: number): ByteRange | null {
  let start = 0;
  let end = size - 1;
  if (!header) return { start, end, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !(match[1] || match[2])) return null;
  start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start ||
    (!match[1] && Number(match[2]) === 0)
  )
    return null;
  return { start, end, partial: true };
}

/**
 * Streams `fd` (of `size` bytes) as `contentType`, honouring Range and HEAD. Takes ownership of `fd`.
 * `extraHeaders` are added to the 200/206 reply.
 */
export function serveOpenFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: { fd: number; size: number; contentType: string },
  extraHeaders: Record<string, string> = {},
): void {
  const { fd, size, contentType } = file;
  const range = parseRange(req.headers.range, size);
  if (!range) {
    closeSync(fd);
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  const { start, end, partial } = range;
  res.writeHead(partial ? 206 : 200, {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Length": Math.max(0, end - start + 1),
    ...(partial ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    ...extraHeaders,
  });
  if (req.method === "HEAD" || size === 0) {
    closeSync(fd);
    res.end();
    return;
  }
  const stream = createReadStream("", { fd, autoClose: true, start, end, highWaterMark: 64 * 1024 });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
