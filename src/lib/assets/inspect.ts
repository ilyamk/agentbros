import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfprobe } from "../cli";
import type { AssetRecord } from "../../types/assets";

type Stream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  time_base?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  pix_fmt?: string;
};
const imageCodecs: Record<string, string> = {
  png: "image/png",
  mjpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
  svg: "image/svg+xml",
};

export type MediaInspection = Pick<AssetRecord, "media"> & { kind: "image" | "video" | "audio"; mime: string };
export type AssetInspection = Pick<AssetRecord, "kind" | "media"> & { mime: string };
/** Non-media files are only inspected without ffprobe, and only when they are capped this small. */
const MAX_STRUCTURED_BYTES = 256 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".srt", ".vtt", ".csv", ".tsv"]);
const invalid = (message: string): never => {
  throw new CliErrorObject({ code: "VALIDATION", message });
};

function head(file: string, bytes: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
function readCapped(file: string): Buffer {
  const size = statSync(file).size;
  if (size <= 0) invalid("Asset is empty.");
  if (size > MAX_STRUCTURED_BYTES) invalid("Structured asset exceeds the 256 MiB inspection limit.");
  return readFileSync(file);
}
function utf8(bytes: Buffer, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid(`${what} is not valid UTF-8.`);
  }
}
type GltfJson = {
  asset?: { version?: unknown };
  meshes?: unknown;
  nodes?: unknown;
  materials?: unknown;
  animations?: unknown;
};
function gltfMedia(json: unknown, codec: string): AssetRecord["media"] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return invalid("glTF JSON must be an object.");
  const gltf = json as GltfJson;
  if (typeof gltf.asset?.version !== "string" || !gltf.asset.version.startsWith("2."))
    invalid("glTF asset.version must be 2.x.");
  const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  return {
    codec,
    hasAudio: false,
    hasAlpha: "unknown",
    meshCount: count(gltf.meshes),
    nodeCount: count(gltf.nodes),
    materialCount: count(gltf.materials),
    hasAnimations: count(gltf.animations) > 0,
  };
}

/** The GLB JSON chunk is read whole; binary chunks after it are never read. */
const MAX_GLB_JSON_BYTES = 64 * 1024 * 1024;
/** GLB 2.0: 12-byte header (`glTF`, version 2, total length == file size), then a JSON chunk first. */
function glbFromParts(header: Buffer, totalBytes: number, readJson: (length: number) => Buffer): AssetInspection {
  if (header.length < 20 || totalBytes < 20 || header.toString("latin1", 0, 4) !== "glTF")
    invalid("GLB header magic is missing.");
  if (header.readUInt32LE(4) !== 2) invalid("GLB version must be 2.");
  if (header.readUInt32LE(8) !== totalBytes) invalid("GLB declared length differs from the file size.");
  const chunkLength = header.readUInt32LE(12);
  if (
    header.readUInt32LE(16) !== 0x4e4f534a ||
    chunkLength === 0 ||
    chunkLength % 4 !== 0 ||
    20 + chunkLength > totalBytes
  )
    invalid("GLB first chunk must be a JSON chunk inside the file.");
  if (chunkLength > MAX_GLB_JSON_BYTES) invalid("GLB JSON chunk exceeds the 64 MiB inspection limit.");
  let json: unknown;
  try {
    json = JSON.parse(utf8(readJson(chunkLength), "GLB JSON chunk"));
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    invalid("GLB JSON chunk does not parse.");
  }
  return { kind: "model3d", mime: "model/gltf-binary", media: gltfMedia(json, "glb") };
}
export function inspectGlb(bytes: Buffer): AssetInspection {
  return glbFromParts(bytes.subarray(0, 20), bytes.length, (length) => bytes.subarray(20, 20 + length));
}
/** Reads only the 20-byte header and the JSON chunk, so any GLB the download limit allows can be inspected. */
export function inspectGlbFile(file: string): AssetInspection {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const read = (offset: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const got = readSync(fd, buffer, 0, length, offset);
      return buffer.subarray(0, got);
    };
    return glbFromParts(read(0, Math.min(20, size)), size, (length) => {
      const chunk = read(20, length);
      if (chunk.length !== length) invalid("GLB JSON chunk is truncated.");
      return chunk;
    });
  } finally {
    closeSync(fd);
  }
}
function inspectStructured(file: string, extension: string): AssetInspection | undefined {
  if (extension === ".gltf") {
    const text = utf8(readCapped(file), "glTF file");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return invalid("glTF file does not parse as JSON.");
    }
    return { kind: "model3d", mime: "model/gltf+json", media: gltfMedia(json, "gltf") };
  }
  if (extension === ".json") {
    const text = utf8(readCapped(file), "JSON file");
    try {
      JSON.parse(text);
    } catch {
      invalid("JSON file does not parse.");
    }
    return {
      kind: "json",
      mime: "application/json",
      media: { codec: "json", hasAudio: false, hasAlpha: "unknown", lineCount: text.split("\n").length },
    };
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    const text = utf8(readCapped(file), "Text file");
    return {
      kind: "text",
      mime: "text/plain",
      media: { codec: "utf-8", hasAudio: false, hasAlpha: "unknown", lineCount: text.split("\n").length },
    };
  }
  return undefined;
}

/**
 * Local metadata only. No media upload or provider request is performed.
 * By default only image, video and audio are accepted (ffprobe). With `{ nonMedia: true }` a GLB
 * (by magic), `.gltf`, `.json` and text files are inspected without ffprobe first.
 */
export function inspectAsset(file: string): MediaInspection;
export function inspectAsset(file: string, options: { nonMedia: true }): AssetInspection;
export function inspectAsset(file: string, options?: { nonMedia?: boolean }): AssetInspection;
export function inspectAsset(file: string, options: { nonMedia?: boolean } = {}): AssetInspection {
  if (options.nonMedia) {
    const extension = path.extname(file).toLowerCase();
    if (head(file, 4).toString("latin1") === "glTF" || extension === ".glb") return inspectGlbFile(file);
    const structured = inspectStructured(file, extension);
    if (structured) return structured;
  }
  return inspectMedia(file);
}

function inspectMedia(file: string): MediaInspection {
  ensureFfprobe();
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-protocol_whitelist", "file,crypto", "-show_streams", "-show_format", "-of", "json", file],
    { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (probe.status !== 0 || probe.error)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Media cannot be inspected: ${probe.error?.message ?? probe.stderr.trim()}`,
    });
  let data: { streams?: Stream[]; format?: { format_name?: string; duration?: string } };
  try {
    data = JSON.parse(probe.stdout);
  } catch {
    throw new CliErrorObject({ code: "VALIDATION", message: "Invalid ffprobe metadata." });
  }
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video"),
    audio = streams.find((s) => s.codec_type === "audio");
  if (!video && !audio)
    throw new CliErrorObject({ code: "VALIDATION", message: "Asset has no decodable image/video/audio stream." });
  const container = data.format?.format_name ?? "";
  const isImage = !!video && !!imageCodecs[video.codec_name ?? ""] && /image|_pipe|gif/.test(container);
  const kind = isImage ? "image" : video ? "video" : "audio";
  const codec = (video ?? audio)!.codec_name;
  if (!codec || (video && (!(video.width! > 0) || !(video.height! > 0))))
    throw new CliErrorObject({ code: "VALIDATION", message: "Asset dimensions/codec are missing." });
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration);
  if (kind !== "image" && (!Number.isFinite(duration) || duration <= 0))
    throw new CliErrorObject({ code: "VALIDATION", message: "Media duration must be positive." });
  const alpha =
    video?.pix_fmt && video.pix_fmt !== "pal8" ? /^(rgba|bgra|argb|abgr|ya|yuva|gbrap)/.test(video.pix_fmt) : "unknown";
  const mime = isImage
    ? imageCodecs[codec]
    : kind === "video"
      ? /webm/.test(container)
        ? "video/webm"
        : /mov|mp4/.test(container)
          ? "video/mp4"
          : "video/x-matroska"
      : /wav/.test(container)
        ? "audio/wav"
        : /mp3/.test(container)
          ? "audio/mpeg"
          : /flac/.test(container)
            ? "audio/flac"
            : /ogg/.test(container)
              ? "audio/ogg"
              : "audio/mp4";
  return {
    kind,
    mime,
    media: {
      codec,
      hasAudio: !!audio,
      hasAlpha: alpha,
      ...(video
        ? { width: video.width, height: video.height, timebase: video.time_base, frameRate: video.avg_frame_rate }
        : { timebase: audio?.time_base }),
      ...(kind !== "image" ? { durationSec: duration } : {}),
      ...(audio ? { sampleRate: Number(audio.sample_rate) || undefined, channels: audio.channels } : {}),
    },
  };
}
