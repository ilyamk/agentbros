import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  realpathSync,
  statSync,
  lstatSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { csvParse, tsvParse } from "d3-dsv";
import {
  VizTextureManifestSchema,
  VizSpecSchema,
  VizBundleSchema,
  type VizBundle,
  type VizSpec,
} from "../../types/viz";
import { projectDir } from "../pipeline/paths";
import { compileViz, vizHash } from "./compile";

export function localFile(root: string, file: string, maxBytes = 8 * 1024 * 1024): string {
  const resolved = realpathSync(path.resolve(root, file));
  const rel = path.relative(realpathSync(root), resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !statSync(resolved).isFile())
    throw new Error("Path escapes scope or is not a file");
  if (statSync(resolved).size > maxBytes) throw new Error(`Input exceeds ${maxBytes} bytes`);
  return resolved;
}
export function assertVizDestination(file: string): void {
  const root = realpathSync(process.cwd());
  const lexical = path.relative(root, path.resolve(file));
  if (lexical.startsWith("..") || path.isAbsolute(lexical)) throw new Error("Output path escapes workspace");
  let ancestor = path.resolve(file);
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const rel = path.relative(root, realpathSync(ancestor));
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Output path escapes workspace");
  let cursor = path.resolve(file);
  while (cursor !== root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error("Visualisation output cannot use symlinks");
    cursor = path.dirname(cursor);
  }
}
export function sceneRoot(project: string, scene: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(scene)) throw new Error("Invalid scene ID");
  return path.join(projectDir(project), "pipeline", "viz", scene);
}
export async function prepareViz(
  project: string,
  raw: unknown,
  options: { dryRun?: boolean; expectedRevision?: string; scopeRoot?: string } = {},
) {
  const spec = VizSpecSchema.parse(raw);
  const root = options.scopeRoot ?? process.cwd();
  const sourceHashes: Record<string, string> = {};
  const sourceCopies: Record<string, string> = {};
  if (spec.source) {
    if (spec.data.length) throw new Error("Choose inline data or source");
    const file = localFile(root, spec.source.path);
    const bytes = readFileSync(file, "utf8");
    sourceHashes[spec.source.path] = createHash("sha256").update(bytes).digest("hex");
    sourceCopies[spec.source.path] = bytes;
    const parsed: unknown =
      spec.source.format === "json"
        ? JSON.parse(bytes)
        : (spec.source.format === "csv" ? csvParse : tsvParse)(bytes.replace(/^\uFEFF/, ""));
    if (!Array.isArray(parsed)) throw new Error("Source must contain an array of records");
    const columns = spec.source.columns;
    spec.data = parsed.map((row: Record<string, unknown>) => {
      const numeric = (key: string | undefined): number | null | undefined => {
        if (!key) return undefined;
        const value = row[key];
        if (value === null || value === "") return null;
        if (
          value === undefined ||
          !["number", "string"].includes(typeof value) ||
          (typeof value === "string" && !value.trim()) ||
          !Number.isFinite(Number(value))
        )
          throw new Error(`Invalid numeric column ${key}`);
        return Number(value);
      };
      return {
        id: String(row[columns.id] ?? ""),
        label: String(row[columns.label] ?? ""),
        ...(columns.value ? { value: numeric(columns.value) } : {}),
        ...(columns.x ? { x: numeric(columns.x) ?? undefined } : {}),
        ...(columns.date ? { date: String(row[columns.date]) } : {}),
        ...(columns.series ? { series: String(row[columns.series]) } : {}),
        ...(columns.parent && row[columns.parent] ? { parent: String(row[columns.parent]) } : {}),
      };
    });
  }
  if (spec.textureManifest) {
    if (spec.textures) throw new Error("Choose textureManifest or embedded textures");
    const file = localFile(root, spec.textureManifest.path),
      bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== spec.textureManifest.sha256)
      throw new Error("Texture manifest hash mismatch");
    spec.textures = VizTextureManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    sourceCopies[spec.textureManifest.path] = bytes.toString("utf8");
    sourceHashes[spec.textureManifest.path] = spec.textureManifest.sha256;
  }
  if (spec.textures)
    for (const [role, map] of Object.entries(spec.textures.maps)) {
      if (!map) continue;
      if (map.colourSpace !== (role === "baseColor" ? "srgb" : "linear"))
        throw new Error(`Incorrect colour space for ${role}`);
      const file = localFile(root, path.join("public", map.path));
      if (createHash("sha256").update(readFileSync(file)).digest("hex") !== map.sha256)
        throw new Error(`Texture hash mismatch: ${role}`);
    }
  const normalised = VizSpecSchema.parse(spec);
  const plans = await Promise.all(normalised.formats.map((format) => compileViz(normalised, format)));
  const hash = vizHash({ version: 1, plans, sourceHashes, sourceCopies });
  const bundle = VizBundleSchema.parse({ version: 1, hash, plans, sourceHashes, sourceCopies });
  if (Buffer.byteLength(JSON.stringify(bundle)) > 64 * 1024 * 1024) throw new Error("Compiled revision exceeds 64 MiB");
  const dir = sceneRoot(project, spec.sceneId),
    current = path.join(dir, "current.json");
  assertVizDestination(current);
  assertVizDestination(path.join(dir, "revisions"));
  const previous = existsSync(current) ? (JSON.parse(readFileSync(current, "utf8")) as { hash: string }) : undefined;
  if (previous && options.expectedRevision !== previous.hash)
    throw new Error("Scene revision conflict; provide expected-revision");
  if (!previous && options.expectedRevision) throw new Error("Scene does not have that revision");
  const destination = path.join(dir, "revisions", hash, "bundle.json");
  assertVizDestination(destination);
  if (!options.dryRun) {
    mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, "prepare.lock");
    assertVizDestination(lock);
    const fd = openSync(lock, "wx");
    try {
      const actual = existsSync(current)
        ? (JSON.parse(readFileSync(current, "utf8")) as { hash: string }).hash
        : undefined;
      if (actual !== previous?.hash) throw new Error("Scene revision changed during preparation");
      mkdirSync(path.dirname(destination), { recursive: true });
      if (existsSync(destination)) {
        if (readFileSync(destination, "utf8") !== JSON.stringify(bundle))
          throw new Error("Existing revision is corrupt");
      } else writeFileSync(destination, JSON.stringify(bundle), { flag: "wx" });
      const temporary = `${current}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ hash }), { flag: "wx" });
      renameSync(temporary, current);
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  return { bundle, path: destination, previous: previous?.hash };
}
export function readViz(project: string, scene: string, revision?: string): { bundle: VizBundle; path: string } {
  const dir = sceneRoot(project, scene);
  const hash = revision ?? (JSON.parse(readFileSync(path.join(dir, "current.json"), "utf8")) as { hash: string }).hash;
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid revision hash");
  const file = localFile(process.cwd(), path.join(dir, "revisions", hash, "bundle.json"), 64 * 1024 * 1024);
  const bundle = VizBundleSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (
    bundle.hash !== hash ||
    vizHash({
      version: 1,
      plans: bundle.plans,
      sourceHashes: bundle.sourceHashes,
      sourceCopies: bundle.sourceCopies,
    }) !== hash
  )
    throw new Error("Corrupt visualisation revision");
  return { bundle, path: file };
}
export function exampleViz(recipe: VizSpec["recipe"]): VizSpec {
  if (recipe.startsWith("process"))
    return VizSpecSchema.parse({
      version: 1,
      sceneId: "example",
      recipe,
      title: "From source to decision",
      groups: [
        { id: "inputs", label: "Inputs" },
        { id: "results", label: "Results" },
      ],
      data: [
        { id: "collect", label: "Collect", group: "inputs", ports: [{ id: "collect-out", side: "EAST" }] },
        {
          id: "validate",
          label: "Validate",
          group: "inputs",
          ports: [
            { id: "validate-in", side: "WEST" },
            { id: "validate-out", side: "EAST" },
          ],
        },
        {
          id: "analyse",
          label: "Analyse",
          group: "results",
          ports: [
            { id: "analyse-in", side: "WEST" },
            { id: "analyse-out", side: "EAST" },
          ],
        },
        { id: "decide", label: "Decide", group: "results", ports: [{ id: "decide-in", side: "WEST" }] },
      ],
      edges: [
        {
          id: "collected",
          source: "collect",
          target: "validate",
          sourcePort: "collect-out",
          targetPort: "validate-in",
        },
        {
          id: "validated",
          source: "validate",
          target: "analyse",
          sourcePort: "validate-out",
          targetPort: "analyse-in",
        },
        { id: "analysed", source: "analyse", target: "decide", sourcePort: "analyse-out", targetPort: "decide-in" },
      ],
    });
  if (recipe.startsWith("network"))
    return VizSpecSchema.parse({
      version: 1,
      sceneId: "example",
      recipe,
      title: "Connected services",
      data: [
        { id: "client", label: "Client" },
        { id: "gateway", label: "Gateway" },
        { id: "identity", label: "Identity" },
        { id: "compute", label: "Compute" },
        { id: "database", label: "Database" },
        { id: "events", label: "Events" },
      ],
      edges: [
        { id: "request", source: "client", target: "gateway" },
        { id: "auth", source: "gateway", target: "identity" },
        { id: "task", source: "gateway", target: "compute" },
        { id: "read", source: "compute", target: "database" },
        { id: "emit", source: "compute", target: "events" },
        { id: "notify", source: "events", target: "client" },
      ],
    });
  return VizSpecSchema.parse({
    version: 1,
    sceneId: "example",
    recipe,
    data: [
      { id: "one", label: "First", value: 10 },
      { id: "two", label: "Second", value: 20, parent: "one" },
    ],
    edges: [{ id: "link", source: "one", target: "two", value: 10 }],
  });
}
