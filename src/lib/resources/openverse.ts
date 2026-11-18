import path from "node:path";
import { z } from "zod";
import { CliErrorObject } from "../cli";
import { cacheRoot } from "../cache-dir";
import { readResourceResponse, ResourceHttpError, resourceJson } from "./http";
import { ResponseCache, cacheKey } from "./cache";

export const OpenverseFiltersSchema = z
  .object({
    category: z
      .enum([
        "photograph",
        "illustration",
        "digitized_artwork",
        "music",
        "sound_effect",
        "podcast",
        "audiobook",
        "news",
        "pronunciation",
      ])
      .optional(),
    source: z
      .string()
      .regex(/^[\w,-]{1,200}$/)
      .optional(),
    excludedSource: z
      .string()
      .regex(/^[\w,-]{1,200}$/)
      .optional(),
    licences: z
      .array(z.enum(["by", "by-sa", "by-nc", "by-nd", "by-nc-sa", "by-nc-nd", "cc0", "pdm"]))
      .min(1)
      .max(8)
      .optional(),
    length: z.enum(["shortest", "short", "medium", "long"]).optional(),
    aspectRatio: z.enum(["square", "wide", "tall"]).optional(),
    size: z.enum(["small", "medium", "large"]).optional(),
  })
  .strict();
export type OpenverseFilters = z.infer<typeof OpenverseFiltersSchema>;
export type OpenverseCredentials = { accessToken?: string; clientId?: string; clientSecret?: string };
const API = "https://api.openverse.org/v1/";
const TTL = 15 * 60_000;
const MAX_ENTRIES = 500;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const object = z.record(z.string(), z.unknown());

export function openverseParams(search: {
  query: string;
  kind: "image" | "audio" | "video";
  page?: number;
  limit?: number;
  commercial?: boolean;
  modified?: boolean;
  openverse?: OpenverseFilters;
}) {
  const filters = OpenverseFiltersSchema.parse(search.openverse ?? {});
  const page = search.page ?? 1,
    limit = search.limit ?? 10;
  if (
    !search.query.trim() ||
    search.query.length > 1000 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 10_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid Openverse query or pagination." });
  if (search.kind === "video")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Openverse covers images/audio, not video." });
  const audio = search.kind === "audio";
  if (
    (audio &&
      (filters.aspectRatio ||
        filters.size ||
        ["photograph", "illustration", "digitized_artwork"].includes(filters.category ?? ""))) ||
    (!audio &&
      (filters.length ||
        ["music", "sound_effect", "podcast", "audiobook", "news", "pronunciation"].includes(filters.category ?? "")))
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Openverse filters do not match the media kind." });
  const params = new URLSearchParams({ q: search.query, page_size: String(limit), page: String(page) });
  const groups = [search.commercial && "commercial", search.modified && "modification"].filter(Boolean);
  if (groups.length) params.set("license_type", groups.join(","));
  for (const [key, value] of Object.entries(filters))
    if (value !== undefined)
      params.set(
        (
          { excludedSource: "excluded_source", licences: "license", aspectRatio: "aspect_ratio" } as Record<
            string,
            string
          >
        )[key] ?? key,
        Array.isArray(value) ? value.join(",") : value,
      );
  params.sort();
  return params;
}

export function openverseLicence(item: { license?: unknown; license_version?: unknown }): string {
  const code = String(item.license ?? "unknown").toUpperCase();
  return [code === "CC0" || code === "PDM" || code === "UNKNOWN" ? code : `CC ${code}`, item.license_version]
    .filter(Boolean)
    .join(" ");
}

export function freesoundSourceId(url: string): string | undefined {
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.hostname === "freesound.org" && !parsed.username && !parsed.password
    ? parsed.pathname.match(/^\/people\/[^/]+\/sounds\/(\d+)\/?$/)?.[1]
    : undefined;
}

/** Public metadata only. Source rights and acquisition never use this cache as verification. */
export class OpenverseClient {
  private readonly request: typeof fetch;
  private readonly credentials: OpenverseCredentials;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache: ResponseCache;
  private token?: { value: string; expires: number };
  private tokenPending?: Promise<string>;
  constructor(
    options: {
      fetch?: typeof fetch;
      credentials?: OpenverseCredentials;
      now?: () => number;
      cacheDir?: string | false;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.request = options.fetch ?? globalThis.fetch;
    this.credentials =
      options.credentials ??
      (options.fetch
        ? {}
        : {
            accessToken: process.env.OPENVERSE_ACCESS_TOKEN,
            clientId: process.env.OPENVERSE_CLIENT_ID,
            clientSecret: process.env.OPENVERSE_CLIENT_SECRET,
          });
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.cache = new ResponseCache({
      ttlMs: TTL,
      now: this.now,
      maxEntries: MAX_ENTRIES,
      maxBytes: MAX_CACHE_BYTES,
      maxEntryBytes: MAX_RESPONSE,
      directory:
        options.cacheDir === false
          ? undefined
          : (options.cacheDir ?? (options.fetch ? undefined : path.join(cacheRoot(), "openverse"))),
    });
    if (Boolean(this.credentials.clientId) !== Boolean(this.credentials.clientSecret))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Openverse client credentials require both ID and secret.",
      });
  }
  private async bearer(): Promise<string | undefined> {
    if (this.credentials.accessToken) return this.credentials.accessToken;
    if (!this.credentials.clientId) return undefined;
    if (this.token && this.token.expires > this.now() + 60_000) return this.token.value;
    if (this.tokenPending) return this.tokenPending;
    this.tokenPending = (async () => {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.credentials.clientId!,
        client_secret: this.credentials.clientSecret!,
      });
      const transport: typeof fetch = (_url, init) =>
        this.request(`${API}auth_tokens/token/`, {
          ...init,
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
      const data = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number().positive() }).parse(
        resourceJson(
          await readResourceResponse(transport, `${API}auth_tokens/token/`, {
            maxBytes: 64 * 1024,
            timeoutMs: 30_000,
          }),
        ),
      );
      this.token = { value: data.access_token, expires: this.now() + data.expires_in * 1000 };
      return data.access_token;
    })();
    try {
      return await this.tokenPending;
    } finally {
      this.tokenPending = undefined;
    }
  }
  async json(route: string, options: { fresh?: boolean } = {}): Promise<Record<string, any>> {
    if (!/^(?:images|audio)\/(?:[a-zA-Z0-9-]+\/)?(?:\?[^#]*)?$/.test(route))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid Openverse metadata route." });
    const url = new URL(route, API);
    url.searchParams.sort();
    return this.cache.through(cacheKey(url.toString()), () => this.load(url.toString()), options);
  }
  private async load(url: string): Promise<Record<string, unknown>> {
    let refreshed = false,
      retried = false;
    for (;;) {
      try {
        const token = await this.bearer();
        return object.parse(
          resourceJson(
            await readResourceResponse(this.request, url, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              maxBytes: MAX_RESPONSE,
              timeoutMs: 30_000,
            }),
          ),
        );
      } catch (error) {
        if (
          error instanceof ResourceHttpError &&
          error.status === 401 &&
          this.credentials.clientId &&
          !this.credentials.accessToken &&
          !refreshed
        ) {
          refreshed = true;
          this.token = undefined;
          continue;
        }
        if (error instanceof ResourceHttpError && error.status < 500) throw error;
        if (
          error instanceof SyntaxError ||
          error instanceof z.ZodError ||
          (error instanceof Error && /size limit|chunk count|Invalid resource/.test(error.message))
        )
          throw error;
        if (retried) throw error;
        retried = true;
        await this.sleep(250);
      }
    }
  }
}
