import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { digest, immutableWrite } from "../jobs/model-artifacts";
import { projectDir, pipelineDir } from "../pipeline/paths";
import { assertPathWithin, requireProject } from "../cli";
import { readResourceResponse, resourceJson, validateResourceReadBounds } from "./http";
const types = ["hdri", "texture", "model"] as const;
const Info = z
  .object({
    name: z.string(),
    type: z.number().int().min(0).max(2),
    tags: z.array(z.string()).default([]),
    authors: z.record(z.string(), z.string()).default({}),
  })
  .passthrough();
const IncludedFile = z
  .object({ url: z.string().url(), size: z.number().int().positive().safe(), md5: z.string().regex(/^[a-f0-9]{32}$/i) })
  .passthrough();
const File = z
  .object({
    url: z.string().url(),
    size: z.number().int().positive().safe(),
    md5: z.string().regex(/^[a-f0-9]{32}$/i),
    include: z.record(z.string(), IncludedFile).optional(),
  })
  .passthrough();
export type PolyHavenCandidate = {
  id: string;
  title: string;
  kind: (typeof types)[number];
  tags: string[];
  authors: Record<string, string>;
  sourceUrl: string;
  provenance: {
    provider: "poly-haven";
    assetLicence: "CC0";
    assetLicenceUrl: string;
    apiTermsUrl: string;
    apiCredit: string;
    checkedAt: string;
  };
  files?: {
    selector: string[];
    url: string;
    size: number;
    md5: string;
    include?: { name: string; url: string; size: number; md5: string }[];
  }[];
};
function assetId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) throw new Error("Invalid Poly Haven asset ID");
  return id;
}
function trustedDownload(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "dl.polyhaven.org" ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/file/ph-assets/")
  )
    throw new Error("Untrusted Poly Haven download URL");
  return url;
}
export class PolyHavenResources {
  private request: typeof fetch;
  private now: () => string;
  private userAgent: string;
  constructor(options: { fetch?: typeof fetch; now?: () => string; userAgent?: string } = {}) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.userAgent = options.userAgent ?? "AI-Video-Creator/1.0 (Powered by Poly Haven)";
  }
  private async json(route: string): Promise<unknown> {
    return resourceJson(
      await readResourceResponse(this.request, `https://api.polyhaven.com/${route}`, {
        headers: { "User-Agent": this.userAgent },
        maxBytes: 32 * 1024 * 1024,
        timeoutMs: 30000,
      }),
    );
  }
  private candidate(id: string, raw: unknown): PolyHavenCandidate {
    const info = Info.parse(raw);
    return {
      id: assetId(id),
      title: info.name,
      kind: types[info.type]!,
      tags: info.tags,
      authors: info.authors,
      sourceUrl: `https://polyhaven.com/a/${id}`,
      provenance: {
        provider: "poly-haven",
        assetLicence: "CC0",
        assetLicenceUrl: "https://polyhaven.com/license",
        apiTermsUrl: "https://github.com/Poly-Haven/Public-API/blob/master/ToS.md",
        apiCredit: "Powered by Poly Haven",
        checkedAt: this.now(),
      },
    };
  }
  async search(options: {
    query: string;
    kind?: (typeof types)[number];
    limit?: number;
  }): Promise<PolyHavenCandidate[]> {
    if (
      !options.query.trim() ||
      !Number.isSafeInteger(options.limit ?? 10) ||
      (options.limit ?? 10) < 1 ||
      (options.limit ?? 10) > 50
    )
      throw new Error("Invalid Poly Haven search query/limit");
    const raw = z.record(z.string(), z.unknown()).parse(await this.json("assets"));
    const query = options.query.toLowerCase();
    return Object.entries(raw)
      .map(([id, value]) => this.candidate(id, value))
      .filter(
        (item) =>
          (!options.kind || item.kind === options.kind) &&
          `${item.title} ${item.tags.join(" ")} ${item.id}`.toLowerCase().includes(query),
      )
      .slice(0, options.limit ?? 10);
  }
  async inspect(id: string): Promise<PolyHavenCandidate> {
    assetId(id);
    const info = this.candidate(id, await this.json(`info/${id}`));
    const tree = await this.json(`files/${id}`);
    const found: NonNullable<PolyHavenCandidate["files"]> = [];
    const walk = (value: unknown, selector: string[], depth: number) => {
      if (depth > 12 || found.length > 5000) throw new Error("Poly Haven file tree exceeds limit");
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      if (Object.hasOwn(value, "url")) {
        const file = File.parse(value);
        trustedDownload(file.url);
        found.push({
          selector,
          url: file.url,
          size: file.size,
          md5: file.md5.toLowerCase(),
          ...(file.include
            ? {
                include: Object.entries(file.include).map(([name, dependency]) => {
                  trustedDownload(dependency.url);
                  return { name, url: dependency.url, size: dependency.size, md5: dependency.md5.toLowerCase() };
                }),
              }
            : {}),
        });
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("Unsafe Poly Haven selector");
        walk(child, [...selector, key], depth + 1);
      }
    };
    walk(tree, [], 0);
    return { ...info, files: found };
  }
  /** Fetch fresh metadata and verify exactly selected original bytes; never execute/extract 3D bundles. */
  async acquire(id: string, selector: string[], options: { projectId: string; maxBytes?: number }) {
    if (!selector.length || !selector.every((part) => typeof part === "string" && part.length > 0))
      throw new Error("Explicit file selector required");
    const limit = options.maxBytes ?? 512 * 1024 * 1024;
    validateResourceReadBounds(limit, 60000);
    const resource = await this.inspect(id);
    const selected = resource.files?.find((file) => JSON.stringify(file.selector) === JSON.stringify(selector));
    if (!selected) throw new Error("Selected Poly Haven file unavailable");
    if (selected.size > limit) throw new Error("Selected Poly Haven file exceeds acquisition limit");
    const url = trustedDownload(selected.url);
    const content = await readResourceResponse(this.request, url.toString(), { maxBytes: limit, timeoutMs: 60000 });
    const md5 = createHash("md5").update(content).digest("hex");
    if (content.length !== selected.size || md5 !== selected.md5) throw new Error("Poly Haven file size/hash mismatch");
    const sha256 = digest(content),
      extension = path.extname(url.pathname).toLowerCase();
    if (
      ![
        ".hdr",
        ".exr",
        ".png",
        ".jpg",
        ".jpeg",
        ".tif",
        ".tiff",
        ".blend",
        ".gltf",
        ".glb",
        ".fbx",
        ".obj",
        ".mtl",
        ".bin",
        ".zip",
      ].includes(extension)
    )
      throw new Error("Unsupported Poly Haven artifact extension");
    requireProject(options.projectId);
    const root = path.resolve(projectDir(options.projectId));
    const target = path.join(root, "assets/resources/poly-haven", `${sha256}${extension}`);
    assertPathWithin(root, target);
    immutableWrite(target, content);
    const manifest = path.resolve(
      pipelineDir(options.projectId),
      "resources",
      `poly-haven-${digest(`${id}:${JSON.stringify(selector)}`)}.json`,
    );
    assertPathWithin(root, manifest);
    // The immutable receipt omits varying access times to keep repeated acquisition idempotent.
    const { checkedAt: _checkedAt, ...provenance } = resource.provenance;
    immutableWrite(
      manifest,
      JSON.stringify(
        {
          version: 1,
          id,
          kind: resource.kind,
          title: resource.title,
          authors: resource.authors,
          sourceUrl: resource.sourceUrl,
          provenance,
          selected,
          path: target,
          bytes: content.length,
          sha256,
          md5,
          execution: "Stored original only; no automatic bundle extraction or embedded-script execution",
        },
        null,
        2,
      ),
    );
    return { outputs: [target, manifest], sha256, resource, apiCredit: resource.provenance.apiCredit };
  }
}
