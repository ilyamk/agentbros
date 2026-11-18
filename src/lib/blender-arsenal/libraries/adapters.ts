import { GitCatalogue, KeyCatalogue } from "./catalogues";
import { readLibraryServer } from "./server";
import { z } from "zod";
import { PolyHavenResources } from "../../resources/poly-haven";
import { readResourceResponse, resourceJson } from "../../resources/http";
import type { AssetKind } from "../paths";
import type { Item, Source } from "./schemas";

export interface Candidate {
  id: string;
  kind: AssetKind;
  title: string;
  licence: string;
  tags: string[];
  sourcePage: string;
}
export interface Download extends Candidate {
  url: string;
  size: number;
  sha256?: string;
  md5?: string;
  format: string;
  resolution: string;
  allowedCategory?: string;
  allowedAssets?: string[];
  gitBlobSha?: string;
  attribution?: string;
  licenceUrl?: string;
  name?: string;
  dependencies?: {
    url: string;
    size: number;
    md5?: string;
    sha256?: string;
    format: string;
    name: string;
    gitBlobSha?: string;
  }[];
}
const AMBIENT_TYPES = [
  "material",
  "hdri",
  "substance",
  "decal",
  "atlas",
  "3d-model",
  "plain-image",
  "brush",
  "terrain",
  "hdri-element",
];
const AMBIENT_INCLUDES = [
  "type",
  "releaseDate",
  "shortDescription",
  "longDescription",
  "title",
  "url",
  "tags",
  "colors",
  "dimensions",
  "downloadStatistics",
  "maps",
  "technique",
  "downloads",
  "relations",
  "collections",
  "previews",
  "thumbnails",
];
export function validateAmbientParams(params: Record<string, string>) {
  for (const key of Object.keys(params))
    if (!["type", "include", "q", "sort", "limit", "offset", "id", "technique", "date"].includes(key))
      throw new Error(`Unknown ambientCG query key: ${key}`);
  if (params.type && !AMBIENT_TYPES.includes(params.type)) throw new Error(`Invalid ambientCG type: ${params.type}`);
  if (params.include && params.include.split(",").some((value) => !AMBIENT_INCLUDES.includes(value)))
    throw new Error("Invalid ambientCG include");
}
const AmbientResponse = z
  .object({
    assets: z.array(
      z
        .object({
          id: z.string(),
          title: z.string().optional(),
          type: z.string().optional(),
          tags: z.array(z.string()).optional(),
          url: z.string().url().optional(),
          downloads: z
            .array(
              z
                .object({
                  attributes: z.string(),
                  extension: z.string(),
                  url: z.string().url(),
                  size: z.number().int().positive(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export function parseAmbient(raw: unknown): Download[] {
  return AmbientResponse.parse(raw)
    .assets.filter(
      (asset) => !asset.type || ["material", "hdri", "3d-model", "decal", "atlas", "plain-image"].includes(asset.type),
    )
    .flatMap((asset) =>
      (asset.downloads ?? [])
        .filter((file) => ["zip", "hdr", "exr"].includes(file.extension))
        .map((file) => {
          const url = new URL(file.url);
          if (url.hostname !== "ambientcg.com" || url.pathname !== "/get" || !url.searchParams.has("file"))
            throw new Error("ambientCG must publish a stable /get?file= URL");
          return {
            id: `ambientcg:${asset.id}`,
            kind:
              asset.type === "hdri"
                ? "hdri"
                : asset.type === "3d-model"
                  ? "models"
                  : asset.type === "decal"
                    ? "decals"
                    : ["atlas", "plain-image"].includes(asset.type ?? "")
                      ? "textures"
                      : "materials",
            title: asset.title ?? asset.id,
            licence: "CC0-1.0",
            tags: asset.tags ?? [],
            sourcePage: asset.url ?? `https://ambientcg.com/a/${asset.id}`,
            url: file.url,
            size: file.size,
            format: file.extension,
            resolution: file.attributes.toLowerCase(),
          } as Download;
        }),
    );
}
export class LibraryAdapter {
  private poly: PolyHavenResources;
  constructor(
    readonly source: Source,
    private request: typeof fetch = fetch,
  ) {
    this.poly = new PolyHavenResources({ fetch: request });
  }
  private async ambient(query: string, id?: string, kind?: AssetKind) {
    validateAmbientParams(this.source.config.query ?? {});
    const url = new URL(this.source.config.baseUrl ?? "https://ambientcg.com/api/v3/assets");
    const params: Record<string, string> = {
      limit: "50",
      sort: "popular",
      include: "type,title,tags,maps,dimensions,downloads,technique,url",
      ...this.source.config.query,
    };
    if (!id) params.type = kind === "hdri" ? "hdri" : kind === "models" ? "3d-model" : (params.type ?? "material");
    validateAmbientParams(params);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set(id ? "id" : "q", id ?? query);
    return parseAmbient(
      resourceJson(
        await readResourceResponse(this.request, url.toString(), { maxBytes: 32 * 1024 * 1024, timeoutMs: 30000 }),
      ),
    );
  }
  async search(query: string, kind?: AssetKind): Promise<Candidate[]> {
    if (this.source.adapter === "polyhaven-api")
      return (
        await this.poly.search({
          query,
          kind:
            kind === "models"
              ? "model"
              : kind === "materials" || kind === "textures"
                ? "texture"
                : kind === "hdri"
                  ? "hdri"
                  : undefined,
        })
      ).map((item) => ({
        id: `${this.source.id}:${item.id}`,
        title: item.title,
        kind: item.kind === "model" ? "models" : item.kind === "texture" ? "materials" : "hdri",
        tags: item.tags,
        licence: "CC0-1.0",
        sourcePage: item.sourceUrl,
      }));
    if (this.source.adapter === "ambientcg-api")
      return [...new Map((await this.ambient(query, undefined, kind)).map((item) => [item.id, item])).values()];
    if (this.source.adapter === "blender-library-server")
      return (await readLibraryServer(this.source, this.request)).filter((item) =>
        `${item.title} ${item.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()),
      );
    if (["khronos-git", "google-fonts-git"].includes(this.source.adapter))
      return new GitCatalogue(this.source, this.request).search(query);
    if (["poly-pizza-api", "smithsonian-api"].includes(this.source.adapter))
      return new KeyCatalogue(this.source, this.request).search(query);
    return [];
  }
  async resolve(id: string, kind?: AssetKind, resolution = "2k", pinned?: Item): Promise<Download> {
    if (pinned) {
      if (this.source.adapter === "khronos-git") await new GitCatalogue(this.source, this.request).resolve(id);
      return {
        ...pinned,
        sourcePage: pinned.sourcePage ?? pinned.url,
        name: pinned.name ?? decodeURIComponent(new URL(pinned.url).pathname.split("/").pop()!),
      };
    }
    const asset = id.split(":")[1]!;
    if (this.source.adapter === "polyhaven-api") {
      const item = await this.poly.inspect(asset);
      const targetKind = item.kind === "model" ? "models" : item.kind === "texture" ? "materials" : "hdri";
      const candidates = (item.files ?? []).filter((file) =>
        file.selector.some((part) => part.toLowerCase() === resolution.toLowerCase()),
      );
      if (targetKind === "materials") {
        const maps = candidates.filter((file) => file.selector.includes("png") || file.selector.includes("jpg"));
        const selectedMaps = [...new Map(maps.map((file) => [file.selector[0], file])).values()];
        const selected = selectedMaps.shift();
        if (!selected) throw new Error(`No ${resolution} PBR maps for ${id}`);
        const description = (file: typeof selected) => ({
          url: file.url,
          size: file.size,
          md5: file.md5,
          format: new URL(file.url).pathname.split(".").pop()!,
          name: new URL(file.url).pathname.split("/").pop()!,
        });
        return {
          id,
          kind: targetKind,
          title: item.title,
          tags: item.tags,
          licence: "CC0-1.0",
          sourcePage: item.sourceUrl,
          ...description(selected),
          resolution,
          dependencies: selectedMaps.map(description),
        };
      }
      const formats = targetKind === "models" ? ["glb", "gltf", "blend"] : ["hdr", "exr"];
      const selected = formats.flatMap((format) =>
        candidates.filter((file) => new URL(file.url).pathname.endsWith(`.${format}`)),
      )[0];
      if (!selected)
        throw new Error(
          `No self-contained ${resolution} ${targetKind} file for ${id}; pin an archive or use resources:poly-haven`,
        );
      return {
        id,
        kind: targetKind,
        title: item.title,
        tags: item.tags,
        licence: "CC0-1.0",
        sourcePage: item.sourceUrl,
        ...selected,
        format: new URL(selected.url).pathname.split(".").pop()!,
        name: new URL(selected.url).pathname.split("/").pop()!,
        resolution,
        dependencies: selected.include?.map((dependency) => ({
          ...dependency,
          format: new URL(dependency.url).pathname.split(".").pop()!,
        })),
      };
    }
    if (this.source.adapter === "ambientcg-api") {
      const selected = (await this.ambient("", asset)).find(
        (item) =>
          item.id === id && [`${resolution.toLowerCase()}-jpg`, resolution.toLowerCase()].includes(item.resolution),
      );
      if (selected) return selected;
      throw new Error(`No ${resolution}-JPG bundle for ${id}`);
    }
    if (this.source.adapter === "blender-library-server") {
      const item = (await readLibraryServer(this.source, this.request)).find((item) => item.id === id);
      if (!item) throw new Error(`No Blender 5.2 asset file: ${id}`);
      return item;
    }
    if (["khronos-git", "google-fonts-git"].includes(this.source.adapter))
      return new GitCatalogue(this.source, this.request).resolve(id);
    if (["poly-pizza-api", "smithsonian-api"].includes(this.source.adapter))
      return new KeyCatalogue(this.source, this.request).resolve(id);
    throw new Error(
      this.source.adapter === "bundled"
        ? "Bundled assets need no download: enumerate/append with avc_assets.bundled_assets() in Blender"
        : `Pin an exact URL + sha256 in libraries.json for ${id}. ${this.source.config.steps ?? ""}`,
    );
  }
}
