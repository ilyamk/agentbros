import { readResourceResponse, resourceJson, ResourceHttpError } from "../resources/http";
import { OpenverseClient, type OpenverseCredentials } from "../resources/openverse";

// Hosts of the documented routes. Anything else an API returns is left for a manual download.
const ALLOWED_HOSTS = [
  "api.openverse.org",
  "ccmixter.org",
  "archive.org",
  "freesound.org",
  "api.jamendo.com",
  "incompetech.com",
  "storage.jamendo.com",
  "api.deezer.com",
  "dzcdn.net",
  "itunes.apple.com",
  "audio-ssl.itunes.apple.com",
  "applemarketingtools.com",
  "rss.marketingtools.apple.com",
  "upload.wikimedia.org",
  "opengameart.org",
  "kenney.nl",
  "api.github.com",
  "raw.githubusercontent.com",
];

export function isAllowedHost(url: string): boolean {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return false;
  return ALLOWED_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
}

export type MusicHttpOptions = {
  fetch?: typeof fetch;
  now?: () => string;
  userAgent?: string;
  openverseCredentials?: OpenverseCredentials;
};

export class MusicHttp {
  readonly now: () => string;
  private request: typeof fetch;
  private userAgent: string;
  private openverse: OpenverseClient;

  constructor(options: MusicHttpOptions = {}) {
    this.request = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.userAgent = options.userAgent ?? "AI-Video-Creator/1.0 (local resource metadata client)";
    this.openverse = new OpenverseClient({ fetch: options.fetch, credentials: options.openverseCredentials });
  }

  /** `readResourceResponse` refuses redirects; this follows one, to an allowed host, without credentials. */
  private oneRedirect: typeof fetch = async (input, init) => {
    const first = await this.request(input, { ...init, redirect: "manual" });
    if (first.status < 300 || first.status >= 400) return first;
    const location = first.headers.get("location");
    if (!location) return first;
    await first.body?.cancel();
    const next = new URL(location, String(input)).toString();
    if (!isAllowedHost(next)) throw new Error(`Redirect to an unlisted host refused: ${new URL(next).hostname}`);
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    return this.request(next, { ...init, headers, redirect: "error" });
  };

  async bytes(
    url: string,
    options: { headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number } = {},
  ): Promise<Buffer> {
    if (!isAllowedHost(url)) throw new Error(`Host is not on the music allowlist: ${new URL(url).hostname}`);
    return readResourceResponse(this.oneRedirect, url, {
      headers: { "User-Agent": this.userAgent, ...options.headers },
      maxBytes: options.maxBytes ?? 80 * 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
  }

  /** One retry: these free APIs drop an occasional request and Openverse can take well over 10 s. */
  async json<T = any>(url: string, headers?: Record<string, string>): Promise<T> {
    const address = new URL(url);
    if (address.origin === "https://api.openverse.org" && address.pathname.startsWith("/v1/"))
      return (await this.openverse.json(address.pathname.slice(4) + address.search)) as T;
    const read = () => this.bytes(url, { headers, maxBytes: 8 * 1024 * 1024, timeoutMs: 45_000 });
    return resourceJson(
      await read().catch((error) => {
        if (error instanceof ResourceHttpError && error.status < 500) throw error;
        return read();
      }),
    ) as T;
  }

  async text(url: string): Promise<string> {
    return (await this.bytes(url, { maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 })).toString("utf8");
  }
}
