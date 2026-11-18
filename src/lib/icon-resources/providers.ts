import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { IconCandidateSchema, type IconCandidate, type IconProvider } from "../../types/icon-resources";
import { IconHttp } from "./http";
import { CliErrorObject } from "../cli";

const require = createRequire(import.meta.url);
const packages = {
  phosphor: "@phosphor-icons/core",
  lucide: "lucide-static",
  tabler: "@tabler/icons",
  "simple-icons": "simple-icons",
};
const websites = {
  phosphor: "https://phosphoricons.com",
  lucide: "https://lucide.dev",
  tabler: "https://tabler.io/icons",
  "simple-icons": "https://simpleicons.org",
};
function packageRoot(name: string) {
  for (const base of require.resolve.paths(name) ?? []) {
    const dir = path.join(base, name);
    if (existsSync(path.join(dir, "package.json"))) return dir;
  }
  throw new CliErrorObject({
    code: "ASSET_MISSING",
    message: `Install locked dependencies with pnpm install: ${name}`,
  });
}
const memo = new Map<string, IconCandidate[]>();
export function localCatalogue(provider: keyof typeof packages): IconCandidate[] {
  const old = memo.get(provider);
  if (old) return old;
  const root = packageRoot(packages[provider]);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  const notice = readFileSync(path.join(root, provider === "simple-icons" ? "DISCLAIMER.md" : "LICENSE"), "utf8");
  const base = {
    provider,
    collection: provider,
    kind: provider === "simple-icons" ? "brand" : "icon",
    version: pkg.version,
    source: websites[provider],
    rights: {
      licence: provider === "lucide" ? "ISC" : provider === "simple-icons" ? "unknown" : "MIT",
      licenceUrl: provider === "lucide" ? "https://lucide.dev/license" : `${websites[provider]}`,
      notice,
      attribution: packages[provider],
      commercialAllowed: provider === "simple-icons" ? "unknown" : true,
      brand: provider === "simple-icons",
    },
  };
  let rows: unknown[];
  if (provider === "phosphor") {
    const entries = (
      require("@phosphor-icons/core") as { icons: { name: string; tags: string[]; categories: string[] }[] }
    ).icons;
    rows = entries.map((i) => ({
      ...base,
      name: i.name,
      title: i.name,
      tags: [...i.tags, ...i.categories].map(String),
      variants: ["thin", "light", "regular", "bold", "fill", "duotone"],
    }));
  } else if (provider === "lucide") {
    const tags = JSON.parse(readFileSync(path.join(root, "tags.json"), "utf8")) as Record<string, string[]>;
    rows = readdirSync(path.join(root, "icons"))
      .filter((n) => n.endsWith(".svg"))
      .map((file) => {
        const name = file.slice(0, -4);
        return { ...base, name, title: name, tags: (tags[name] ?? []).map(String), variants: ["outline"] };
      });
  } else if (provider === "tabler") {
    const icons = JSON.parse(readFileSync(path.join(root, "icons.json"), "utf8")) as Record<
      string,
      { tags: string[]; category: string; styles: Record<string, unknown> }
    >;
    rows = Object.entries(icons).map(([name, i]) => ({
      ...base,
      name,
      title: name,
      tags: [...i.tags, i.category].map(String),
      variants: Object.keys(i.styles),
    }));
  } else {
    const icons = JSON.parse(readFileSync(path.join(root, "data/simple-icons.json"), "utf8")) as {
      title: string;
      slug: string;
      hex: string;
      source: string;
      guidelines?: string;
      license?: { type: string; url?: string };
      aliases?: { aka?: string[] };
    }[];
    rows = icons.map((i) => ({
      ...base,
      name: i.slug,
      title: i.title,
      brandColour: `#${i.hex}`,
      source: i.source,
      tags: i.aliases?.aka ?? [],
      variants: ["original", "mono"],
      rights: {
        ...base.rights,
        guidelines: i.guidelines,
        licence: i.license?.type ?? "unknown",
        licenceUrl: i.license?.url ?? "https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md",
      },
    }));
  }
  const catalogue = rows.map((row) => {
    const item = row as { name: string; tags: unknown[] };
    return IconCandidateSchema.parse({
      ...(row as object),
      tags: item.tags.map(String),
      id: `${provider}:${item.name}`,
    });
  });
  memo.set(provider, catalogue);
  return catalogue;
}
export function localSvg(candidate: IconCandidate, variant: string) {
  const provider = candidate.provider as keyof typeof packages,
    root = packageRoot(packages[provider]);
  const name = candidate.name;
  const relative =
    provider === "phosphor"
      ? `assets/${variant}/${name}${variant === "regular" ? "" : `-${variant}`}.svg`
      : provider === "tabler"
        ? `icons/${variant}/${name}.svg`
        : `icons/${name}.svg`;
  const svg = readFileSync(path.join(root, relative), "utf8");
  return provider === "simple-icons" && variant === "original"
    ? svg.replace("<svg ", `<svg fill="${candidate.brandColour}" `)
    : svg;
}
const SvglSchema = z.array(
  z.object({
    id: z.number(),
    title: z.string(),
    category: z.union([z.string(), z.array(z.string())]),
    route: z.union([z.string(), z.object({ light: z.string(), dark: z.string() })]),
    wordmark: z.union([z.string(), z.object({ light: z.string(), dark: z.string() })]).optional(),
    url: z.string(),
    brandUrl: z.string().optional(),
  }),
);
export async function svglCatalogue(http: IconHttp, query: string) {
  const rows = SvglSchema.parse(await http.json(`https://api.svgl.app?search=${encodeURIComponent(query)}`));
  return rows.map((i) => {
    const routes: Record<string, string> = {};
    if (typeof i.route === "string") routes.original = i.route;
    else {
      routes.light = i.route.light;
      routes.dark = i.route.dark;
    }
    if (typeof i.wordmark === "string") routes.wordmark = i.wordmark;
    else if (i.wordmark) {
      routes["wordmark-light"] = i.wordmark.light;
      routes["wordmark-dark"] = i.wordmark.dark;
    }
    return IconCandidateSchema.parse({
      id: `svgl:${i.id}`,
      provider: "svgl",
      collection: "svgl",
      name: String(i.id),
      title: i.title,
      kind: "brand",
      tags: Array.isArray(i.category) ? i.category : [i.category],
      variants: Object.keys(routes),
      version: "live",
      source: i.url,
      routes,
      rights: {
        licence: "unknown",
        licenceUrl: i.brandUrl ?? i.url,
        notice: "SVGL catalogue metadata is not a grant of rights to this brand.",
        attribution: i.title,
        commercialAllowed: "unknown",
        brand: true,
        guidelines: i.brandUrl,
      },
    });
  });
}
const CollectionSchema = z.object({
  prefix: z.string(),
  info: z.object({
    name: z.string().optional(),
    author: z.object({ name: z.string() }),
    license: z.object({ title: z.string(), spdx: z.string().optional(), url: z.string().url() }),
  }),
});
export async function iconifyCandidate(http: IconHttp, collection: string, name: string) {
  const data = CollectionSchema.parse(
    await http.json(`https://api.iconify.design/collection?prefix=${collection}&info=true`),
  );
  if (data.prefix !== collection) throw Error("Iconify collection identity changed");
  return IconCandidateSchema.parse({
    id: `iconify:${collection}:${name}`,
    provider: "iconify",
    collection,
    name,
    title: name,
    kind: collection === "simple-icons" ? "brand" : "icon",
    tags: [],
    variants: ["original"],
    version: "live",
    source: `https://api.iconify.design/${collection}/${name}.svg`,
    rights: {
      licence: data.info.license.spdx ?? data.info.license.title,
      licenceUrl: data.info.license.url,
      notice: JSON.stringify(data.info),
      attribution: data.info.author.name,
      commercialAllowed: "unknown",
      brand: collection === "simple-icons",
    },
  });
}
export const providers: IconProvider[] = ["phosphor", "lucide", "tabler", "simple-icons", "iconify", "svgl"];
export function capabilities() {
  return providers.map((provider) => ({
    provider,
    keyRequired: false,
    network: ["iconify", "svgl"].includes(provider),
    kind: ["simple-icons", "svgl"].includes(provider) ? "brand" : "icon",
    search: true,
    inspect: true,
    acquire: true,
    formats: ["svg", "png", "webp"],
  }));
}
