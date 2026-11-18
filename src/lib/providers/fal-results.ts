import path from "node:path";
import { CliErrorObject } from "../cli";
import { trustedArtifactUrl } from "../jobs/model-artifacts";
import type { OutputKind } from "../../types/fal-catalog";
import type { JsonSchema } from "./fal-openapi";

/** An endpoint's result schema: the `output` of a snapshot plus its component schemas for `$ref`. */
export type ResultSchema = { schema: JsonSchema; components?: Record<string, JsonSchema> };
export type ExtractedFile = {
  /** JSON pointer of the file object (or URL string) inside the result, e.g. `/images/0`. */
  path: string;
  url: string;
  kind: OutputKind;
  /** Whether the URL is on the trusted fal media host list. Only files that are downloaded must be. */
  trusted: boolean;
  contentType?: string;
  fileName?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSec?: number;
};
/** `untrustedUrls` lists files whose URL is off the trusted host list (for example an echoed input URL); they are never downloaded. */
export type ExtractedArtifacts = {
  files: ExtractedFile[];
  data: Record<string, unknown>;
  untrustedUrls: Array<{ path: string; url: string }>;
};

const MODEL3D_EXTENSIONS = new Set([".glb", ".gltf", ".obj", ".ply", ".usdz", ".fbx", ".stl"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"]);
/** Top-level URL strings older results used instead of a file object. */
const LEGACY_URL_FIELDS = new Set(["url", "image_url", "video_url", "audio_url"]);
const MAX_DEPTH = 32;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const refName = (ref: unknown) => (typeof ref === "string" ? ref.split("/").at(-1) : undefined);

/** The lower-case extension of a file name or URL path, `""` when there is none. */
export function artifactExtension(file: Pick<ExtractedFile, "url" | "fileName">): string {
  const fromName = file.fileName ? path.extname(file.fileName).toLowerCase() : "";
  if (fromName) return fromName;
  try {
    return path.posix.extname(new URL(file.url).pathname).toLowerCase();
  } catch {
    return "";
  }
}

/** Kind of one file: 3D/weights extension, then MIME, then schema ref name, then media extension, then field name. */
export function fileKind(hints: {
  url: string;
  contentType?: string;
  fileName?: string;
  field?: string;
  ref?: string;
}): OutputKind {
  const extension = artifactExtension(hints);
  if (MODEL3D_EXTENSIONS.has(extension)) return "model3d";
  if (extension === ".safetensors") return "weights";
  const mime = hints.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("model/")) return "model3d";
  const ref = hints.ref ?? "";
  if (/Image(File)?$/.test(ref)) return "image";
  if (/Video(File)?$/.test(ref)) return "video";
  if (/Audio(File)?$/.test(ref)) return "audio";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  const field = (hints.field ?? "").toLowerCase();
  if (/(^|_)(glb|gltf|mesh|model_?3d|model_urls)($|_)/.test(field)) return "model3d";
  if (/(^|_)(lora|weights|safetensors)($|_)/.test(field)) return "weights";
  if (/(^|_)(images?|thumbnails?|masks?|frames?)($|_)/.test(field)) return "image";
  if (/(^|_)(videos?)($|_)/.test(field)) return "video";
  if (/(^|_)(audios?|speech|voice|song|music)($|_)/.test(field)) return "audio";
  return "file";
}

/** Field names under which a bare `{ url }` object is still a file (older image/video/audio results). */
const MEDIA_FIELD =
  /(^|_)(images?|videos?|audios?|output|outputs|thumbnails?|masks?|files?|glb|mesh|model_?3d|model_urls)($|_)/i;
const FILE_REF = /(File|Image|Video|Audio)$/;

export function isTrustedResultUrl(url: string, provider = "fal"): boolean {
  try {
    trustedArtifactUrl(url, provider);
    return true;
  } catch {
    return false;
  }
}
/** Throws VALIDATION unless every file is on the trusted host list: call it on the files that will be downloaded. */
export function assertTrustedFiles(files: Array<Pick<ExtractedFile, "url">>): void {
  if (files.some((file) => !isTrustedResultUrl(file.url)))
    throw new CliErrorObject({ code: "VALIDATION", message: "Result URL must use a trusted fal media HTTPS host." });
}

type Walker = { provider: string; components: Record<string, JsonSchema>; files: ExtractedFile[] };

/** Follows `$ref` and picks the `anyOf`/`oneOf`/`allOf` branch that matches the value's shape. */
function resolve(
  schema: JsonSchema | undefined,
  value: unknown,
  walker: Walker,
  ref?: string,
  depth = 0,
): { schema?: JsonSchema; ref?: string } {
  if (!schema || depth > MAX_DEPTH) return { ref };
  if (typeof schema.$ref === "string") {
    const name = refName(schema.$ref);
    return resolve(name ? walker.components[name] : undefined, value, walker, name, depth + 1);
  }
  const branches = [schema.anyOf, schema.oneOf, schema.allOf].find(Array.isArray) as JsonSchema[] | undefined;
  if (branches) {
    const wanted = Array.isArray(value) ? "array" : isRecord(value) ? "object" : typeof value;
    const fits = (branch: JsonSchema) => {
      const resolved = resolve(branch, value, walker, undefined, depth + 1).schema;
      if (!resolved) return typeof branch.$ref === "string" && wanted === "object";
      const type = resolved.type;
      if (type === undefined) return wanted === "object" ? !!resolved.properties : true;
      return Array.isArray(type)
        ? type.includes(wanted)
        : type === wanted || (type === "integer" && wanted === "number");
    };
    const branch = branches.find((candidate) => !(candidate.type === "null") && fits(candidate));
    return branch ? resolve(branch, value, walker, ref, depth + 1) : { schema, ref };
  }
  return { schema, ref };
}

function asFile(
  value: Record<string, unknown>,
  pointer: string,
  field: string | undefined,
  ref: string | undefined,
  provider: string,
): ExtractedFile | undefined {
  if (typeof value.url !== "string") return undefined;
  const contentType = typeof value.content_type === "string" ? value.content_type : undefined;
  const fileName = typeof value.file_name === "string" ? value.file_name : undefined;
  if (!contentType && !fileName && !(ref && FILE_REF.test(ref)) && !(field && MEDIA_FIELD.test(field)))
    return undefined;
  const number = (key: string) =>
    typeof value[key] === "number" && Number.isFinite(value[key]) ? (value[key] as number) : undefined;
  const width = number("width"),
    height = number("height"),
    durationSec = number("duration"),
    fileSize = number("file_size");
  return {
    path: pointer,
    url: value.url,
    trusted: isTrustedResultUrl(value.url, provider),
    kind: fileKind({ url: value.url, contentType, fileName, field, ref }),
    ...(contentType ? { contentType } : {}),
    ...(fileName ? { fileName } : {}),
    ...(fileSize !== undefined ? { fileSize } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
  };
}

const escapePointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

function walk(
  value: unknown,
  schema: JsonSchema | undefined,
  pointer: string,
  field: string | undefined,
  walker: Walker,
  depth: number,
): void {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  const resolved = resolve(schema, value, walker);
  if (Array.isArray(value)) {
    const items = resolved.schema?.items as JsonSchema | undefined;
    const prefix = resolved.schema?.prefixItems as JsonSchema[] | undefined;
    value.forEach((item, index) =>
      walk(item, prefix?.[index] ?? items, `${pointer}/${index}`, field, walker, depth + 1),
    );
    return;
  }
  if (!isRecord(value)) return;
  const file = asFile(value, pointer, field, resolved.ref, walker.provider);
  if (file) {
    walker.files.push(file);
    return;
  }
  const properties = (resolved.schema?.properties ?? {}) as Record<string, JsonSchema>;
  const additional = isRecord(resolved.schema?.additionalProperties)
    ? (resolved.schema!.additionalProperties as JsonSchema)
    : undefined;
  for (const [key, child] of Object.entries(value))
    walk(
      child,
      Object.hasOwn(properties, key) ? properties[key] : additional,
      `${pointer}/${escapePointer(key)}`,
      key,
      walker,
      depth + 1,
    );
}

/**
 * Splits a provider result into files (each marked `trusted` against the host allow-list, untrusted
 * ones also listed in `untrustedUrls`) and the top-level fields that hold no file (`text`, `chunks`,
 * `output`, `usage`, `seed` ...). It never throws for a host: callers check the files they download.
 * The output schema guides the walk when known; without it the result is walked generically.
 */
export function extractArtifacts(
  output: ResultSchema | undefined,
  result: Record<string, unknown>,
  provider = "fal",
): ExtractedArtifacts {
  if (!isRecord(result))
    throw new CliErrorObject({ code: "VALIDATION", message: "Provider result must be an object." });
  const walker: Walker = { provider, components: output?.components ?? {}, files: [] };
  const root = resolve(output?.schema, result, walker).schema;
  const properties = (root?.properties ?? {}) as Record<string, JsonSchema>;
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    const before = walker.files.length;
    if (typeof value === "string" && LEGACY_URL_FIELDS.has(key) && /^https?:\/\//i.test(value)) {
      walker.files.push({
        path: `/${escapePointer(key)}`,
        url: value,
        trusted: isTrustedResultUrl(value, provider),
        kind: fileKind({ url: value, field: key === "url" ? undefined : key.replace(/_url$/, "") }),
      });
      continue;
    }
    walk(value, Object.hasOwn(properties, key) ? properties[key] : undefined, `/${escapePointer(key)}`, key, walker, 1);
    if (walker.files.length === before && value !== null && value !== undefined) data[key] = value;
  }
  return {
    files: walker.files,
    data,
    untrustedUrls: walker.files
      .filter((file) => !file.trusted)
      .map(({ path: pointer, url }) => ({ path: pointer, url })),
  };
}

const FILE_PRIORITY: OutputKind[] = ["model3d", "video", "audio", "image", "weights", "file"];
const TEXT_FIELDS = ["text", "output", "transcript", "transcription", "response", "content", "lyrics"];
/** Primary plan/output kind: prefer files, then text, then JSON; result strings identify text. */
export function primaryKind(
  extracted: Pick<ExtractedArtifacts, "files" | "data"> | OutputKind[],
): OutputKind | undefined {
  if (Array.isArray(extracted)) {
    const priority: OutputKind[] = [...FILE_PRIORITY, "text", "json"];
    return priority.find((kind) => extracted.includes(kind));
  }
  for (const kind of FILE_PRIORITY) if (extracted.files.some((file) => file.kind === kind)) return kind;
  if (TEXT_FIELDS.some((key) => typeof extracted.data[key] === "string")) return "text";
  return Object.keys(extracted.data).length ? "json" : undefined;
}
