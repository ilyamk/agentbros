import { readResourceResponse } from "../resources/http";
import { projectPath } from "../icon-resources/storage";
import {
  readFileSync,
  realpathSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { assertProjectId, validatePublicAsset } from "../render-plan";
import { ResourceMetadataSchema, ResourceRegistrySchema, type ResourceMetadata } from "../../types/font-resources";
import { inspectSfnt } from "./sfnt";
import { validateIconSvg, providerIconMetadata } from "./icons";
function safeResourcePath(projectId: string, file: string, rootDir: string) {
  const project = realpathSync(path.join(rootDir, "public/projects", projectId));
  let ancestor = file;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const relative = path.relative(project, realpathSync(ancestor));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Resource path escapes owning project");
}
export function readResources(projectId: string, rootDir = process.cwd()) {
  assertProjectId(projectId);
  const file = path.join(rootDir, "public/projects", projectId, "resources/registry.json");
  safeResourcePath(projectId, file, rootDir);
  if (!existsSync(file))
    return ResourceRegistrySchema.parse({
      version: 1,
      revision: 0,
      records: [],
    });
  validatePublicAsset(`projects/${projectId}/resources/registry.json`, rootDir);
  const registry = ResourceRegistrySchema.parse(JSON.parse(readFileSync(file, "utf8")));
  for (const record of registry.records) {
    const prefix = `projects/${projectId}/resources/originals/`;
    if (!record.original.startsWith(prefix) || !record.licenceFile.startsWith(prefix))
      throw new Error("Resource record is outside owning namespace");
    validatePublicAsset(record.original, rootDir);
    validatePublicAsset(record.licenceFile, rootDir);
    if (
      createHash("sha256")
        .update(readFileSync(path.join(rootDir, "public", record.original)))
        .digest("hex") !== record.hash ||
      readFileSync(path.join(rootDir, "public", record.licenceFile), "utf8") !== record.licenceText
    )
      throw new Error("Resource original/licence changed");
  }
  for (const record of registry.records) {
    const bytes = readFileSync(path.join(rootDir, "public", record.original));
    if (record.kind === "font") {
      const actual = inspectSfnt(bytes);
      if (
        actual.family !== record.family ||
        actual.weight !== record.weight ||
        actual.style !== record.style ||
        actual.missing(record.testedText).length
      )
        throw new Error("Resource font metadata/coverage differs from original");
    } else validateIconSvg(bytes.toString("utf8"));
  }
  return registry;
}
export function importResource(
  projectId: string,
  sourceFile: string,
  input: ResourceMetadata &
    (
      | {
          kind: "font";
          family: string;
          weight: number;
          style: "normal" | "italic";
          subset: string;
          requiredText: string;
        }
      | {
          kind: "svg-icon";
          provider: "manual" | "lucide" | "iconify" | "phosphor" | "tabler" | "simple-icons" | "svgl";
          collection: string;
          name: string;
        }
    ),
  rootDir = process.cwd(),
) {
  assertProjectId(projectId);
  projectPath(rootDir, projectId);
  const metadata = ResourceMetadataSchema.parse(
    Object.fromEntries(Object.keys(ResourceMetadataSchema.shape).map((key) => [key, input[key as keyof typeof input]])),
  );
  const bytes = readFileSync(sourceFile);
  if (bytes.length > 24_000_000) throw new Error("Resource exceeds local size limit");
  let details;
  if (input.kind === "font") {
    const actual = inspectSfnt(bytes);
    if (actual.family !== input.family || actual.weight !== input.weight || actual.style !== input.style)
      throw new Error("Supplied family/style/weight differs from actual font");
    if (actual.missing(input.requiredText).length) throw new Error("Actual font lacks required glyph coverage");
    details = {
      kind: "font" as const,
      family: input.family,
      style: input.style,
      weight: input.weight,
      subset: input.subset,
      testedText: input.requiredText,
    };
  } else {
    validateIconSvg(bytes.toString("utf8"));
    if (input.provider !== "manual") providerIconMetadata(input.provider, input.collection, input.name, metadata);
    details = {
      kind: "svg-icon" as const,
      provider: input.provider,
      collection: input.collection,
      name: input.name,
    };
  }
  const hash = createHash("sha256").update(bytes).digest("hex"),
    relative = `projects/${projectId}/resources/originals/${hash}.${input.kind === "font" ? "otf" : "svg"}`;
  const directory = path.join(rootDir, "public/projects", projectId, "resources");
  safeResourcePath(projectId, directory, rootDir);
  safeResourcePath(projectId, path.join(directory, "originals"), rootDir);
  mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, "registry.lock"),
    fd = openSync(lock, "wx");
  try {
    const id = `resource:${hash}:${createHash("sha256")
      .update(JSON.stringify({ ...metadata, ...details }))
      .digest("hex")}`;
    const registry = readResources(projectId, rootDir),
      previous = registry.records.find((record) => record.id === id);
    if (previous) return previous;
    mkdirSync(path.join(directory, "originals"), { recursive: true });
    const original = path.join(rootDir, "public", relative),
      licenceFile = relative + "." + createHash("sha256").update(metadata.licenceText).digest("hex") + ".licence.txt";
    if (existsSync(original) && createHash("sha256").update(readFileSync(original)).digest("hex") !== hash)
      throw new Error("Unregistered original collision");
    if (!existsSync(original)) writeFileSync(original, bytes, { flag: "wx" });
    if (!existsSync(path.join(rootDir, "public", licenceFile)))
      writeFileSync(path.join(rootDir, "public", licenceFile), metadata.licenceText, { flag: "wx" });
    const record = {
      ...metadata,
      ...details,
      id,
      hash,
      original: relative,
      licenceFile,
    };
    registry.records.push(record);
    registry.revision++;
    const text = JSON.stringify(ResourceRegistrySchema.parse(registry), null, 2) + "\n";
    writeFileSync(path.join(directory, `revision-${registry.revision}.json`), text, { flag: "wx" });
    const temporary = path.join(directory, randomUUID() + ".tmp");
    writeFileSync(temporary, text);
    renameSync(temporary, path.join(directory, "registry.json"));
    return record;
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
export async function acquireResource(url: string, fetcher: typeof fetch = fetch) {
  if (!url.startsWith("https://")) throw new Error("Resource acquisition requires explicit HTTPS");
  return readResourceResponse(fetcher, url, { maxBytes: 24_000_000, timeoutMs: 15_000 });
}
