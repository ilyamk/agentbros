import path from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { MediaMetadata } from "../providers/json-schema-validate";
import type { AssetRecord } from "../../types/assets";
import { readAssetRegistry, hashFile } from "./registry";
import { readRemoteMedia } from "./remote-media";
import { mediaKindForKey } from "../providers/higgsfield/media-fields";
import { validatePublicAsset } from "../render-plan";
import { assertPathWithin, CliErrorObject } from "../cli";
import {
  FalOperationRequestSchema,
  FalEndpointRequestSchema,
  type FalAnyRequest,
  type FalEndpointRequest,
} from "../../types/generation";

function measuredMedia(asset: AssetRecord): MediaMetadata[string] {
  const fps = asset.media.frameRate?.split("/").map(Number);
  const numericFps = fps ? fps[0] / (fps[1] ?? 1) : undefined;
  return {
    bytes: asset.files.bytes,
    contentType: asset.files.mime,
    ...(asset.media.width === undefined ? {} : { width: asset.media.width }),
    ...(asset.media.height === undefined ? {} : { height: asset.media.height }),
    ...(asset.media.durationSec ? { durationSec: asset.media.durationSec } : {}),
    ...(numericFps && Number.isFinite(numericFps) ? { fps: numericFps } : {}),
  };
}

/** Read measured quantities only for immutable imported references; remote URLs need explicit context. */
export function importedReferenceMedia(
  input: Record<string, unknown>,
  projectId?: string,
  rootDir = process.cwd(),
): MediaMetadata {
  const media: MediaMetadata = {};
  let registry: ReturnType<typeof readAssetRegistry> | undefined;
  const visit = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("asset://")) {
      const match = /^asset:\/\/sha256\/([a-f0-9]{64})$/.exec(value);
      if (!match || !projectId)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: "Use asset://sha256/HASH with --project for imported references.",
        });
      registry ??= readAssetRegistry(projectId, rootDir);
      const asset = registry.assets.find((row) => row.hash === match[1]);
      if (!asset)
        throw new CliErrorObject({
          code: "FILE_NOT_FOUND",
          message: "Imported reference is not registered in this project.",
        });
      media[value] = measuredMedia(asset);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(input);
  return media;
}

/** The type a file's leading bytes declare, when they are one of the common signatures; otherwise undefined. */
function sniffMime(bytes: Buffer): string | undefined {
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString("latin1");
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (/^GIF8[79]a$/.test(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  return undefined;
}

/** Resolve imported IDs and contained local paths into inline data URIs. No upload/API. */
export function resolveImportedReferences<T extends FalAnyRequest>(
  requestInput: T,
  projectId?: string,
  rootDir = process.cwd(),
  maxBytes = 32 * 1024 * 1024,
  scopeRoot?: string,
) {
  const request =
      "endpoint" in requestInput
        ? FalEndpointRequestSchema.parse(requestInput)
        : FalOperationRequestSchema.parse(requestInput),
    referenceAssetIds: string[] = [],
    metadata = { ...request.context?.media };
  // Prepared Genjutsu inputs are bounded local originals, including a selected video segment.
  if (
    "endpoint" in request &&
    request.provider === "higgsfield" &&
    /^higgsfield\/genjutsu\//.test(request.endpoint) &&
    request.context?.modelPreparation &&
    maxBytes === 32 * 1024 * 1024
  )
    maxBytes = 256 * 1024 * 1024;
  let registry: ReturnType<typeof readAssetRegistry> | undefined,
    totalBytes = 0;
  const cache = new Map<string, string>();
  const higgsfield = "endpoint" in request && request.provider === "higgsfield";
  const mib = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 6 : 2));
  const remote = new Map<string, ReturnType<typeof readRemoteMedia>>();
  if (request.context?.remoteMedia?.length) {
    if (!("endpoint" in request) || request.provider !== "higgsfield" || !projectId)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Pinned remote media requires a Higgsfield request and --project.",
      });
    for (const binding of request.context.remoteMedia) {
      const data = readRemoteMedia(projectId, binding, rootDir);
      if (remote.has(data.receipt.mediaUrl))
        throw new CliErrorObject({ code: "VALIDATION", message: "Duplicate remote URL bindings are ambiguous." });
      if (scopeRoot)
        assertPathWithin(
          realpathSync(scopeRoot),
          realpathSync(path.resolve(rootDir, "public", data.asset.files.original)),
        );
      remote.set(data.receipt.mediaUrl, data);
    }
  }
  const usedRemote = new Set<string>();
  const visit = (value: unknown, key = "input"): unknown => {
    if (typeof value === "string" && /(?:^|_)url$/.test(key) && remote.has(value)) {
      const data = remote.get(value)!;
      const expected = mediaKindForKey(key);
      if (expected && expected !== data.asset.kind)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: `Remote ${data.asset.kind} cannot be attached to ${key}; acquire a verified ${expected} original.`,
        });
      metadata[value] = measuredMedia(data.asset);
      referenceAssetIds.push(data.asset.id);
      usedRemote.add(value);
      return value;
    }
    // A plain local path in a provider URL field is inlined as a data URI for every provider (fal since 2026-11-17),
    // contained in the trusted scope root or, for fal without one, the working directory.
    let localSource: string | undefined;
    if (typeof value === "string" && /_url$/.test(key) && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      const source = path.resolve(rootDir, value);
      localSource = existsSync(source) ? realpathSync(source) : source;
      if (scopeRoot) assertPathWithin(realpathSync(scopeRoot), localSource);
      else if (!higgsfield) assertPathWithin(realpathSync(rootDir), localSource);
    }
    if (typeof value === "string" && localSource !== undefined) {
      const source = localSource;
      const mimes: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".avif": "image/avif",
        ".bmp": "image/bmp",
        ".tiff": "image/tiff",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
      };
      const mime = mimes[path.extname(value).toLowerCase()];
      if (!mime || !existsSync(source) || !statSync(source).isFile())
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `${higgsfield ? "Higgsfield" : "fal"} local reference ${key} must be an existing image, audio or video file (${Object.keys(mimes).join(", ")}).`,
        });
      const cacheKey = `${mime}:${source}`;
      if (cache.has(cacheKey)) return cache.get(cacheKey)!;
      totalBytes += statSync(source).size;
      if (totalBytes > maxBytes)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: `Local references total ${mib(totalBytes)} MiB, over the ${mib(maxBytes)} MiB inline limit; use smaller files or an uploaded HTTPS URL.`,
        });
      const bytes = readFileSync(source);
      const inline = `data:${sniffMime(bytes) ?? mime};base64,${bytes.toString("base64")}`;
      cache.set(cacheKey, inline);
      return inline;
    }
    if (typeof value === "string" && value.startsWith("asset://")) {
      if (!/_url$/.test(key))
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: "Imported references may appear only in provider URL fields",
        });
      const match = value.match(/^asset:\/\/sha256\/([a-f0-9]{64})$/);
      if (!match || !projectId)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: "Use asset://sha256/HASH with --project for imported references",
        });
      if (cache.has(value)) return cache.get(value)!;
      registry ??= readAssetRegistry(projectId, rootDir);
      const asset = registry.assets.find((asset) => asset.id === `sha256:${match[1]}`);
      if (!asset)
        throw new CliErrorObject({
          code: "FILE_NOT_FOUND",
          message: "Imported reference is not registered in this project",
        });
      validatePublicAsset(asset.files.original, rootDir);
      const source = path.resolve(rootDir, "public", asset.files.original),
        bytes = statSync(source).size;
      if (scopeRoot) assertPathWithin(realpathSync(scopeRoot), realpathSync(source));
      totalBytes += bytes;
      if (bytes !== asset.files.bytes || totalBytes > maxBytes || hashFile(source) !== asset.hash)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: `Imported reference checksum/size mismatch or inline references exceed ${maxBytes / 1024 / 1024} MiB; use smaller prepared originals`,
        });
      const inline = `data:${asset.files.mime};base64,${readFileSync(source).toString("base64")}`;
      metadata[inline] = measuredMedia(asset);
      referenceAssetIds.push(asset.id);
      cache.set(value, inline);
      return inline;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, key.endsWith("_urls") ? key.slice(0, -1) : key));
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, visit(item, childKey)]));
    return value;
  };
  request.input = visit(request.input) as Record<string, unknown>;
  if (usedRemote.size !== remote.size)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Every remote binding must match an attached media URL in this request.",
    });
  request.context = {
    ...request.context,
    allowTranslatedSpeech: request.context?.allowTranslatedSpeech ?? false,
    media: metadata,
  };
  return {
    request: request as T extends FalEndpointRequest
      ? ReturnType<typeof FalEndpointRequestSchema.parse>
      : ReturnType<typeof FalOperationRequestSchema.parse>,
    referenceAssetIds: [...new Set(referenceAssetIds)],
  };
}
