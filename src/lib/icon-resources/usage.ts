import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { IconUsageSchema } from "../../types/icon-resources";
import { readResources } from "../font-resources/registry";
import { digest, iconFile, readManifest, scoped, profilePath } from "./storage";

function publicPaths(values: unknown) {
  const paths = new Set<string>();
  function walk(value: unknown) {
    if (typeof value === "string") paths.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  }
  walk(values);
  return paths;
}
export function usedIconDerivatives(root: string, project: string, values: unknown) {
  const file = iconFile(root, project, "manifest.json");
  if (!existsSync(file)) return [];
  const manifest = readManifest(root, project),
    ids = new Set<string>(),
    paths = new Set<string>();
  function walk(value: unknown) {
    if (typeof value === "string") {
      paths.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (obj.derivativeId) {
        const usage = IconUsageSchema.parse({
          resourceId: obj.resourceId,
          derivativeId: obj.derivativeId,
          src: obj.src,
          placementId: obj.placementId,
        });
        const found = manifest.derivatives.find((d) => d.id === usage.derivativeId);
        if (!found || found.resourceId !== usage.resourceId || found.file !== usage.src)
          throw Error("Icon placement does not match its immutable export");
        ids.add(found.id);
      }
      Object.values(obj).forEach(walk);
    }
  }
  walk(values);
  return manifest.derivatives.filter(
    (d) =>
      ids.has(d.id) ||
      paths.has(d.file) ||
      (d.assetId && paths.has(`projects/${project}/assets/imported/${d.hash}.${d.options.format}`)),
  );
}
export function captureIconResources(
  root: string,
  project: string,
  values: unknown,
  add: (file: string, role: "asset" | "creative" | "config") => void,
) {
  const selected = usedIconDerivatives(root, project, values);
  if (!selected.length) return;
  const manifest = readManifest(root, project),
    registry = readResources(project, root),
    paths = publicPaths(values);
  for (const d of selected) {
    const a = manifest.acquisitions.find((a) => a.id === d.acquisitionId),
      record = registry.records.find((r) => r.id === d.resourceId);
    if (
      !a ||
      !record ||
      a.resourceId !== d.resourceId ||
      a.hash !== d.sourceHash ||
      record.hash !== a.hash ||
      record.original !== a.original ||
      digest(readFileSync(scoped(root, project, d.file))) !== d.hash
    )
      throw Error("Used icon export or original changed");
    const metadata = JSON.parse(readFileSync(scoped(root, project, a.metadataFile), "utf8"));
    if (
      JSON.stringify(metadata.candidate) !== JSON.stringify(a.candidate) ||
      metadata.variant !== a.variant ||
      record.licenceText !== a.candidate.rights.notice
    )
      throw Error("Icon rights metadata changed");
    const alias = `projects/${project}/assets/imported/${d.hash}.${d.options.format}`;
    if (d.assetId && paths.has(alias)) {
      const file = scoped(root, project, alias);
      if (digest(readFileSync(file)) !== d.hash) throw Error("Used imported icon copy changed");
      add(file, "asset");
    }
    add(scoped(root, project, d.file), "asset");
    add(scoped(root, project, a.original), "creative");
    add(scoped(root, project, record.licenceFile), "creative");
    add(scoped(root, project, a.metadataFile), "creative");
  }
  const profile = profilePath(root, project);
  if (existsSync(profile)) add(profile, "config");
}
export function iconRights(root: string, project: string, sourcePath: string, hash: string) {
  const prefix = `public/projects/${project}/`;
  if (!sourcePath.startsWith(prefix)) return undefined;
  const selected = usedIconDerivatives(root, project, sourcePath.slice("public/".length));
  if (!selected.length) return undefined;
  captureIconResources(root, project, sourcePath.slice("public/".length), () => {});
  const manifest = readManifest(root, project);
  const acquisitions = selected.map((d) => {
    if (d.hash !== hash) throw Error("Used icon bytes differ from render identity");
    return manifest.acquisitions.find((a) => a.id === d.acquisitionId)!;
  });
  const rights = acquisitions.map((a) => a.candidate.rights),
    allowed = rights.every(
      (r) => !r.brand && r.commercialAllowed === true && r.licence !== "unknown" && !!r.notice && !!r.attribution,
    );
  return {
    allowed,
    licence: [...new Set(rights.map((r) => r.licence))].join(" / "),
    attribution: [...new Set(rights.map((r) => r.attribution))].join("; "),
    issues: allowed ? [] : ["Brand permission or collection licence notice needs explicit current-hash review"],
  };
}

export function iconImportedCopies(root: string, project: string) {
  if (!existsSync(iconFile(root, project, "manifest.json"))) return new Set<string>();
  return new Set(
    readManifest(root, project)
      .derivatives.filter((d) => d.assetId)
      .map((d) => path.resolve(root, "public", `projects/${project}/assets/imported/${d.hash}.${d.options.format}`)),
  );
}
export function assertBespokeIconUsage(root: string, project: string, values: unknown) {
  if (!existsSync(iconFile(root, project, "manifest.json"))) return;
  const manifest = readManifest(root, project);
  if (manifest.derivatives.length && !usedIconDerivatives(root, project, values).length)
    throw Error(
      "Bespoke icon exports require explicit iconUsages in build.json or composition props; declare the mounted usage references before rendering",
    );
}
export function iconManagedFiles(root: string, project: string) {
  const manifestFile = iconFile(root, project, "manifest.json");
  if (!existsSync(manifestFile)) return new Set<string>();
  const manifest = readManifest(root, project),
    registry = readResources(project, root);
  const files = new Set<string>([
    manifestFile,
    profilePath(root, project),
    path.join(root, "public/projects", project, "resources/registry.json"),
  ]);
  for (const a of manifest.acquisitions) {
    files.add(scoped(root, project, a.original));
    files.add(scoped(root, project, a.metadataFile));
    const record = registry.records.find((r) => r.id === a.resourceId);
    if (record) files.add(scoped(root, project, record.licenceFile));
  }
  for (const d of manifest.derivatives) files.add(scoped(root, project, d.file));
  return files;
}
