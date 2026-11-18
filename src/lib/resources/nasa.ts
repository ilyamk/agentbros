import { z } from "zod";
import { ResourceCandidateSchema, type ResourceCandidate } from "../../types/resources";
import { rightsFromLicence } from "./rights";
import { readResourceResponse, resourceJson } from "./http";

const kinds = z.enum(["image", "video", "audio"]);
const dataSchema = z
  .object({
    nasa_id: z.string().min(1).max(200),
    media_type: kinds,
    title: z.string().max(20_000),
    center: z.string().optional(),
    photographer: z.string().optional(),
    secondary_creator: z.string().optional(),
    keywords: z.array(z.string()).max(1000).optional(),
  })
  .passthrough();
const searchSchema = z
  .object({
    collection: z
      .object({
        items: z
          .array(
            z
              .object({
                data: z.array(dataSchema).min(1).max(20),
                links: z
                  .array(z.object({ href: z.string().url(), rel: z.string().optional() }).passthrough())
                  .max(100)
                  .optional(),
              })
              .passthrough(),
          )
          .max(100),
      })
      .passthrough(),
  })
  .passthrough();
const manifestSchema = z
  .object({
    collection: z
      .object({ items: z.array(z.object({ href: z.string().url() }).passthrough()).max(1000) })
      .passthrough(),
  })
  .passthrough();
const usageTerms = "https://www.nasa.gov/nasa-brand-center/images-and-media/";
function id(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) || value === "..") throw new Error("Invalid NASA asset ID.");
  return value;
}
function mediaUrl(value: string, assetId: string, kind: string) {
  const url = new URL(value);
  const prefix = `/${kind}/${encodeURIComponent(assetId)}/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "images-assets.nasa.gov" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix) ||
    /%2f|%5c|%2e/i.test(url.pathname)
  )
    throw new Error("Untrusted NASA media URL.");
  return url.toString();
}
/** Metadata only: no downloads, preview promotion or generic public-domain clearance. */
export class NasaResources {
  private request: typeof fetch;
  private now: () => string;
  private maxBytes: number;
  constructor(options: { fetch?: typeof fetch; now?: () => string; maxMetadataBytes?: number } = {}) {
    this.request = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxBytes = options.maxMetadataBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 4 * 1024 * 1024)
      throw new Error("Invalid NASA metadata byte bound.");
  }
  private async json(route: string): Promise<unknown> {
    return resourceJson(
      await readResourceResponse(this.request, `https://images-api.nasa.gov/${route}`, {
        maxBytes: this.maxBytes,
        timeoutMs: 30_000,
      }),
    );
  }
  async search(options: {
    query: string;
    kind: "image" | "video" | "audio";
    page?: number;
    limit?: number;
  }): Promise<ResourceCandidate[]> {
    const kind = kinds.parse(options.kind),
      limit = options.limit ?? 10,
      page = options.page ?? 1;
    if (
      !options.query.trim() ||
      options.query.length > 1000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 10_000
    )
      throw new Error("Invalid NASA search query/pagination.");
    const params = new URLSearchParams({
      q: options.query,
      media_type: kind,
      page: String(page),
      page_size: String(limit),
    });
    const result = searchSchema.parse(await this.json(`search?${params}`));
    return result.collection.items.slice(0, limit).map((item) => {
      const data = item.data[0];
      const assetId = id(data.nasa_id);
      if (data.media_type !== kind) throw new Error("NASA result media type mismatch.");
      const sourceUrl = `https://images.nasa.gov/details/${encodeURIComponent(assetId)}`;
      const preview = item.links?.find((link) => link.rel === "preview");
      return ResourceCandidateSchema.parse({
        id: `nasa:${assetId}`,
        provider: "nasa",
        kind,
        title: data.title,
        author: data.photographer ?? data.secondary_creator ?? data.center ?? "",
        sourceUrl,
        previewUrl: preview ? mediaUrl(preview.href, assetId, kind) : undefined,
        acquisition: "manual",
        media: {},
        tags: data.keywords ?? [],
        cost: {
          status: "free",
          quotaNote: "Metadata is public; third-party/person/logo and usage conditions remain unresolved.",
        },
        rights: {
          ...rightsFromLicence({
            licence: "unknown",
            title: data.title,
            author: data.center ?? "",
            sourceUrl,
            checkedAsOf: this.now(),
          }),
          licenceUrl: usageTerms,
          restrictions: [
            "Not a blanket CC0 licence",
            "Check third-party copyright, people, logos and endorsement",
            "Advertising permission is not cleared by this route",
            "Observe NASA credit and AI/media guidelines",
          ],
        },
      });
    });
  }
  async inspect(selected: ResourceCandidate): Promise<ResourceCandidate> {
    const resource = ResourceCandidateSchema.parse(selected);
    if (resource.provider !== "nasa" || !resource.id.startsWith("nasa:")) throw new Error("Expected NASA candidate.");
    const assetId = id(resource.id.slice(5));
    kinds.parse(resource.kind);
    if (resource.sourceUrl !== `https://images.nasa.gov/details/${encodeURIComponent(assetId)}`)
      throw new Error("NASA source page mismatch.");
    const manifest = manifestSchema.parse(await this.json(`asset/${encodeURIComponent(assetId)}`));
    const urls = manifest.collection.items.map((item) => mediaUrl(item.href, assetId, resource.kind));
    const extensions =
      resource.kind === "image"
        ? ["jpg", "jpeg", "png", "tif", "tiff", "webp"]
        : resource.kind === "video"
          ? ["mp4", "mov", "webm", "m4v"]
          : ["mp3", "wav", "flac", "m4a", "aac", "ogg"];
    const originals = urls.filter((value) => {
      const file = new URL(value).pathname;
      return /~orig\.[a-z0-9]+$/i.test(file) && extensions.includes(file.split(".").at(-1)!.toLowerCase());
    });
    // Ambiguous originals require selection outside this route; NEVER select largest preview.
    return ResourceCandidateSchema.parse({
      ...resource,
      downloadUrl: undefined,
      originalDownloadUrl: originals.length === 1 ? originals[0] : undefined,
      acquisition: "manual",
    });
  }
}
