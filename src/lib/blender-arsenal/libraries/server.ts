import { createHash } from "node:crypto";
import { z } from "zod";
import { readResourceResponse, resourceJson } from "../../resources/http";
import type { Source } from "./schemas";
import type { Download } from "./adapters";

const Hash = z.string().regex(/^SHA256:[a-f0-9]{64}$/i);
const Page = z
  .object({
    files: z.array(
      z.object({ path: z.string(), size_in_bytes: z.number().int().positive(), hash: Hash }).passthrough(),
    ),
    assets: z.array(
      z
        .object({
          name: z.string(),
          id_type: z.string(),
          files: z.array(z.unknown()),
          meta: z.object({ license: z.string().optional() }).passthrough(),
          bl_versions: z.object({ min: z.unknown() }).passthrough().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export function serverFileId(file: string): string {
  return `${file.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 160)}-${createHash("sha256").update(file).digest("hex").slice(0, 8)}`;
}
export function compatibleWith52(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value
          .split(/[^0-9]+/)
          .filter(Boolean)
          .map(Number)
      : typeof value === "object" && "major" in value && "minor" in value
        ? [value.major, value.minor]
        : [];
  return parts.length >= 2 && (Number(parts[0]) < 5 || (Number(parts[0]) === 5 && Number(parts[1]) <= 2));
}
export function parseLibraryPage(raw: unknown, source: Source): Download[] {
  const page = Page.parse(raw);
  const base = source.config.baseUrl!;
  return page.files.flatMap((file, fileIndex) => {
    if (
      !file.path.endsWith(".blend") ||
      !compatibleWith52(file.blender_version) ||
      /(?:^|\/)5\.3\/|@b5_3/.test(file.path)
    )
      return [];
    const assets = page.assets.filter((asset) =>
      asset.files.some(
        (value) =>
          value === fileIndex ||
          value === file.path ||
          (typeof value === "object" &&
            value !== null &&
            ("path" in value ? value.path === file.path : "index" in value && value.index === fileIndex)),
      ),
    );
    const free = assets.filter(
      (asset) =>
        /^(?:CC0(?:-1\.0)?(?: - Public Domain)?|Public Domain)$/i.test(asset.meta.license ?? "") &&
        compatibleWith52(asset.bl_versions?.min),
    );
    if (!free.length) return [];
    const types = new Set(free.map((asset) => asset.id_type));
    if (!["NODETREE", "MATERIAL", "WORLD", "COLLECTION", "OBJECT"].some((type) => types.has(type))) return [];
    const kind = types.has("NODETREE")
      ? "node-groups"
      : types.has("MATERIAL")
        ? "materials"
        : types.has("WORLD")
          ? "hdri"
          : "models";
    const category =
      kind === "node-groups"
        ? "node_groups"
        : kind === "materials"
          ? "materials"
          : kind === "hdri"
            ? "worlds"
            : types.has("COLLECTION")
              ? "collections"
              : "objects";
    const idType = {
      node_groups: "NODETREE",
      materials: "MATERIAL",
      worlds: "WORLD",
      collections: "COLLECTION",
      objects: "OBJECT",
    }[category];
    return [
      {
        id: `${source.id}:${serverFileId(file.path)}`,
        title: decodeURIComponent(file.path.split("/").pop()!),
        kind,
        tags: free.map((asset) => asset.name),
        licence: "CC0-1.0",
        sourcePage: base,
        url: new URL(file.path, base).toString(),
        size: file.size_in_bytes,
        sha256: file.hash.split(":")[1]!.toLowerCase(),
        format: "blend",
        resolution: "blender-5.2",
        name: "library.blend",
        allowedCategory: category,
        allowedAssets: free.filter((asset) => asset.id_type === idType).map((asset) => asset.name),
      },
    ];
  });
}
export async function readLibraryServer(source: Source, request: typeof fetch): Promise<Download[]> {
  const base = source.config.baseUrl!;
  if (new URL(base).hostname !== "cdn.extensions.blender.org") throw new Error("Unapproved library server");
  const json = async (relative: string, hash?: string) => {
    const url = new URL(relative, base);
    if (url.hostname !== "cdn.extensions.blender.org" || url.protocol !== "https:")
      throw new Error("Unapproved library index host");
    const bytes = await readResourceResponse(request, url.toString(), { maxBytes: 32 * 1024 * 1024, timeoutMs: 30000 });
    if (hash && createHash("sha256").update(bytes).digest("hex") !== hash.split(":").pop()!.toLowerCase())
      throw new Error("Library metadata SHA256 mismatch");
    return resourceJson(bytes);
  };
  const meta = z
    .object({
      api_versions: z.object({ v1: z.object({ url: z.string(), hash: Hash.optional() }).passthrough() }).passthrough(),
    })
    .passthrough()
    .parse(await json("_asset-library-meta.json"));
  const index = z
    .object({
      pages: z.array(z.union([z.string(), z.object({ url: z.string(), hash: Hash.optional() }).passthrough()])),
    })
    .passthrough()
    .parse(await json(meta.api_versions.v1.url, meta.api_versions.v1.hash));
  const found: Download[] = [];
  for (const page of index.pages)
    found.push(
      ...parseLibraryPage(
        await json(typeof page === "string" ? page : page.url, typeof page === "string" ? undefined : page.hash),
        source,
      ),
    );
  return [...new Map(found.map((item) => [item.id, item])).values()];
}
