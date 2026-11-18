import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg } from "../../cli";
import type { ProviderUpload } from "../../jobs/types";
import type { HiggsfieldClient } from "./client";
import type { HiggsfieldUploadCache } from "./upload-cache";

export const HIGGSFIELD_UPLOAD_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "audio/wav",
  "video/mp4",
] as const;
export type UploadMedia = { contentType: string; bytes: Buffer };
/** Local conversion follows the bounded ffmpeg worker pattern; inputs cannot open remote protocols. */
export function transcodeHiggsfieldUpload(media: UploadMedia): UploadMedia {
  ensureFfmpeg();
  const kind = media.contentType.split("/")[0];
  if (!["image", "audio", "video"].includes(kind))
    throw new CliErrorObject({ code: "VALIDATION", message: "Unsupported Higgsfield reference media type." });
  const directory = mkdtempSync(path.join(tmpdir(), "hf-upload-"));
  try {
    const input = path.join(directory, "source"),
      output = path.join(directory, kind === "audio" ? "output.wav" : kind === "image" ? "output.png" : "output.mp4");
    writeFileSync(input, media.bytes);
    const encoding =
      kind === "audio"
        ? ["-vn", "-c:a", "pcm_s16le"]
        : kind === "image"
          ? ["-frames:v", "1"]
          : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"];
    const result = spawnSync(
      "ffmpeg",
      ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", input, ...encoding, output],
      { encoding: "utf8", timeout: 120000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
    );
    if (result.error || result.status !== 0)
      throw new CliErrorObject({ code: "FFMPEG_FAILED", message: "Could not transcode Higgsfield reference media." });
    return {
      bytes: readFileSync(output),
      contentType: kind === "audio" ? "audio/wav" : kind === "image" ? "image/png" : "video/mp4",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function publicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Higgsfield uploaded reference must have a public HTTPS URL.",
    });
  return value;
}
/** Resolves inline references once and persists each completed upload before freezing the submit body. */
export async function prepareHiggsfieldInput(
  input: Record<string, unknown>,
  options: {
    client: Pick<HiggsfieldClient, "createUpload" | "putUpload">;
    uploads: ProviderUpload[];
    persistUpload: (upload: ProviderUpload) => void;
    transcode?: (media: UploadMedia) => UploadMedia | Promise<UploadMedia>;
    cache?: HiggsfieldUploadCache;
    onReferencePrepared?: (source: string, publicUrl: string) => void;
  },
): Promise<Record<string, unknown>> {
  const uploads = [...options.uploads];
  const visit = async (value: unknown): Promise<unknown> => {
    if (typeof value === "string" && value.startsWith("asset://"))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Resolve imported Higgsfield asset references before preparing uploads.",
      });
    if (typeof value === "string" && value.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
      if (!match || !match[2])
        throw new CliErrorObject({ code: "VALIDATION", message: "Invalid inline Higgsfield media reference." });
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.toString("base64") !== match[2])
        throw new CliErrorObject({ code: "VALIDATION", message: "Invalid base64 reference." });
      const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
      const source = { contentType: match[1].toLowerCase(), bytes };
      const accepted = (HIGGSFIELD_UPLOAD_TYPES as readonly string[]).includes(source.contentType);
      const contentType = accepted
        ? source.contentType
        : { image: "image/png", audio: "audio/wav", video: "video/mp4" }[source.contentType.split("/")[0]];
      if (!contentType)
        throw new CliErrorObject({ code: "VALIDATION", message: "Unsupported Higgsfield reference media type." });
      const previous = uploads.find(
        (upload) => upload.sourceSha256 === sourceSha256 && upload.contentType === contentType,
      );
      if (previous) {
        const url = publicUrl(previous.publicUrl);
        options.onReferencePrepared?.(value, url);
        return url;
      }
      const uploadMedia = async () => {
        const media = accepted ? source : await (options.transcode ?? transcodeHiggsfieldUpload)(source);
        if (media.contentType !== contentType)
          throw new CliErrorObject({
            code: "VALIDATION",
            message: "Transcoder returned an unsupported Higgsfield content type.",
          });
        const upload = await options.client.createUpload(media.contentType);
        publicUrl(upload.public_url);
        await options.client.putUpload(upload.upload_url, upload.upload_headers, media.bytes);
        return upload.public_url;
      };
      const saved = {
        sourceSha256,
        publicUrl: options.cache
          ? await options.cache.reuse(sourceSha256, contentType, uploadMedia)
          : await uploadMedia(),
        contentType,
      };
      options.persistUpload(saved);
      uploads.push(saved);
      options.onReferencePrepared?.(value, saved.publicUrl);
      return saved.publicUrl;
    }
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) result.push(await visit(item));
      return result;
    }
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) result[key] = await visit(item);
      return result;
    }
    return value;
  };
  return (await visit(input)) as Record<string, unknown>;
}
