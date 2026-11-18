import { pythonToolArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashFile } from "../assets/registry";
import { CliErrorObject } from "../cli";
import { mediaProbe } from "../audio/analysis";
import { probeVideo } from "../vision/media";
import { ReferenceSourceSchema, type ReferenceSource } from "../../types/reference";
import { detectCrop, parseCrop } from "./crop";
import { DETECTED_CROP_CACHE, readSource, referenceDirectory, writeLayer } from "./library";
import { excludeReference } from "./private";
import { INSTALL_UV } from "./worker";
import { publicUrl } from "../media-fetch/http";

type RightsStatus = ReferenceSource["rights"]["status"];
/** `auto` detects letterbox and static UI bands, `none` keeps the whole frame, or "W:H:X:Y" in pixels. */
export type AddRequest = {
  file?: string;
  url?: string;
  id?: string;
  rights?: RightsStatus;
  rightsNote?: string;
  libraryRoot: string;
  force?: boolean;
  crop?: string;
  cropNote?: string;
  playbooks?: string[];
  private?: boolean;
};

const ASK_FOR_FILE = "Ask the user for the video file and rerun with --file.";

export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/** Downloads with the locked yt-dlp profile into a new empty directory. Never uses browser cookies. */
function download(url: string, directory: string): { file: string; tool: string } {
  // Same rule as media:fetch: http(s) only, no credentials or odd ports, no loopback, link-local or private literal hosts.
  // scripts/ref-add.ts also resolves the host and refuses non-public addresses before this runs.
  try {
    publicUrl(url);
  } catch (error) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Only public http and https links can be downloaded (${error instanceof Error ? error.message : String(error)}): ${url}`,
    });
  }
  const uvx = pythonUv(process.env.REFERENCE_UVX);
  const result = spawnSync(
    uvx,
    pythonToolArgs("yt-dlp", "yt-dlp", [
      "--no-playlist",
      "--no-progress",
      "--no-config",
      "-f",
      "bv*[height<=1080]+ba/b[height<=1080]/b",
      "--merge-output-format",
      "mp4",
      "-o",
      path.join(directory, "download.%(ext)s"),
      "--",
      url,
    ]),
    {
      env: pythonEnvironment("yt-dlp"),
      encoding: "utf8",
      timeout: 1800000,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error && /ENOENT/.test(result.error.message))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `uv is not available, so links cannot be downloaded. ${INSTALL_UV}, or: ${ASK_FOR_FILE}`,
    });
  const files = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.startsWith("download.") && !name.endsWith(".part"))
    : [];
  if (result.error || result.status !== 0 || !files.length) {
    const detail = (result.error?.message ?? result.stderr ?? "").trim().slice(-500);
    const login = /sign in|log ?in|cookies|private|members|age.?restrict|not a bot|authentication/i.test(detail);
    throw new CliErrorObject({
      code: login ? "VALIDATION" : "NETWORK",
      message: `${login ? "This site needs a login to download this video." : "yt-dlp could not download this link."} ${ASK_FOR_FILE} Detail: ${detail}`,
    });
  }
  const version = spawnSync(uvx, pythonToolArgs("yt-dlp", "yt-dlp", ["--version"]), {
    env: pythonEnvironment("yt-dlp"),
    encoding: "utf8",
    timeout: 60000,
  }).stdout?.trim();
  return { file: path.join(directory, files[0]!), tool: `yt-dlp ${version ?? ""}`.trim() };
}

function sidecarNotes(file: string): string | undefined {
  const sidecar = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.md`);
  return existsSync(sidecar) && statSync(sidecar).isFile()
    ? readFileSync(sidecar, "utf8").trim() || undefined
    : undefined;
}

function defaultRights(file: string | undefined): RightsStatus {
  return file && path.resolve(file).split(path.sep).join("/").includes("/library/inbox/") ? "study-only" : "unknown";
}

/** Adds playbook tags to a reference's source.json, keeping the ones it has. */
export function tagReference(
  directory: string,
  source: ReferenceSource,
  playbooks: string[] | undefined,
): ReferenceSource {
  if (!playbooks?.length) return source;
  const merged = [...new Set([...(source.playbooks ?? []), ...playbooks])].sort();
  if (merged.length === source.playbooks?.length) return source;
  const tagged = ReferenceSourceSchema.parse({ ...source, playbooks: merged });
  writeLayer(directory, "source.json", tagged);
  return tagged;
}

/**
 * Checks an existing reference's crop again, or sets it: `auto` detects, `none` keeps the whole frame, W:H:X:Y sets it.
 * The crop it replaces goes to `cropHistory` with the note. Picture layers measured on the old crop are stale: rerun ref:analyze.
 */
export function recropReference(
  directory: string,
  crop: string,
  note?: string,
): { source: ReferenceSource; changed: boolean } {
  const { source, media } = readSource(directory);
  const info = probeVideo(media);
  const next = crop === "auto" ? (detectCrop(media, info) ?? null) : crop === "none" ? null : parseCrop(crop, info);
  rmSync(path.join(directory, DETECTED_CROP_CACHE), { force: true });
  const previous = source.crop ?? null;
  const changed = JSON.stringify(previous) !== JSON.stringify(next) || source.crop === undefined;
  if (!changed && !note) return { source, changed };
  const updated = ReferenceSourceSchema.parse({
    ...source,
    crop: next,
    cropHistory: [
      ...(source.cropHistory ?? []),
      {
        crop: source.crop === undefined ? null : previous,
        replacedAt: new Date().toISOString(),
        request: crop,
        ...(note ? { note } : {}),
      },
    ],
  });
  writeLayer(directory, "source.json", updated);
  return { source: updated, changed };
}

/**
 * Marks a reference private: `private: true` in source.json and its directory ignored in .git/info/exclude, so
 * neither its files nor its id reach git. ref:corpus still reads it; ref:contribute refuses it.
 */
export function markPrivate(
  directory: string,
  source: ReferenceSource,
): { source: ReferenceSource; exclude: ReturnType<typeof excludeReference> } {
  const marked = source.private ? source : ReferenceSourceSchema.parse({ ...source, private: true });
  if (marked !== source) writeLayer(directory, "source.json", marked);
  return { source: marked, exclude: excludeReference(directory) };
}

export function addReference(request: AddRequest): {
  directory: string;
  source: ReferenceSource;
  reused: boolean;
  recropped?: boolean;
  exclude?: ReturnType<typeof excludeReference>;
} {
  const result = addOrUpdate(request);
  if (!request.private) return result;
  const { source, exclude } = markPrivate(result.directory, result.source);
  return { ...result, source, exclude };
}

function addOrUpdate(request: AddRequest): {
  directory: string;
  source: ReferenceSource;
  reused: boolean;
  recropped?: boolean;
} {
  if (!request.file && !request.url && request.id && (request.playbooks?.length || request.crop || request.private)) {
    // The reference is already in the library: tag it, check its crop again, or both.
    const directory = referenceDirectory(request.libraryRoot, request.id);
    if (!existsSync(path.join(directory, "source.json")))
      throw new CliErrorObject({
        code: "FILE_NOT_FOUND",
        message: `No reference ${request.id} to tag, re-crop or mark private. Pass --file or --url to add it.`,
      });
    let source = ReferenceSourceSchema.parse(JSON.parse(readFileSync(path.join(directory, "source.json"), "utf8")));
    let recropped: boolean | undefined;
    if (request.crop) ({ source, changed: recropped } = recropReference(directory, request.crop, request.cropNote));
    return {
      directory,
      source: tagReference(directory, source, request.playbooks),
      reused: true,
      ...(recropped !== undefined ? { recropped } : {}),
    };
  }
  if (!!request.file === !!request.url)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "Pass exactly one of --file or --url (or only --id with --playbooks to tag, --crop to re-crop or --private to mark private an existing reference).",
    });
  const id =
    request.id ??
    slugify(
      request.file
        ? path.basename(request.file, path.extname(request.file))
        : new URL(request.url!).pathname || new URL(request.url!).hostname,
    );
  const directory = referenceDirectory(request.libraryRoot, id);
  const work = request.url ? mkdtempSync(path.join(tmpdir(), "reference-download-")) : undefined;
  try {
    if (request.file && (!existsSync(request.file) || !statSync(request.file).isFile()))
      throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `File not found: ${request.file}` });
    const fetched = request.url ? download(request.url, work!) : undefined;
    const input = path.resolve(fetched?.file ?? request.file!);
    const info = probeVideo(input);
    const sha256 = hashFile(input);
    if (existsSync(path.join(directory, "source.json")) && !request.force) {
      const { source } = readSource(directory);
      if (source.sha256 === sha256)
        return { directory, source: tagReference(directory, source, request.playbooks), reused: true };
      throw new CliErrorObject({
        code: "FILE_EXISTS",
        message: `Reference ${id} already holds different media. Choose another --id or pass --force.`,
      });
    }
    const mediaPath = `media/source${path.extname(input).toLowerCase() || ".mp4"}`;
    mkdirSync(path.join(directory, "media"), { recursive: true });
    copyFileSync(input, path.join(directory, mediaPath));
    const codec = mediaProbe(input).streams.find((stream) => stream.codec_type === "video") as
      { codec_name?: string } | undefined;
    const notes = request.file ? sidecarNotes(request.file) : undefined;
    const crop =
      !request.crop || request.crop === "auto"
        ? (detectCrop(input, info) ?? null)
        : request.crop === "none"
          ? null
          : parseCrop(request.crop, info);
    const source = ReferenceSourceSchema.parse({
      schemaVersion: 1,
      referenceId: id,
      origin: {
        kind: request.url ? "url" : "file",
        ...(request.url ? { url: request.url, tool: fetched!.tool } : {}),
        originalFilename: path.basename(request.file ?? fetched!.file),
        acquiredAt: new Date().toISOString(),
      },
      sha256,
      mediaPath,
      probe: {
        durationSec: info.durationSec,
        width: info.width,
        height: info.height,
        fps: info.fps,
        ...(codec?.codec_name ? { codec: codec.codec_name } : {}),
        hasAudio: info.hasAudio,
      },
      rights: {
        status: request.rights ?? defaultRights(request.file),
        ...(request.rightsNote ? { note: request.rightsNote } : {}),
      },
      ...(notes ? { notes } : {}),
      crop,
      ...(request.playbooks?.length ? { playbooks: [...new Set(request.playbooks)].sort() } : {}),
    });
    writeLayer(directory, "source.json", source);
    return { directory, source, reused: false };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}
