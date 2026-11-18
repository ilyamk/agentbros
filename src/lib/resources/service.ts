import { mkdtempSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ResourceCandidateSchema, type ResourceCandidate, type ResourceUsage } from "../../types/resources";
import { NasaResources } from "./nasa";
import { rightsFromLicence, evaluateResourceUsage } from "./rights";
import { importAsset } from "../assets/registry";
import { readResourceResponse, resourceJson, validateResourceReadBounds } from "./http";
import {
  OpenverseClient,
  openverseParams,
  openverseLicence,
  freesoundSourceId,
  type OpenverseFilters,
  type OpenverseCredentials,
} from "./openverse";
import {
  StockClient,
  isStockProvider,
  resolutionFit,
  type DownloadTarget,
  type StockFilters,
  type StockProviderId,
} from "./stock";
import { CliErrorObject } from "../cli";

export type ResourceSearch = {
  query: string;
  kind: "image" | "video" | "audio";
  page?: number;
  limit?: number;
  commercial?: boolean;
  modified?: boolean;
  openverse?: OpenverseFilters;
  /** Shared stock filters (Unsplash, Pexels, Pixabay): orientation, colour, format/zoom, author… */
  stock?: StockFilters;
};
type Dependencies = {
  fetch?: typeof fetch;
  credentials?: {
    pexels?: string;
    pixabay?: string;
    unsplash?: string;
    freesound?: string;
    freesoundOAuth?: string;
    openverse?: OpenverseCredentials;
  };
  userAgent?: string;
  now?: () => string;
  nowMs?: () => number;
  /** Stock metadata cache directory; false keeps it in memory. */
  cacheDir?: string | false;
};
const stripHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .trim();
function candidate(
  input: Omit<ResourceCandidate, "rights"> & {
    licence: string;
    licenceUrl?: string;
    verifiedAtSource: boolean;
    checkedAsOf: string;
  },
): ResourceCandidate {
  const { licence, licenceUrl, verifiedAtSource, checkedAsOf, ...data } = input;
  return ResourceCandidateSchema.parse({
    ...data,
    rights: rightsFromLicence({
      licence,
      licenceUrl,
      title: data.title,
      author: data.author,
      sourceUrl: data.sourceUrl,
      verifiedAtSource,
      checkedAsOf,
    }),
  });
}
function safeHttp(url: string) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Resource URL must use HTTP(S).");
  return parsed.toString();
}

/** Read-only metadata requests; acquisition uses an explicit selected candidate. */
export class ResourceService {
  private fetch: typeof fetch;
  private credentials: NonNullable<Dependencies["credentials"]>;
  private now: () => string;
  private userAgent: string;
  private openverseClient: OpenverseClient;
  readonly stock: StockClient;
  constructor(dependencies: Dependencies = {}) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.credentials = dependencies.credentials ?? {};
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.userAgent = dependencies.userAgent ?? "AI-Video-Creator/1.0 (local resource metadata client)";
    this.openverseClient = new OpenverseClient({
      fetch: dependencies.fetch,
      credentials: dependencies.credentials?.openverse,
    });
    this.stock = new StockClient({
      fetch: this.fetch,
      credentials: {
        unsplash: this.credentials.unsplash,
        pexels: this.credentials.pexels,
        pixabay: this.credentials.pixabay,
      },
      now: this.now,
      nowMs: dependencies.nowMs,
      cacheDir: dependencies.cacheDir,
      injectedFetch: Boolean(dependencies.fetch),
    });
  }
  private async json(url: string, headers: Record<string, string> = {}): Promise<Record<string, any>> {
    const value = resourceJson(
      await readResourceResponse(this.fetch, safeHttp(url), { headers, maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000 }),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Resource metadata object required.");
    return value as Record<string, any>;
  }
  private key(provider: "freesound") {
    const value = this.credentials[provider];
    if (!value) throw new Error(`Missing ${provider} API credentials.`);
    return value;
  }
  async search(
    provider: StockProviderId | "freesound" | "openverse" | "wikimedia" | "nasa",
    search: ResourceSearch,
  ): Promise<ResourceCandidate[]> {
    if (isStockProvider(provider)) {
      if (search.kind === "audio")
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `${provider} covers photos/videos, not audio.` });
      const result = await this.stock.searchOne(provider, {
        query: search.query,
        kind: search.kind,
        page: search.page,
        limit: search.limit,
        filters: search.stock,
      });
      return result.candidates;
    }
    if (provider === "nasa") return new NasaResources({ fetch: this.fetch, now: this.now }).search(search);
    if (!search.query.trim()) throw new Error("Resource search requires a query.");
    const count = search.limit ?? 10,
      page = search.page ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 50 || !Number.isInteger(page) || page < 1)
      throw new Error("Invalid resource pagination.");
    if (provider === "freesound") {
      if (search.kind !== "audio") throw new Error("Freesound covers audio resources.");
      const params = new URLSearchParams({
        query: search.query,
        page_size: String(count),
        page: String(page),
        fields: "id,name,username,duration,url,previews,license,tags,download",
      });
      if (search.commercial) params.set("filter", 'license:"Creative Commons 0" OR license:"Attribution"');
      const data = await this.json(`https://freesound.org/apiv2/search/text/?${params}`, {
        Authorization: `Token ${this.key("freesound")}`,
      });
      return (data.results ?? []).map((item: any) => this.freesound(item));
    }
    if (provider === "openverse") {
      const params = openverseParams(search);
      const data = await this.openverseClient.json(`${search.kind === "audio" ? "audio" : "images"}/?${params}`);
      return (data.results ?? []).map((item: any) => this.openverse(item, search.kind));
    }
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      generator: "search",
      gsrsearch: search.query,
      gsrnamespace: "6",
      gsrlimit: String(count),
      gsroffset: String((page - 1) * count),
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
    });
    const data = await this.json(`https://commons.wikimedia.org/w/api.php?${params}`, { "User-Agent": this.userAgent });
    return Object.values(data.query?.pages ?? {})
      .map((item: any) => this.wikimedia(item))
      .filter((item) => item.kind === search.kind);
  }
  async inspect(selected: ResourceCandidate): Promise<ResourceCandidate> {
    const item = ResourceCandidateSchema.parse(selected);
    if (item.provider === "nasa") return new NasaResources({ fetch: this.fetch, now: this.now }).inspect(item);
    if (isStockProvider(item.provider)) return this.stock.inspect(item);
    if (item.provider === "freesound") {
      const id = item.id.split(":").at(-1)!;
      return this.freesound(
        await this.json(`https://freesound.org/apiv2/sounds/${encodeURIComponent(id)}/`, {
          Authorization: `Token ${this.key("freesound")}`,
        }),
      );
    }
    if (item.provider === "openverse") {
      const id = item.id.split(":").at(-1)!;
      return this.openverse(
        await this.openverseClient.json(`${item.kind === "audio" ? "audio" : "images"}/${encodeURIComponent(id)}/`, {
          fresh: true,
        }),
        item.kind,
      );
    }
    if (item.provider === "wikimedia") {
      const params = new URLSearchParams({
        action: "query",
        format: "json",
        pageids: item.id.split(":").at(-1)!,
        prop: "imageinfo",
        iiprop: "url|size|mime|extmetadata",
      });
      const data = await this.json(`https://commons.wikimedia.org/w/api.php?${params}`, {
        "User-Agent": this.userAgent,
      });
      const page = Object.values(data.query?.pages ?? {})[0];
      if (!page) throw new Error("Wikimedia file was not found.");
      return this.wikimedia(page);
    }
    throw new Error("This provider supports manual discovery only.");
  }
  private freesound(item: any): ResourceCandidate {
    return candidate({
      id: `freesound:${item.id}`,
      provider: "freesound",
      kind: "audio",
      title: item.name,
      sourceUrl: item.url,
      author: item.username ?? "",
      previewUrl: item.previews?.["preview-hq-mp3"],
      downloadUrl: item.previews?.["preview-hq-mp3"],
      originalDownloadUrl: item.download ?? `https://freesound.org/apiv2/sounds/${item.id}/download/`,
      acquisition: "oauth-original",
      media: { durationSec: item.duration },
      tags: item.tags ?? [],
      licence: item.license ?? "unknown",
      licenceUrl: item.license?.startsWith("http") ? item.license : undefined,
      verifiedAtSource: true,
      checkedAsOf: this.now(),
      cost: { status: "free", quotaNote: "Original download requires OAuth; preview is compressed media." },
    });
  }
  private openverse(item: any, kind: string): ResourceCandidate {
    const source = String(item.source ?? item.provider ?? "unknown");
    const freesound = source === "freesound" && kind === "audio";
    const sourceId = freesound ? freesoundSourceId(String(item.foreign_landing_url)) : undefined;
    return candidate({
      id: `openverse:${item.id}`,
      provider: "openverse",
      kind: kind === "audio" ? "audio" : "image",
      title: item.title ?? "Untitled",
      sourceUrl: item.foreign_landing_url,
      author: item.creator ?? "",
      previewUrl: kind === "audio" ? item.url : item.thumbnail,
      thumbnailUrl: item.thumbnail,
      ...(sourceId ? { originalDownloadUrl: `https://freesound.org/apiv2/sounds/${sourceId}/download/` } : {}),
      acquisition: sourceId ? "oauth-original" : "manual",
      upstream: {
        source,
        ...(item.provider ? { provider: String(item.provider) } : {}),
        ...(sourceId ? { id: sourceId } : {}),
        fileRole: freesound ? "preview" : "unverified",
      },
      media: {
        ...(item.width ? { width: item.width } : {}),
        ...(item.height ? { height: item.height } : {}),
        ...(item.duration ? { durationSec: item.duration / 1000 } : {}),
      },
      tags: (item.tags ?? []).map((tag: any) => (typeof tag === "string" ? tag : tag.name)),
      licence: openverseLicence(item),
      licenceUrl: item.license_url,
      verifiedAtSource: false,
      checkedAsOf: this.now(),
      cost: {
        status: "free",
        quotaNote: "Discovered using Openverse. Verify the original source; previews are not originals.",
      },
    });
  }
  private wikimedia(item: any): ResourceCandidate {
    const info = item.imageinfo?.[0];
    if (!info) throw new Error("Wikimedia result is not a usable file.");
    const meta = info.extmetadata ?? {},
      mime = String(info.mime ?? "");
    return candidate({
      id: `wikimedia:${item.pageid}`,
      provider: "wikimedia",
      kind: mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "image",
      title: String(item.title).replace(/^File:/, ""),
      sourceUrl: info.descriptionurl,
      author: stripHtml(meta.Artist?.value),
      previewUrl: info.thumburl ?? info.url,
      downloadUrl: info.url,
      acquisition: "direct",
      media: { width: info.width, height: info.height, ...(info.duration ? { durationSec: info.duration } : {}) },
      tags: [],
      licence: stripHtml(meta.LicenseShortName?.value) || "unknown",
      licenceUrl: meta.LicenseUrl?.value || undefined,
      verifiedAtSource: true,
      checkedAsOf: this.now(),
      cost: { status: "free" },
    });
  }
  async acquire(
    selected: ResourceCandidate,
    options: {
      projectId: string;
      usage: ResourceUsage;
      sourceFile?: string;
      mode?: "original" | "preview";
      rootDir?: string;
      maxBytes?: number;
      /** Frame the file must fill; stock sources download the size it needs and refuse a file that is too small. */
      target?: DownloadTarget;
      /** Accept a stock file that needs more than the house upscale limit for the target. */
      allowUpscale?: boolean;
    },
  ) {
    validateResourceReadBounds(options.maxBytes ?? 250 * 1024 * 1024, 60_000);
    let resource = ResourceCandidateSchema.parse(selected);
    const mode = options.mode ?? "original";
    if (resource.provider === "openverse" && !options.sourceFile) {
      const inspected = await this.inspect(resource);
      if (
        inspected.sourceUrl !== resource.sourceUrl ||
        inspected.rights.licence !== resource.rights.licence ||
        inspected.rights.version !== resource.rights.version ||
        inspected.author !== resource.author ||
        inspected.title !== resource.title
      )
        throw new Error("Openverse source, attribution or licence changed; inspect and confirm again.");
      resource = { ...inspected, rights: resource.rights };
      if (
        resource.upstream?.source === "jamendo" &&
        (mode === "original" || options.usage.commercial || options.usage.advertising)
      )
        throw new Error(
          "Use the music acquisition workflow for Jamendo source and commercial policy, including previews.",
        );
      if (resource.upstream?.source === "freesound" && mode === "original") {
        const id = freesoundSourceId(resource.sourceUrl);
        if (!id) throw new Error("Invalid Freesound source page.");
        const native = await this.inspect(this.freesound({ id, name: resource.title, url: resource.sourceUrl }));
        if (native.rights.licence !== resource.rights.licence || native.rights.version !== resource.rights.version)
          throw new Error("Licence changed at the original source; confirm again.");
        resource = { ...resource, originalDownloadUrl: native.originalDownloadUrl };
      }
    }
    if (resource.provider === "pixabay" && !options.sourceFile) {
      // Pixabay file links (pixabay.com/get/…) expire, and searches are cached for 24 hours: re-read the item.
      const fresh = await this.stock.inspect(resource);
      if (
        fresh.id !== resource.id ||
        fresh.sourceUrl !== resource.sourceUrl ||
        fresh.author !== resource.author ||
        fresh.rights.licence !== resource.rights.licence
      )
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Pixabay item, author or licence changed since search; inspect and choose again.",
        });
      resource = { ...fresh, rights: resource.rights };
    }
    const review = evaluateResourceUsage(resource, options.usage);
    if (!review.allowed) throw new Error(`Resource release blocked: ${review.blockers.join(" ")}`);
    const headers: Record<string, string> = {};
    let url = mode === "preview" ? resource.previewUrl : resource.downloadUrl;
    let delivered: { width?: number; height?: number } | undefined;
    const stock = isStockProvider(resource.provider) && !options.sourceFile;
    if (stock && mode === "original") {
      const resolved = this.stock.resolveDownload(resource, options.target);
      url = resolved.url;
      delivered = resolved.media;
      if (options.target) {
        const fit = resolutionFit(resolved.media, options.target.format, options.target.zoom ?? 1);
        if (fit.status === "too-small" && !options.allowUpscale)
          throw new CliErrorObject({
            code: "VALIDATION",
            message: `The largest downloadable file (${resolved.media.width}x${resolved.media.height}) needs ${fit.upscale}x enlargement for ${options.target.format} at zoom ${options.target.zoom ?? 1}; choose another candidate or pass --allow-upscale.`,
          });
      }
    }
    if (resource.acquisition === "manual" || resource.acquisition === "native-platform") {
      if (!options.sourceFile && mode !== "preview")
        throw new Error("This resource requires manual/native acquisition.");
    }
    if (resource.acquisition === "oauth-original" && mode === "original" && !options.sourceFile) {
      if (!this.credentials.freesoundOAuth)
        throw new Error(
          "Freesound original acquisition requires OAuth; select preview explicitly for compressed audio.",
        );
      const original = new URL(resource.originalDownloadUrl ?? "https://freesound.org/");
      if (original.origin !== "https://freesound.org" || !/^\/apiv2\/sounds\/\d+\/download\/$/.test(original.pathname))
        throw new Error("Invalid Freesound OAuth download endpoint.");
      headers.Authorization = `Bearer ${this.credentials.freesoundOAuth}`;
      url = original.toString();
    }
    let temporary: string | undefined,
      sourceFile = options.sourceFile;
    // Usage reporting a source requires (Unsplash) happens before bytes are fetched; failure stops acquisition.
    const tracking = stock ? await this.stock.onAcquire(resource) : undefined;
    const credited = resource.rights.attributionRequired === true || options.usage.credit === true;
    try {
      if (!sourceFile) {
        if (!url) throw new Error("Selected resource has no acquisition URL.");
        const maxBytes = options.maxBytes ?? 250 * 1024 * 1024;
        validateResourceReadBounds(maxBytes, 60_000);
        const bytes = await readResourceResponse(this.fetch, safeHttp(url), { headers, maxBytes, timeoutMs: 60_000 });
        temporary = mkdtempSync(path.join(tmpdir(), "video-resource-"));
        sourceFile = path.join(temporary, "resource.bin");
        writeFileSync(sourceFile, bytes);
      }
      const imported = importAsset({
        projectId: options.projectId,
        sourceFile,
        rootDir: options.rootDir,
        provenance: {
          origin: "stock",
          tool: `${resource.provider}:${mode}:${resource.id}`,
          originalFilename: resource.title,
          billing: { status: "unknown" },
        },
        rights: {
          licence: `${resource.rights.licence}${resource.rights.version ? ` ${resource.rights.version}` : ""}`,
          commercialAllowed: resource.rights.commercialAllowed,
          attributionRequired: resource.rights.attributionRequired,
          attribution: credited ? resource.rights.attributionText : undefined,
          sourceUrl: resource.sourceUrl,
          checkedAsOf: resource.rights.checkedAsOf,
        },
      });
      const projectDirectory = path.resolve(options.rootDir ?? process.cwd(), "public/projects", options.projectId);
      const directory = path.join(projectDirectory, "pipeline/resources");
      let ancestor = directory;
      while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
      const relative = path.relative(realpathSync(projectDirectory), realpathSync(ancestor));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error("Resource receipt directory escapes project.");
      mkdirSync(directory, { recursive: true });
      const stem = createHash("sha256").update(resource.id).digest("hex"),
        target = path.join(directory, `${stem}.json`),
        tmp = `${target}.${randomUUID()}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify(
          {
            resource,
            usage: options.usage,
            acquiredAt: this.now(),
            mode,
            ...(tracking ? { tracking } : {}),
            ...(options.target ? { target: options.target } : {}),
            ...(delivered ? { delivered } : {}),
            assetId: imported.asset.id,
            file: imported.asset.files.original,
          },
          null,
          2,
        ),
      );
      renameSync(tmp, target);
      return { ...imported, resourceReceipt: target, review };
    } finally {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  }
}
