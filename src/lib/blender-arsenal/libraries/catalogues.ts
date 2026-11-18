import { assertDownloadHost, assertStableDownloadUrl } from "./network";
import { z } from "zod";
import type { Source } from "./schemas";
import type { Candidate, Download } from "./adapters";
import { readResourceResponse, resourceJson } from "../../resources/http";

export function allowedKhronosLegal(legal: { spdx: string }[]): boolean {
  return (
    legal.length > 0 &&
    legal.every((row) => ["CC0-1.0", "CC-BY-4.0"].includes(row.spdx) || row.spdx.startsWith("LicenseRef-LegalMark-"))
  );
}
const REJECTED = new Set([
  "DamagedHelmet",
  "Sponza",
  "Duck",
  "BrainStem",
  "VirtualCity",
  "EnvironmentTest",
  "PlaysetLightTest",
]);
const Tree = z
  .object({
    truncated: z.boolean().optional(),
    tree: z.array(
      z.object({ path: z.string(), type: z.string(), size: z.number().optional(), sha: z.string() }).passthrough(),
    ),
  })
  .passthrough();
export class GitCatalogue {
  constructor(
    private source: Source,
    private request: typeof fetch,
  ) {
    if (!source.config.commit) throw new Error("Pinned git commit required");
  }
  private repo() {
    return this.source.adapter === "google-fonts-git" ? "google/fonts" : "KhronosGroup/glTF-Sample-Assets";
  }
  private async json(url: string): Promise<unknown> {
    return resourceJson(
      await readResourceResponse(this.request, url, {
        maxBytes: 32 * 1024 * 1024,
        timeoutMs: 30000,
        headers: { "User-Agent": "AI-Video-Creator" },
      }),
    );
  }
  private raw(file: string) {
    return `https://raw.githubusercontent.com/${this.repo()}/${this.source.config.commit}/${file.split("/").map(encodeURIComponent).join("/")}`;
  }
  private async tree() {
    const result = Tree.parse(
      await this.json(`https://api.github.com/repos/${this.repo()}/git/trees/${this.source.config.commit}?recursive=1`),
    );
    if (result.truncated) throw new Error("Git tree truncated; refuse incomplete catalogue");
    return result.tree.filter((file) => file.type === "blob");
  }
  private async legal(asset: string) {
    if (REJECTED.has(asset)) throw new Error(`Restricted Khronos model: ${asset}`);
    const meta = z
      .object({
        legal: z.array(
          z
            .object({
              spdx: z.string(),
              artist: z.string().optional(),
              owner: z.string().optional(),
              licenseUrl: z.string().optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .parse(await this.json(this.raw(`Models/${asset}/metadata.json`)));
    if (!allowedKhronosLegal(meta.legal)) throw new Error(`Restricted Khronos licences: ${asset}`);
    return meta.legal;
  }
  async search(query: string): Promise<Candidate[]> {
    if (this.source.adapter === "google-fonts-git")
      return [
        ...new Set(
          (await this.tree())
            .filter((file) => /^ofl\/[^/]+\/OFL.txt$/.test(file.path))
            .map((file) => file.path.split("/")[1]!),
        ),
      ]
        .filter((name) => name.includes(query.toLowerCase()))
        .slice(0, 20)
        .map((name) => ({
          id: `${this.source.id}:${name}`,
          title: name,
          kind: "fonts",
          tags: ["OFL-1.1"],
          licence: "OFL-1.1",
          sourcePage: `https://github.com/google/fonts/tree/${this.source.config.commit}/ofl/${name}`,
        }));
    const rows = z
      .array(
        z
          .object({ name: z.string(), label: z.string().optional(), tags: z.array(z.string()).optional() })
          .passthrough(),
      )
      .parse(await this.json(this.raw("Models/model-index.json")));
    const candidates: Candidate[] = [];
    for (const row of rows
      .filter((row) =>
        `${row.name} ${row.label ?? ""} ${(row.tags ?? []).join(" ")}`.toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, 20)) {
      try {
        const legal = await this.legal(row.name);
        candidates.push({
          id: `${this.source.id}:${row.name}`,
          title: row.label ?? row.name,
          kind: "models",
          tags: row.tags ?? [],
          licence: [...new Set(legal.map((l) => l.spdx))].join(" AND "),
          sourcePage: `https://github.com/${this.repo()}/tree/${this.source.config.commit}/Models/${row.name}`,
        });
      } catch (error) {
        if (!(error instanceof Error) || !/Restricted/.test(error.message)) throw error;
      }
    }
    return candidates;
  }
  async resolve(id: string): Promise<Download> {
    const asset = id.split(":")[1]!;
    const tree = await this.tree();
    if (this.source.adapter === "google-fonts-git") {
      const family = tree.filter((file) => file.path.startsWith(`ofl/${asset}/`));
      const font = family.find((file) => file.path.endsWith(".ttf")),
        licence = family.find((file) => file.path === `ofl/${asset}/OFL.txt`);
      if (!font?.size || !licence?.size) throw new Error("OFL font family not found");
      return {
        id,
        title: asset,
        kind: "fonts",
        licence: "OFL-1.1",
        licenceUrl: "https://openfontlicense.org",
        tags: [],
        sourcePage: `https://github.com/google/fonts/tree/${this.source.config.commit}/ofl/${asset}`,
        url: this.raw(font.path),
        size: font.size,
        gitBlobSha: font.sha,
        name: "font.ttf",
        format: "ttf",
        resolution: this.source.config.commit!,
        dependencies: [
          { url: this.raw(licence.path), size: licence.size, gitBlobSha: licence.sha, format: "txt", name: "OFL.txt" },
        ],
      };
    }
    const legal = await this.legal(asset);
    const files = tree.filter((file) => file.path.startsWith(`Models/${asset}/`));
    const primary =
      files.find((file) => /\/glTF-Binary\/[^/]+\.glb$/.test(file.path)) ??
      files.find((file) => /\/glTF\/[^/]+\.gltf$/.test(file.path));
    if (!primary?.size) throw new Error("No supported glTF variant");
    const directory = primary.path.slice(0, primary.path.lastIndexOf("/") + 1);
    return {
      id,
      kind: "models",
      title: asset,
      tags: [],
      licence: [...new Set(legal.map((row) => row.spdx))].join(" AND "),
      attribution: legal.map((row) => `${row.artist ?? row.owner ?? ""}: ${row.spdx}`).join("; "),
      sourcePage: `https://github.com/${this.repo()}/tree/${this.source.config.commit}/Models/${asset}`,
      url: this.raw(primary.path),
      size: primary.size,
      format: primary.path.endsWith(".glb") ? "glb" : "gltf",
      name: primary.path.slice(directory.length),
      gitBlobSha: primary.sha,
      resolution: this.source.config.commit!,
      dependencies: primary.path.endsWith(".glb")
        ? []
        : files
            .filter((file) => file.path.startsWith(directory) && file.path !== primary.path)
            .map((file) => ({
              url: this.raw(file.path),
              size: file.size!,
              format: file.path.split(".").pop()!,
              name: file.path.slice(directory.length),
              gitBlobSha: file.sha,
            })),
    };
  }
}

export function cc0Smithsonian(record: unknown): boolean {
  const object = record as {
    content?: {
      descriptiveNonRepeating?: {
        metadata_usage?: { access?: string };
        online_media?: { media?: { type?: string; usage?: { access?: string } }[] };
      };
    };
  };
  const details = object.content?.descriptiveNonRepeating;
  return (
    details?.metadata_usage?.access === "CC0" &&
    !!details.online_media?.media?.some((media) => media.type === "3d_voyager" && media.usage?.access === "CC0")
  );
}
export class KeyCatalogue {
  constructor(
    private source: Source,
    private request: typeof fetch,
  ) {}
  private async json(url: string) {
    return resourceJson(
      await readResourceResponse(this.request, url, {
        maxBytes: 16 * 1024 * 1024,
        timeoutMs: 30000,
        headers:
          this.source.adapter === "poly-pizza-api" ? { "x-auth-token": process.env.POLY_PIZZA_API_KEY! } : undefined,
      }),
    );
  }
  async search(query: string): Promise<Candidate[]> {
    if (this.source.adapter === "poly-pizza-api") {
      if (!process.env.POLY_PIZZA_API_KEY) return [];
      const raw = await this.json(
        `https://api.poly.pizza/v1.1/search/${encodeURIComponent(query)}?Limit=32&Page=0&License=1`,
      );
      const rows = z
        .array(z.record(z.string(), z.unknown()))
        .parse(Array.isArray(raw) ? raw : (raw as { Results?: unknown }).Results);
      return rows
        .filter((row) => row.Licence === "CC0 1.0")
        .map((row) => ({
          id: `${this.source.id}:${row.ID}`,
          title: String(row.Title),
          licence: "CC0-1.0",
          tags: [],
          kind: "models",
          sourcePage: `https://poly.pizza/m/${row.ID}`,
        }));
    }
    const url = new URL("https://api.si.edu/openaccess/api/v1.0/search");
    url.searchParams.set("api_key", process.env.SI_API_KEY ?? "DEMO_KEY");
    url.searchParams.set("q", `${query} AND 3d_package`);
    url.searchParams.set("rows", "20");
    const raw = z
      .object({ response: z.object({ rows: z.array(z.record(z.string(), z.unknown())) }).passthrough() })
      .passthrough()
      .parse(await this.json(url.toString()));
    return raw.response.rows.filter(cc0Smithsonian).map((row) => ({
      id: `${this.source.id}:${row.id}`,
      title: String(row.title),
      licence: "CC0-1.0",
      kind: "models",
      tags: [],
      sourcePage: `https://www.si.edu/object/${row.id}`,
    }));
  }
  async resolve(id: string): Promise<Download> {
    const asset = id.split(":")[1]!;
    if (this.source.adapter === "poly-pizza-api") {
      if (!process.env.POLY_PIZZA_API_KEY)
        throw new Error("POLY_PIZZA_API_KEY required; download manually and use --action import");
      const row = z
        .object({
          Download: z.string().url(),
          Licence: z.string(),
          Title: z.string(),
          Attribution: z.string().optional(),
        })
        .passthrough()
        .parse(await this.json(`https://api.poly.pizza/v1.1/model/${asset}`));
      if (!["CC0 1.0", "CC-BY 3.0", "CC-BY 4.0"].includes(row.Licence))
        throw new Error("Unsupported Poly Pizza licence");
      if (new URL(row.Download).hostname !== "static.poly.pizza") throw new Error("Unapproved Poly Pizza CDN");
      assertStableDownloadUrl(row.Download);
      assertDownloadHost(row.Download, this.source);
      const head = await this.request(row.Download, {
        method: "HEAD",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { "x-auth-token": process.env.POLY_PIZZA_API_KEY },
      });
      const size = Number(head.headers.get("content-length"));
      if (!head.ok || !Number.isSafeInteger(size) || size <= 0)
        throw new Error("Download size unavailable; manual import required");
      return {
        id,
        kind: "models",
        title: row.Title,
        url: row.Download,
        size,
        format: "glb",
        resolution: "original",
        licence: row.Licence.replace("CC0 1.0", "CC0-1.0").replace("CC-BY ", "CC-BY-"),
        attribution: row.Attribution,
        sourcePage: `https://poly.pizza/m/${asset}`,
        tags: [],
      };
    }
    const response = z
      .object({ response: z.record(z.string(), z.unknown()) })
      .passthrough()
      .parse(
        await this.json(
          `https://api.si.edu/openaccess/api/v1.0/content/${encodeURIComponent(asset)}?api_key=${encodeURIComponent(process.env.SI_API_KEY ?? "DEMO_KEY")}`,
        ),
      );
    const record = response.response;
    if (!cc0Smithsonian(record)) throw new Error("Smithsonian metadata and 3D media must both be CC0");
    const details = record.content as {
      descriptiveNonRepeating: {
        record_link?: string;
        online_media: {
          media: {
            id?: string;
            voyagerId?: string;
            type: string;
            usage: { access: string };
            resources?: { url: string; name?: string; filename?: string; attributes?: Record<string, unknown>[] }[];
          }[];
        };
      };
    };
    const media = details.descriptiveNonRepeating.online_media.media.filter(
      (media) => media.type === "3d_voyager" && media.usage.access === "CC0",
    );
    const resources = media.flatMap((media) => media.resources ?? []);
    let file = resources.find((file) => /\.glb(?:\?|$)/i.test(file.url));
    let size = Number(file?.attributes?.find((attribute) => "FILE_SIZE" in attribute)?.FILE_SIZE);
    if (!file) {
      const packages = new Set(
        media.map((item) => item.voyagerId ?? item.id).filter((id): id is string => !!id?.startsWith("3d_package:")),
      );
      const pack = [...packages][0];
      if (!pack) throw new Error("No licensed Smithsonian 3D package");
      const url = new URL("https://3d-api.si.edu/api/v1.0/content/file/search");
      url.searchParams.set("q", media[0]?.resources?.[0]?.name ?? String(record.title ?? asset));
      url.searchParams.set("file_type", "glb");
      url.searchParams.set("rows", "50");
      const files = z
        .object({
          rows: z.array(
            z
              .object({
                content: z
                  .object({ uri: z.string().url(), model_url: z.string(), quality: z.string(), file_type: z.string() })
                  .passthrough(),
              })
              .passthrough(),
          ),
        })
        .passthrough()
        .parse(await this.json(url.toString()));
      const quality = ["Thumb", "Low", "Medium", "High"];
      const selected = files.rows
        .filter((row) => packages.has(row.content.model_url) && row.content.file_type === "glb")
        .sort(
          (a, b) =>
            (quality.indexOf(a.content.quality) < 0 ? 10 : quality.indexOf(a.content.quality)) -
            (quality.indexOf(b.content.quality) < 0 ? 10 : quality.indexOf(b.content.quality)),
        )[0];
      if (!selected) throw new Error("No GLB joined to a CC0 package");
      file = { url: selected.content.uri };
    }
    if (new URL(file.url).hostname !== "3d-api.si.edu") throw new Error("Unapproved Smithsonian download host");
    assertStableDownloadUrl(file.url);
    assertDownloadHost(file.url, this.source);
    if (!Number.isSafeInteger(size) || size <= 0) {
      const head = await this.request(file.url, {
        method: "HEAD",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      size = Number(head.headers.get("content-length"));
      if (!head.ok || !Number.isSafeInteger(size) || size <= 0)
        throw new Error("Smithsonian file size unavailable; manual review required");
    }
    return {
      id,
      kind: "models",
      title: String(record.title ?? asset),
      url: file.url,
      size,
      licence: "CC0-1.0",
      format: "glb",
      resolution: "original",
      sourcePage: details.descriptiveNonRepeating.record_link ?? `https://www.si.edu/object/${asset}`,
      tags: [],
    };
  }
}
