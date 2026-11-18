import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { MediaFetchError } from "./errors";

const blocked = new BlockList();
const blocked6 = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["ff00::", 8],
] as const)
  blocked6.addSubnet(ip, prefix, "ipv6");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return (
    !!family &&
    (family !== 6 || /^[23]/i.test(address)) &&
    !(family === 4 ? blocked : blocked6).check(address, family === 4 ? "ipv4" : "ipv6")
  );
}
export function publicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaFetchError("INVALID_URL", "Invalid media URL.", "Supply a complete HTTP(S) link.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new MediaFetchError(
      "UNSAFE_URL",
      "URL protocol, credentials or port is forbidden.",
      "Use a public HTTP(S) source.",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (isIP(host) && !publicAddress(host))
  )
    throw new MediaFetchError("UNSAFE_URL", "Non-public network destination refused.", "Use a public source.");
  return url;
}
/**
 * Pre-flight for a link another tool (yt-dlp) downloads: the URL passes publicUrl and every address its
 * host resolves to is public. It cannot see redirects the downloader follows afterwards.
 */
export async function assertPublicDestination(value: string, timeoutMs = 10000): Promise<URL> {
  const url = publicUrl(value),
    host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [{ address: host }]
    : await Promise.race([
        lookup(host, { all: true }),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new MediaFetchError("TIMEOUT", "DNS deadline exceeded.", "Retry later.", true)),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
  if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
    throw new MediaFetchError("UNSAFE_URL", "DNS resolves to a non-public destination.", "Use a public source.");
  return url;
}
const finalUrls = new WeakMap<http.IncomingMessage, string>();
export const responseUrl = (response: http.IncomingMessage): string | undefined => finalUrls.get(response);
export interface HttpOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  onBytes?: (bytes: number) => void;
  redirects?: number;
}
/** Resolve all addresses, reject mixed/private DNS and pin the connection to the checked address. */
async function requestInternal(value: string, options: HttpOptions = {}): Promise<http.IncomingMessage> {
  const deadline = Date.now() + (options.timeoutMs ?? 60000);
  let url = publicUrl(value);
  for (let redirect = 0; redirect <= (options.redirects ?? 5); redirect++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await Promise.race([
          lookup(host, { all: true }),
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new MediaFetchError("TIMEOUT", "DNS deadline exceeded.", "Retry safe reads only.", true)),
              Math.max(1, deadline - Date.now()),
            );
            timer.unref();
          }),
        ]);
    if (!addresses.length || addresses.some((x) => !publicAddress(x.address)))
      throw new MediaFetchError("UNSAFE_URL", "DNS resolves to a non-public destination.", "Use a public source.");
    const chosen = addresses[0];
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new MediaFetchError("TIMEOUT", "HTTP deadline exceeded.", "Retry safe reads only.", true);
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const call = (url.protocol === "https:" ? https : http).request(
        url,
        {
          method: options.method ?? "GET",
          headers: options.headers,
          family: chosen.family,
          lookup: ((
            _hostname: string,
            _options: unknown,
            callback: (error: Error | null, address: string, family: number) => void,
          ) => callback(null, chosen.address, chosen.family)) as http.RequestOptions["lookup"],
          signal: AbortSignal.timeout(remaining),
        },
        resolve,
      );
      call.on("error", reject);
      if (options.body !== undefined) call.write(JSON.stringify(options.body));
      call.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.destroy();
      if (options.headers || (options.method && !["GET", "HEAD"].includes(options.method)))
        throw new MediaFetchError(
          "UNSAFE_REDIRECT",
          "Authenticated API redirects are refused.",
          "Check the provider endpoint.",
        );
      if (!response.headers.location) throw new MediaFetchError("PROVIDER_RESPONSE_INVALID", "Redirect has no target.");
      url = publicUrl(new URL(response.headers.location, url).href);
      continue;
    }
    finalUrls.set(response, url.href);
    return response;
  }
  throw new MediaFetchError("REDIRECT_LIMIT", "Too many redirects.", "Supply the final public post URL.");
}
function transportError(error: unknown): MediaFetchError {
  if (error instanceof MediaFetchError) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
  const timeout = ["ABORT_ERR", "ETIMEDOUT"].includes(code);
  return new MediaFetchError(
    timeout ? "TIMEOUT" : "NETWORK",
    `HTTP transport failed (${code.replace(/[^A-Z0-9_]/g, "").slice(0, 40)}).`,
    "Retry safe reads; reconcile ambiguous submissions before another provider call.",
    true,
  );
}
export async function request(value: string, options: HttpOptions = {}): Promise<http.IncomingMessage> {
  try {
    return await requestInternal(value, options);
  } catch (error) {
    throw transportError(error);
  }
}
export async function readResponse(response: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of response) {
      bytes += chunk.length;
      if (bytes > limit) {
        response.destroy();
        throw new MediaFetchError("SIZE_LIMIT", "Response exceeds its size limit.");
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    throw transportError(error);
  }
  return Buffer.concat(chunks);
}
export async function jsonRequest(value: string, options: HttpOptions = {}): Promise<unknown> {
  const response = await request(value, options);
  const body = await readResponse(response, options.maxBytes);
  const status = response.statusCode ?? 0;
  if (status >= 400) {
    const seconds = Number(response.headers["retry-after"]);
    throw new MediaFetchError(
      status === 429
        ? "RATE_LIMIT"
        : status === 401
          ? "AUTH_INVALID"
          : status === 403
            ? "SUBSCRIPTION_REQUIRED"
            : status >= 500
              ? "PROVIDER_UNAVAILABLE"
              : "SOURCE_UNAVAILABLE",
      `Provider returned HTTP ${status}.`,
      status === 401 || status === 403
        ? "Check the API key, subscription and account permissions with --doctor."
        : status === 429
          ? "Check quota or wait for the reported rate limit."
          : "Check source availability and the saved operation status.",
      status === 429 || status >= 500,
      Number.isFinite(seconds) ? seconds * 1000 : undefined,
    );
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new MediaFetchError(
      "PROVIDER_RESPONSE_INVALID",
      "Provider did not return valid JSON.",
      "Report provider contract drift.",
    );
  }
}
export async function resolveShortUrl(value: string): Promise<string> {
  const response = await request(value, { method: "HEAD" });
  const result = finalUrls.get(response);
  response.destroy();
  return result ?? value;
}
export async function downloadFile(value: string, file: string, options: HttpOptions): Promise<number> {
  const response = await request(value, options);
  if ((response.statusCode ?? 0) !== 200) {
    response.destroy();
    throw new MediaFetchError(
      "DOWNLOAD_FAILED",
      `Media returned HTTP ${response.statusCode}.`,
      "Resume existing results; expired links require a new authorised resolve.",
      true,
    );
  }
  if (/text\/html|application\/json/i.test(String(response.headers["content-type"]))) {
    response.destroy();
    throw new MediaFetchError(
      "INVALID_MEDIA",
      "Received a page instead of media.",
      "Check source or provider response.",
    );
  }
  let bytes = 0;
  try {
    await pipeline(
      response,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > (options.maxBytes ?? 2 * 1024 ** 3)) {
            callback(new MediaFetchError("SIZE_LIMIT", "Media exceeds file size limit."));
            return;
          }
          try {
            options.onBytes?.(chunk.length);
            callback(null, chunk);
          } catch (error) {
            callback(error as Error);
          }
        },
      }),
      createWriteStream(file, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    throw transportError(error);
  }
  if (!bytes) throw new MediaFetchError("INVALID_MEDIA", "Empty media file.");
  return bytes;
}
