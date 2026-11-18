import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, ensureFfmpeg, ensureFfprobe } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { ShowcaseMediaManifestSchema, ShowcaseSchema } from "../src/types/showcase";
import { download } from "./github/download";

export const mediaLimit = (name: string) => (name.endsWith(".mp4") ? 20 : 5) * 1024 * 1024;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function mediaType(bytes: Buffer): "image" | "video" {
  if (
    bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
  )
    return "image";
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") return "video";
  throw new Error("Unsupported media magic bytes");
}
function probe(file: string) {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", file],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  if (result.error || result.status !== 0) throw new Error("Media probe failed");
  return JSON.parse(result.stdout) as {
    streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
    format: { duration?: string };
  };
}
export function reencodeMedia(input: string, output: string, video: boolean): void {
  ensureFfmpeg();
  const scale = "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-n",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-vf",
      scale,
      ...(video
        ? [
            "-t",
            "10",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-fs",
            String(mediaLimit(output) - 1024),
          ]
        : ["-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3"]),
      output,
    ],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(`Media re-encoding failed: ${result.error?.message ?? result.stderr.slice(-500)}`);
}
function validateMedia(file: string, bytes: Buffer, parse = true): void {
  const video = file.endsWith(".mp4");
  if (bytes.length > mediaLimit(file) || mediaType(bytes) !== (video ? "video" : "image"))
    throw new Error("Media type or size mismatch");
  if (!video && !bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    throw new Error("Published image must be JPEG");
  if (!parse) return;
  const info = probe(file),
    stream = info.streams.find((item) => item.codec_type === "video");
  if (
    !stream?.width ||
    !stream.height ||
    Math.max(stream.width, stream.height) > 1280 ||
    (video &&
      (stream.codec_name !== "h264" ||
        info.streams.some((item) => item.codec_type !== "video") ||
        !Number.isFinite(Number(info.format.duration)) ||
        Number(info.format.duration) <= 0 ||
        Number(info.format.duration) > 10.000001))
  )
    throw new Error("Media dimensions, codec, duration or audio failed validation");
}
export async function fetchShowcaseMedia(entries: string[], out: string, request: typeof fetch = fetch) {
  ensureFfmpeg();
  ensureFfprobe();
  if (existsSync(out)) throw new Error("Media output already exists");
  const scratch = mkdtempSync(path.join(tmpdir(), "showcase-fetch-"));
  const files: { path: string; sha256: string; bytes: number }[] = [];
  try {
    mkdirSync(out, { recursive: true });
    for (const entryFile of entries) {
      if (lstatSync(entryFile).isSymbolicLink()) throw new Error("Showcase entry symlink refused");
      const entry = ShowcaseSchema.parse(JSON.parse(readFileSync(entryFile, "utf8")));
      if (path.basename(path.dirname(entryFile)) !== entry.slug)
        throw new Error("Showcase slug differs from entry directory");
      const sources = entry.mediaSources ?? [];
      if (!sources.length) continue;
      if (sources.length !== 3) throw new Error("Supply all three showcase media sources");
      for (const source of sources) {
        const name = (
          { thumbnail: "thumbnail.jpg", contactSheet: "contact-sheet.jpg", preview: "preview.mp4" } as const
        )[source.kind];
        const bytes = await download(source.url, mediaLimit(name), request);
        if (mediaType(bytes) !== (source.kind === "preview" ? "video" : "image"))
          throw new Error("Source kind does not match media bytes");
        const input = path.join(scratch, "source");
        writeFileSync(input, bytes);
        const relative = `${entry.slug}/${name}`,
          output = path.join(out, relative);
        mkdirSync(path.dirname(output), { recursive: true });
        reencodeMedia(input, output, source.kind === "preview");
        const encoded = readFileSync(output);
        validateMedia(output, encoded);
        files.push({ path: relative, sha256: sha256(encoded), bytes: encoded.length });
      }
    }
    const manifest = ShowcaseMediaManifestSchema.parse({ version: 1, files });
    writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest) + "\n", { flag: "wx" });
    return manifest;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
/** `structural` skips ffprobe: a job holding write credentials checks inventory, schema, sizes, hashes and magic bytes only, never parsing media. */
export function validateShowcaseArtefact(
  directory: string,
  root = process.cwd(),
  options: { structural?: boolean } = {},
) {
  if (!options.structural) ensureFfprobe();
  const inventory: string[] = [];
  const walk = (dir: string, prefix = "") => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isDirectory() && !prefix && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.name))
        walk(path.join(dir, item.name), `${name}/`);
      else if (item.isFile()) inventory.push(name);
      else throw new Error("Unexpected artefact directory, symlink or special file");
    }
  };
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error("Expected an artefact directory");
  walk(directory);
  const manifestPath = path.join(directory, "manifest.json");
  if (lstatSync(manifestPath).size > 100_000) throw new Error("Media manifest exceeds limit");
  const manifest = ShowcaseMediaManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (
    JSON.stringify(inventory.sort()) !==
    JSON.stringify(["manifest.json", ...manifest.files.map((file) => file.path)].sort())
  )
    throw new Error("Artefact inventory mismatch");
  const assets = manifest.files.map((file) => {
    const [slug, name] = file.path.split("/");
    const entry = ShowcaseSchema.parse(
      JSON.parse(readFileSync(path.join(root, "showcases", slug!, "showcase.json"), "utf8")),
    );
    if (entry.slug !== slug) throw new Error("Unknown showcase slug");
    const input = path.join(directory, file.path),
      stat = lstatSync(input);
    if (stat.size !== file.bytes || stat.size > mediaLimit(file.path)) throw new Error("Media size mismatch");
    const bytes = readFileSync(input);
    if (sha256(bytes) !== file.sha256) throw new Error("Media hash mismatch");
    validateMedia(input, bytes, !options.structural);
    return { input, name: `${slug}-${file.sha256}-${name}` };
  });
  return { manifest, assets };
}
export function changedShowcaseEntries(base: string, head: string, root = process.cwd()): string[] {
  if (![base, head].every((value) => /^[a-f0-9]{40,64}$/.test(value))) throw new Error("Both commit SHAs are required");
  const args = /^0+$/.test(base)
    ? ["ls-tree", "-r", "--name-only", "-z", head, "--", "showcases/"]
    : ["diff", "--name-only", "--diff-filter=AM", "-z", base, head, "--", "showcases/*/showcase.json"];
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => /^showcases\/[a-z0-9]+(?:-[a-z0-9]+)*\/showcase\.json$/.test(file));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runOffline(async () => {
    const args = parseArgs([
      { name: "base", description: "PR base commit SHA" },
      { name: "head", description: "Merged commit SHA" },
      { name: "out", default: "out/showcase-media", description: "New media output directory" },
      { name: "validate", description: "Validate an untrusted media artefact directory instead of fetching" },
      {
        name: "structural",
        type: "boolean",
        description: "With --validate: skip ffprobe parsing (for jobs that hold write credentials)",
      },
    ] as const);
    if (args.validate)
      return {
        metadata: validateShowcaseArtefact(args.validate, process.cwd(), { structural: Boolean(args.structural) }),
      };
    if (!args.base || !args.head || ![args.base, args.head].every((value) => /^[a-f0-9]{40,64}$/.test(value)))
      throw new Error("Both commit SHAs are required");
    const entries = changedShowcaseEntries(args.base, args.head);
    return { outputs: [args.out!], metadata: await fetchShowcaseMedia(entries, args.out!) };
  });
