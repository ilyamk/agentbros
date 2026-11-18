import { mkdirSync, existsSync, unlinkSync, linkSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { MediaFetchJob, MediaFetchItem, MediaVariant } from "../../types/media-fetch";
import { inspectAsset } from "../assets/inspect";
import { hashFile, importAsset } from "../assets/registry";
import { downloadFile } from "./http";
import { localiseSegments } from "./segments";
import { scopedPath, saveJob } from "./storage";
import { MediaFetchError } from "./errors";

let conversions = 0;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function ffmpeg(argv: string[], timeout: number): Promise<void> {
  while (conversions >= 2) await wait(50);
  conversions++;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-nostdin", "-v", "error", ...argv], {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        timeout,
      });
      let message = "";
      child.stderr.on("data", (c) => {
        message = (message + c.toString()).slice(-1000);
      });
      child.on("error", (e) =>
        reject(
          new MediaFetchError(
            (e as NodeJS.ErrnoException).code === "ENOENT" ? "FFMPEG_MISSING" : "CONVERSION_FAILED",
            "FFmpeg could not run.",
            "Install ffmpeg: brew install ffmpeg.",
          ),
        ),
      );
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new MediaFetchError(
                "CONVERSION_FAILED",
                "FFmpeg conversion failed.",
                "Inspect codecs and requested format.",
              ),
            ),
      );
    });
  } finally {
    conversions--;
  }
}
async function materialise(url: string, file: string, job: MediaFetchJob): Promise<number> {
  const options = {
    timeoutMs: job.options.timeoutSec * 1000,
    maxBytes: job.options.maxFileMb * 1024 ** 2,
    onBytes: (bytes: number) => {
      if (job.downloadedBytes + bytes > job.options.maxTotalMb * 1024 ** 2)
        throw new MediaFetchError("SIZE_LIMIT", "Batch byte limit exceeded.");
      job.downloadedBytes += bytes;
    },
  };
  if (/\.(m3u8|mpd)(?:\?|$)/i.test(url)) {
    const directory = path.join(path.dirname(file), randomUUID());
    try {
      const tracks = await localiseSegments(url, directory, options, job.options.height);
      await ffmpeg(
        [...tracks.flatMap((track) => ["-protocol_whitelist", "file", "-i", track]), "-c", "copy", "-f", "mp4", file],
        options.timeoutMs,
      );
    } finally {
      if (existsSync(directory)) rmSync(directory, { recursive: true });
    }
    return job.downloadedBytes;
  }
  return downloadFile(url, file, options);
}
export async function publish(
  job: MediaFetchJob,
  item: MediaFetchItem,
  variants: MediaVariant[],
  root: string,
): Promise<void> {
  const directory = scopedPath(root, path.join(job.directory, "files"));
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < variants.length; index++) {
    const sourceKey = `${job.items.indexOf(item)}:${index}`;
    const previous = item.files.find((f) => f.sourceKey === sourceKey && !f.derivedFrom);
    if (previous && (!existsSync(previous.path) || hashFile(previous.path) !== previous.hash))
      throw new MediaFetchError(
        "CACHE_CORRUPT",
        "Previously published original is missing or corrupted.",
        "Restore the immutable asset before resuming.",
      );
    const variant = variants[index],
      extension =
        variant.extension && /^[a-z0-9]{1,8}$/.test(variant.extension)
          ? variant.extension
          : variant.kind === "audio"
            ? "mp3"
            : variant.kind === "image"
              ? "jpg"
              : "mp4";
    const temporary = path.join(directory, `${randomUUID()}.${extension}`);
    try {
      if (!previous) await materialise(variant.url, temporary, job);
      const original = previous?.path ?? temporary;
      if (statSync(original).size > job.options.maxFileMb * 1024 ** 2)
        throw new MediaFetchError("SIZE_LIMIT", "Materialised media exceeds per-file byte limit.");
      const inspected = inspectAsset(original);
      if (inspected.kind !== variant.kind)
        throw new MediaFetchError("INVALID_MEDIA", "Downloaded media kind differs from requested media.");
      const hash = hashFile(original),
        file = path.join(directory, `${job.items.indexOf(item)}-${index}-${hash}.${extension}`);
      if (!existsSync(file)) linkSync(original, file);
      const imported = job.options.project
        ? importAsset({
            projectId: job.options.project,
            sourceFile: file,
            rootDir: root,
            provenance: { origin: "provider", tool: `media:fetch/${item.provider}`, referenceAssetIds: [] },
            rights: { sourceUrl: item.url },
          })
        : undefined;
      if (!previous)
        item.files.push({
          sourceKey,
          path: imported ? path.resolve(root, "public", imported.asset.files.original) : file,
          hash,
          bytes: statSync(file).size,
          kind: variant.kind,
          assetId: imported?.asset.id,
          preview: variant.preview,
          media: inspected.media,
        });
      saveJob(job);
      const convert =
        (job.options.preset === "edit" && variant.kind === "video") ||
        (job.options.audioFormat !== "original" && variant.kind === "audio") ||
        (!!job.options.height && variant.kind === "video" && (inspected.media.height ?? 0) > job.options.height);
      if (
        convert &&
        !item.files.some(
          (f) =>
            f.sourceKey === sourceKey && f.derivedFrom === hash && existsSync(f.path) && hashFile(f.path) === f.hash,
        )
      ) {
        const ext = variant.kind === "audio" ? (job.options.audioFormat === "wav" ? "wav" : "mp3") : "mp4",
          derived = path.join(directory, `${hash}-edit.${ext}`);
        if (!existsSync(derived)) {
          const pending = `${derived}.${randomUUID()}.${ext}`;
          const filters =
            variant.kind === "video" && job.options.height ? ["-vf", `scale=-2:min(ih\\,${job.options.height})`] : [];
          try {
            await ffmpeg(
              [
                "-protocol_whitelist",
                "file",
                "-i",
                file,
                ...filters,
                ...(variant.kind === "video"
                  ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]
                  : ["-vn", "-c:a", ext === "wav" ? "pcm_s16le" : "libmp3lame"]),
                pending,
              ],
              job.options.timeoutSec * 1000,
            );
            try {
              linkSync(pending, derived);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            }
          } finally {
            if (existsSync(pending)) unlinkSync(pending);
          }
        }
        const checked = inspectAsset(derived),
          derivedHash = hashFile(derived);
        const asset = job.options.project
          ? importAsset({
              projectId: job.options.project,
              sourceFile: derived,
              rootDir: root,
              provenance: {
                origin: "provider",
                tool: "media:fetch/ffmpeg",
                referenceAssetIds: imported ? [imported.asset.id] : [],
              },
              rights: { sourceUrl: item.url },
            })
          : undefined;
        item.files.push({
          sourceKey,
          path: asset ? path.resolve(root, "public", asset.asset.files.original) : derived,
          hash: derivedHash,
          bytes: statSync(derived).size,
          kind: variant.kind,
          assetId: asset?.asset.id,
          derivedFrom: hash,
          media: checked.media,
        });
        saveJob(job);
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
