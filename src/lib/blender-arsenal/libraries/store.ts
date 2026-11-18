import { pythonArgs, pythonEnvironment, pythonUv } from "../../python";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { arsenalPaths, ensureArsenalLayout, ASSET_KINDS, type AssetKind } from "../paths";
import { readResourceResponse } from "../../resources/http";
import {
  AssetId,
  AssetSchema,
  CollectionSchema,
  IndexSchema,
  ManifestSchema,
  Slug,
  UsageSchema,
  Consent,
  type Asset,
  type Manifest,
  type Source,
} from "./schemas";
import { probeAssets } from "./blender";
import { downloadFetch, assertStableDownloadUrl } from "./network";
import { LibraryAdapter, type Candidate, type Download } from "./adapters";

export function safeLayout(root: string) {
  const p = arsenalPaths(root);
  const check = (directory: string) => {
    if (!existsSync(directory)) return;
    if (lstatSync(directory).isSymbolicLink()) throw new Error(`Symlink in arsenal: ${directory}`);
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (child.isSymbolicLink()) throw new Error(`Symlink in arsenal: ${path.join(directory, child.name)}`);
      if (child.isDirectory()) check(path.join(directory, child.name));
    }
  };
  for (const directory of [p.root, p.local])
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink())
      throw new Error(`Symlink in arsenal: ${directory}`);
  check(p.library);
  check(p.downloads);
  return ensureArsenalLayout(root);
}
export function consentRecord(value: string) {
  return Consent.parse(
    value.trim().startsWith("{") ? JSON.parse(value) : { by: value, date: new Date().toISOString(), note: value },
  );
}
export function safeRelativeFile(name: string): string {
  if (
    !name ||
    name.includes("\\") ||
    path.posix.isAbsolute(name) ||
    name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === "asset.json") ||
    name.includes(":")
  )
    throw new Error("Invalid asset filename");
  return name;
}
export function readManifest(root = process.cwd()): Manifest {
  return ManifestSchema.parse(JSON.parse(readFileSync(arsenalPaths(root).librariesManifest, "utf8")));
}
export function atomicJson(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.part`;
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function detectRole(file: string): Asset["files"][number]["role"] {
  const name = path.basename(file).toLowerCase();
  const ext = path.extname(name);
  if (ext === ".blend") return "blend";
  if ([".glb", ".gltf"].includes(ext)) return "glb";
  if ([".obj", ".fbx"].includes(ext)) return "model";
  if (/(?:normal|nor|nrm)[_-]?(?:dx|directx)/.test(name)) return "normal-dx";
  if (/(?:normal|nor|nrm)(?:[_-]?(?:gl|opengl))?(?:[_ .-]|$)/.test(name)) return "normal-gl";
  if (/(?:color|colour|albedo|diffuse|diff|basecolor|base_color)(?:[_ .-]|$)/.test(name)) return "color";
  if (/rough/.test(name)) return "roughness";
  if (/metal/.test(name)) return "metalness";
  if (/displ|height|disp[_ .-]/.test(name)) return "displacement";
  if (/(?:^|[_ .-])ao(?:[_ .-]|$)|ambientocclusion|ambient_occlusion/.test(name)) return "ao";
  if ([".hdr", ".exr"].includes(ext)) return "hdri";
  return "file";
}
export function catalogUuid(name: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"))
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function confined(base: string, file: string): string {
  const resolved = path.resolve(base, file);
  const relative = path.relative(realpathSync(base), realpathSync(resolved));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Library path escapes store: ${file}`);
  return resolved;
}
/** Bundled datafiles of every installed Blender version (`Resources/<major.minor>/datafiles`), so an upgrade does not orphan the index. */
export function bundledDatafileRoots(): string[] {
  if (process.env.BLENDER_SYSTEM_DATAFILES_ROOT) return [process.env.BLENDER_SYSTEM_DATAFILES_ROOT];
  const roots: string[] = [];
  for (const app of [
    "/Applications/Blender.app",
    ...(existsSync("/Applications")
      ? readdirSync("/Applications")
          .filter((name) => /^Blender.*\.app$/.test(name) && name !== "Blender.app")
          .map((name) => `/Applications/${name}`)
      : []),
  ]) {
    const resources = path.join(app, "Contents", "Resources");
    if (!existsSync(resources)) continue;
    for (const version of readdirSync(resources))
      if (/^\d+\.\d+$/.test(version)) roots.push(path.join(resources, version, "datafiles"));
  }
  return roots;
}
export function systemFile(file: string): string {
  const resolved = realpathSync(file);
  const inside = (root: string) => {
    if (!existsSync(root)) return false;
    const relative = path.relative(realpathSync(root), resolved);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  if (!bundledDatafileRoots().some(inside)) throw new Error("Invalid bundled system file");
  return resolved;
}
export function indexBundled(root = process.cwd()) {
  const p = safeLayout(root),
    inventory = probeAssets(root, { bundled: true });
  const oldPreview = path.join(
    p.library,
    "textures",
    "essentials",
    createHash("sha256").update("studiolights/matcap/brush_thumbnail_preview.exr").digest("hex").slice(0, 24),
    "asset.json",
  );
  if (existsSync(oldPreview)) {
    const old = AssetSchema.parse(JSON.parse(readFileSync(oldPreview, "utf8")));
    if (old.files.every((file) => file.system && path.basename(file.path) === "brush_thumbnail_preview.exr"))
      rmSync(oldPreview);
  }
  for (const file of inventory.files) {
    const description = file.assets[0];
    if (!description) continue;
    const kind =
      description.category === "world" ? "hdri" : description.category === "matcap" ? "textures" : "node-groups";
    const relative = path.relative(inventory.systemRoot, file.path).split(path.sep).join("/");
    const id = `essentials:${createHash("sha256").update(relative).digest("hex").slice(0, 24)}`;
    const directory = path.join(p.library, kind, "essentials", id.split(":")[1]!);
    atomicJson(
      path.join(directory, "asset.json"),
      AssetSchema.parse({
        version: 1,
        id,
        source: "essentials",
        kind,
        title: path.basename(file.path),
        licence: "CC0-1.0",
        licenceUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        attribution: "Blender bundled Essentials (CC0)",
        sourcePage: "https://www.blender.org",
        files: [
          { path: file.path, role: kind === "hdri" ? "hdri" : kind === "node-groups" ? "blend" : "file", system: true },
        ],
        sha256: file.sha256,
        fetched: new Date().toISOString(),
        consent: {
          by: "local session",
          date: "2026-11-15",
          note: "Bundled with Blender; indexed in place, no download or copy",
        },
        tags: [description.category, ...file.assets.map((asset) => asset.name)],
        blenderAssets: file.assets,
        blenderVersion: inventory.blenderVersion,
      }),
    );
  }
  atomicJson(path.join(p.library, "blender-bundled.json"), inventory);
  buildIndex(root);
  return inventory;
}
export function buildIndex(root = process.cwd()) {
  const p = safeLayout(root);
  const assets: Asset[] = [];
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink in library: ${full}`);
      if (entry.isDirectory()) scan(full);
      else if (entry.name === "asset.json") {
        const asset = AssetSchema.parse(JSON.parse(readFileSync(full, "utf8")));
        const expected = path.join(p.library, asset.kind, asset.source, asset.id.split(":")[1]!);
        if (asset.source !== asset.id.split(":")[0] || path.dirname(full) !== expected)
          throw new Error(`Asset identity/path mismatch: ${full}`);
        for (const file of asset.files) {
          const target =
            file.system && asset.source === "essentials" ? systemFile(file.path) : confined(p.library, file.path);
          if (!lstatSync(target).isFile()) throw new Error(`Not a file: ${target}`);
        }
        if (asset.preview) confined(p.library, asset.preview);
        assets.push(asset);
      }
    }
  };
  for (const kind of ASSET_KINDS) scan(path.join(p.library, kind));
  assets.sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(assets.map((a) => a.id)).size !== assets.length) throw new Error("Duplicate local asset ids");
  atomicJson(p.libraryIndex, IndexSchema.parse({ version: 1, assets }));
  const catalogs = [...new Set(assets.map((a) => `${a.kind}/${a.source}`))].sort();
  writeFileSync(
    p.libraryCatalog,
    `# Blender Asset Catalog Definition File\nVERSION 1\n\n${catalogs.map((name) => `${catalogUuid(name)}:${name}:${name.replaceAll("/", "-")}`).join("\n")}\n`,
  );
  return { version: 1 as const, assets };
}
export function readIndex(root = process.cwd()) {
  const file = arsenalPaths(root).libraryIndex;
  return existsSync(file) ? IndexSchema.parse(JSON.parse(readFileSync(file, "utf8"))) : buildIndex(root);
}
export function rank<T extends { id: string; title: string; tags: string[] }>(assets: T[], query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return assets
    .map((asset) => {
      const id = asset.id.toLowerCase(),
        title = asset.title.toLowerCase(),
        tags = asset.tags.join(" ").toLowerCase();
      const score = words.every((word) => `${id} ${title} ${tags}`.includes(word))
        ? words.reduce(
            (sum, word) =>
              sum +
              (id.split(":")[1] === word
                ? 10
                : title === word
                  ? 8
                  : title.startsWith(word)
                    ? 5
                    : tags.includes(word)
                      ? 2
                      : 1),
            0,
          )
        : -1;
      return { asset, score };
    })
    .filter((a) => a.score >= 0)
    .sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id))
    .map((a) => a.asset);
}
export function requireApproved(source: Source, consent?: string) {
  if (source.status !== "approved")
    throw new Error(`Source ${source.id} is ${source.status}; review and approve libraries.json first`);
  if (!consent?.trim()) throw new Error('Explicit --consent "who/when/why" required');
}
export async function fetchDownload(
  item: Download,
  root: string,
  consent: string,
  request: typeof fetch = fetch,
): Promise<{ file: string; sha256: string }> {
  if (!consent?.trim()) throw new Error("Explicit download consent required");
  assertStableDownloadUrl(item.url);
  const url = new URL(item.url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Downloads require HTTPS without credentials");
  if (
    ![
      "txt",
      "zip",
      "png",
      "jpg",
      "jpeg",
      "exr",
      "hdr",
      "tif",
      "tiff",
      "blend",
      "glb",
      "gltf",
      "bin",
      "fbx",
      "obj",
      "mtl",
      "ttf",
      "otf",
    ].includes(item.format)
  )
    throw new Error("Unsupported download format");
  if (item.size > 512 * 1024 * 1024) throw new Error("Download exceeds 512 MiB limit");
  const source = readManifest(root).sources.find((source) => source.id === item.id.split(":")[0]);
  if (!source) throw new Error("Unknown download source");
  if (item.sha256) {
    const cached = path.join(safeLayout(root).downloads, `${item.sha256}.${item.format}`);
    if (existsSync(cached)) {
      const bytes = readFileSync(cached);
      if (bytes.length !== item.size || createHash("sha256").update(bytes).digest("hex") !== item.sha256)
        throw new Error("Corrupt cached download");
      return { file: cached, sha256: item.sha256 };
    }
  }
  const bytes = await readResourceResponse(downloadFetch(source, request), item.url, {
    maxBytes: item.size,
    timeoutMs: 60000,
  });
  if (item.format === "glb" && bytes.subarray(0, 4).toString("ascii") !== "glTF") throw new Error("Invalid GLB magic");
  if (
    item.gitBlobSha &&
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== item.gitBlobSha
  )
    throw new Error("Git blob SHA mismatch");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.length !== item.size ||
    (item.sha256 && sha256 !== item.sha256) ||
    (item.md5 && createHash("md5").update(bytes).digest("hex") !== item.md5)
  )
    throw new Error("Download size/hash mismatch; upstream changed (never re-pin automatically)");
  const p = safeLayout(root);
  const file = path.join(p.downloads, `${sha256}.${item.format}`);
  if (existsSync(file)) {
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== sha256)
      throw new Error("Corrupt cached download");
    return { file, sha256 };
  }
  const temporary = `${file}.${randomUUID()}.part`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { file, sha256 };
}
export function unpackAsset(
  item: Download,
  download: { file: string; sha256: string },
  source: Source,
  consent: string,
  root: string,
  dependencies: { file: string; name: string }[] = [],
): Asset {
  AssetId.parse(item.id);
  const p = safeLayout(root);
  const dest = path.join(p.library, item.kind, source.id, item.id.split(":")[1]!);
  if (item.id.split(":")[0] !== source.id) throw new Error("Source/item mismatch");
  if (existsSync(dest))
    throw new Error(`Asset already present: ${item.id}; remove it explicitly before replacing its resolution`);
  mkdirSync(path.dirname(dest), { recursive: true });
  const stage = `${dest}.${randomUUID()}.part`;
  mkdirSync(stage);
  try {
    let files: string[];
    if (item.format === "zip") {
      const result = spawnSync(
        pythonUv(),
        pythonArgs("stdlib", [
          fileURLToPath(new URL("../../../../scripts/workers/blender/avc_asset_unpack.py", import.meta.url)),
          download.file,
          stage,
        ]),
        { env: pythonEnvironment("stdlib"), encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60000 },
      );
      if (result.status !== 0) throw new Error(`Archive extraction failed: ${result.stderr.slice(-1200)}`);
      files = JSON.parse(result.stdout) as string[];
    } else {
      const name = item.name ?? `${item.id.split(":")[1]}.${item.format}`;
      safeRelativeFile(name);
      mkdirSync(path.dirname(path.join(stage, name)), { recursive: true });
      copyFileSync(download.file, path.join(stage, name));
      files = [name];
    }
    for (const dependency of dependencies) {
      safeRelativeFile(dependency.name);
      if (files.some((file) => file.toLowerCase() === dependency.name.toLowerCase()))
        throw new Error("Duplicate dependency name");
      mkdirSync(path.dirname(path.join(stage, dependency.name)), { recursive: true });
      copyFileSync(dependency.file, path.join(stage, dependency.name));
      files.push(dependency.name);
    }
    const asset = AssetSchema.parse({
      version: 1,
      id: item.id,
      source: source.id,
      kind: item.kind,
      title: item.title,
      licence: item.licence,
      licenceUrl: item.licenceUrl ?? source.licenceUrl,
      attribution:
        item.attribution ??
        source.attribution.template.replaceAll("{title}", item.title).replaceAll("{url}", item.sourcePage),
      sourcePage: item.sourcePage,
      files: files.map((file) => ({
        path: path.relative(p.library, path.join(dest, file)).split(path.sep).join("/"),
        role: detectRole(file),
      })),
      sha256: download.sha256,
      fetched: new Date().toISOString(),
      consent: consentRecord(consent),
      tags: item.tags,
    });
    const preview = asset.files.find(
      (file) =>
        file.role === "file" &&
        /\.(png|jpg|jpeg)$/i.test(file.path) &&
        (/preview|thumb/i.test(path.basename(file.path)) ||
          path.basename(file.path).toLowerCase() === `${item.id.split(":")[1]}.png`.toLowerCase()),
    );
    if (preview) asset.preview = preview.path;
    const blendFiles = files.filter((file) => file.endsWith(".blend"));
    if (blendFiles.length) {
      const inspected = probeAssets(root, { files: blendFiles.map((file) => path.join(stage, file)) });
      asset.blenderAssets = inspected.files
        .flatMap((file) => file.assets)
        .filter(
          (asset) =>
            !item.allowedAssets ||
            (item.allowedAssets.includes(asset.name) &&
              (!item.allowedCategory || asset.category === item.allowedCategory)),
        );
      if (item.allowedAssets) asset.allowedAssets = item.allowedAssets;
      if (item.allowedCategory) asset.allowedCategory = item.allowedCategory;
      asset.blenderVersion = inspected.blenderVersion;
    }
    atomicJson(path.join(stage, "asset.json"), asset);
    renameSync(stage, dest);
    return asset;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
export async function addAsset(
  id: string,
  options: { root?: string; consent?: string; resolution?: string; pin?: boolean; fetch?: typeof fetch } = {},
) {
  AssetId.parse(id);
  const root = options.root ?? process.cwd(),
    manifest = readManifest(root);
  const source = manifest.sources.find((s) => s.id === id.split(":")[0]);
  if (!source) throw new Error(`Unknown source: ${id}`);
  requireApproved(source, options.consent);
  const pinned = manifest.items.find((i) => i.id === id);
  const item = await new LibraryAdapter(source, options.fetch).resolve(id, undefined, options.resolution, pinned);
  if (!source.kinds.includes(item.kind)) throw new Error("Source does not support resolved kind");
  const download = await fetchDownload(item, root, options.consent!, options.fetch);
  const dependencies = [];
  const pinnedDependencies = [];
  for (const dependency of item.dependencies ?? []) {
    const fetched = await fetchDownload(
      {
        ...item,
        ...dependency,
        sha256: dependency.sha256,
        md5: dependency.md5,
        gitBlobSha: dependency.gitBlobSha,
        dependencies: undefined,
      },
      root,
      options.consent!,
      options.fetch,
    );
    dependencies.push({ file: fetched.file, name: dependency.name });
    pinnedDependencies.push({
      url: dependency.url,
      size: dependency.size,
      sha256: fetched.sha256,
      format: dependency.format,
      name: dependency.name,
      ...(dependency.gitBlobSha ? { gitBlobSha: dependency.gitBlobSha } : {}),
      ...(dependency.md5 ? { md5: dependency.md5 } : {}),
    });
  }
  const asset = unpackAsset(item, download, source, options.consent!, root, dependencies);
  source.consent = asset.consent;
  if (options.pin && !pinned)
    manifest.items.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      url: item.url,
      sha256: download.sha256,
      size: item.size,
      licence: item.licence,
      format: item.format,
      resolution: item.resolution,
      tags: item.tags,
      sourcePage: item.sourcePage,
      ...(item.name ? { name: item.name } : {}),
      ...(item.attribution ? { attribution: item.attribution } : {}),
      ...(item.licenceUrl ? { licenceUrl: item.licenceUrl } : {}),
      ...(item.md5 ? { md5: item.md5 } : {}),
      ...(item.allowedAssets
        ? {
            allowedAssets: item.allowedAssets,
            ...(item.allowedCategory ? { allowedCategory: item.allowedCategory } : {}),
          }
        : {}),
      ...(item.gitBlobSha ? { gitBlobSha: item.gitBlobSha } : {}),
      ...(pinnedDependencies.length ? { dependencies: pinnedDependencies } : {}),
    });
  atomicJson(arsenalPaths(root).librariesManifest, ManifestSchema.parse(manifest));
  buildIndex(root);
  return asset;
}
export async function searchAssets(
  query: string,
  options: { root?: string; kind?: AssetKind; source?: string; local?: boolean; fetch?: typeof fetch } = {},
) {
  const root = options.root ?? process.cwd();
  const local = rank(
    readIndex(root).assets.filter(
      (a) => (!options.kind || a.kind === options.kind) && (!options.source || a.source === options.source),
    ),
    query,
  );
  const remote: Candidate[] = [];
  const steps: string[] = [];
  if (!options.local)
    for (const source of readManifest(root).sources.filter(
      (s) =>
        s.status === "approved" &&
        (!options.source || s.id === options.source) &&
        (!options.kind || s.kinds.includes(options.kind)),
    )) {
      remote.push(...(await new LibraryAdapter(source, options.fetch).search(query, options.kind)));
      remote.push(
        ...rank(
          readManifest(root).items.filter(
            (i) => i.id.startsWith(`${source.id}:`) && (!options.kind || i.kind === options.kind),
          ),
          query,
        ).map((i) => ({ ...i, sourcePage: i.url })),
      );
      if (
        ["manual", "bundled", "direct-url"].includes(source.adapter) ||
        (source.adapter === "poly-pizza-api" && !process.env.POLY_PIZZA_API_KEY)
      )
        steps.push(`${source.id}: ${source.config.steps ?? "Pin exact items in libraries.json"}`);
    }
  const seen = new Set(local.map((a) => a.id));
  return {
    local,
    remote: rank(
      remote.filter((a) => !seen.has(a.id) && (!options.kind || a.kind === options.kind)),
      query,
    ),
    steps,
  };
}
export function collectionStatus(name: string, root = process.cwd()) {
  Slug.parse(name);
  const p = arsenalPaths(root);
  const collection = CollectionSchema.parse(JSON.parse(readFileSync(path.join(p.collections, `${name}.json`), "utf8")));
  const present = new Set(readIndex(root).assets.map((a) => a.id));
  const pins = new Set(readManifest(root).items.map((i) => i.id));
  return {
    ...collection,
    assets: collection.items.map((id) => ({
      id,
      status: present.has(id) ? "present" : "missing",
      pinned: pins.has(id),
      command: `pnpm blender:assets --action add --id ${id} --consent "who/when/why"`,
    })),
  };
}
export function projectCredits(project: string, root = process.cwd()) {
  Slug.parse(project);
  const p = arsenalPaths(root),
    usage = path.join(p.library, "usage.jsonl");
  const ids = new Set(
    (existsSync(usage) ? readFileSync(usage, "utf8").split("\n").filter(Boolean) : [])
      .map((line) => UsageSchema.parse(JSON.parse(line)))
      .filter(
        (u) =>
          u.project === project ||
          (!u.project && u.script.replaceAll("\\", "/").includes(`/public/projects/${project}/`)),
      )
      .map((u) => u.id),
  );
  const assets = buildIndex(root).assets;
  return [...ids].sort().map((id) => {
    const asset = assets.find((a) => a.id === id);
    if (!asset) throw new Error(`Missing credit metadata for used asset ${id}`);
    return { id, line: `${asset.title} — ${asset.licence}; ${asset.attribution}; ${asset.sourcePage}` };
  });
}

export function importArchive(
  file: string,
  sourceId: string,
  options: {
    root?: string;
    id?: string;
    kind?: AssetKind;
    title?: string;
    licence: string;
    sourcePage: string;
    consent: string;
  },
) {
  const root = options.root ?? process.cwd(),
    manifest = readManifest(root),
    source = manifest.sources.find((source) => source.id === sourceId);
  if (!source) throw new Error("Unknown manual source");
  requireApproved(source, options.consent);
  if (!["manual", "poly-pizza-api"].includes(source.adapter))
    throw new Error("Use import only for manual/key-gated sources");
  const bytes = readFileSync(file);
  if (bytes.length > 512 * 1024 * 1024 || !file.toLowerCase().endsWith(".zip"))
    throw new Error("Manual import needs a ZIP at most 512 MiB");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = options.id ?? `${sourceId}:${sha256.slice(0, 24)}`;
  AssetId.parse(id);
  const kind = options.kind ?? "models";
  if (!source.kinds.includes(kind)) throw new Error("Unsupported source kind");
  const item: Download = {
    id,
    kind,
    title: options.title ?? path.basename(file),
    tags: ["manual-import"],
    licence: options.licence,
    sourcePage: options.sourcePage,
    url: options.sourcePage,
    size: bytes.length,
    format: "zip",
    resolution: "original",
  };
  const p = safeLayout(root),
    download = path.join(p.downloads, `${sha256}.zip`);
  if (!existsSync(download)) copyFileSync(file, download);
  const asset = unpackAsset(item, { file: download, sha256 }, source, options.consent, root);
  source.consent = asset.consent;
  atomicJson(p.librariesManifest, manifest);
  buildIndex(root);
  return asset;
}
