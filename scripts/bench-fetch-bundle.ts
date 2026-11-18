import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "../src/lib/cli";
import { runOffline } from "../src/lib/contrib/cli";
import { contained, filesIn } from "../src/lib/bench/io";
import { BenchPathSchema } from "../src/types/bench";
import { attachmentUrl, BENCH_ATTACHMENT_HOSTS, download } from "./github/download";

export const BUNDLE_MAX_BYTES = 500 * 1024 * 1024;
export function submissionFields(body: string) {
  if (body.length > 65_536) throw new Error("Issue body exceeds limit");
  const field = (label: string) => {
    const sections = body
      .split(/^### /m)
      .slice(1)
      .map((section) => section.split("\n"));
    const matches = sections.filter((lines) => lines[0]?.trim() === label);
    const value = matches[0]?.slice(1).join("\n").trim();
    if (matches.length !== 1 || !value || value === "_No response_")
      throw new Error(`Missing or duplicate issue field: ${label}`);
    return value;
  };
  const url = (value: string) => {
    const urls = value.match(/https:\/\/[^\s<>]+/g) ?? [];
    if (urls.length !== 1) throw new Error("Expected one attachment URL per field");
    return urls[0]!;
  };
  return {
    bundleUrl: url(field("Bundle URL")),
    signatureUrl: url(field("Signature and signer")),
    cells: field("Cells and protocol identity"),
  };
}
/** Accept only regular USTAR files/directories, validating the entire archive before writing. */
export function extractBundle(archive: Buffer, directory: string, maxBytes = BUNDLE_MAX_BYTES): void {
  if (archive.length > maxBytes) throw new Error("Bundle exceeds download size cap");
  const bytes =
    archive[0] === 0x1f && archive[1] === 0x8b ? gunzipSync(archive, { maxOutputLength: maxBytes }) : archive;
  if (bytes.length > maxBytes || bytes.length < 1024 || bytes.length % 512)
    throw new Error("Invalid or oversized TAR archive");
  if (existsSync(directory)) throw new Error("Bundle output already exists");
  const entries: { name: string; data?: Buffer }[] = [],
    names = new Set<string>();
  const string = (header: Buffer, start: number, length: number) =>
    header
      .subarray(start, start + length)
      .toString("utf8")
      .replace(/\0.*$/s, "");
  const octal = (value: string) => {
    if (!/^[0-7]+$/.test(value.trim())) throw new Error("Invalid TAR numeric field");
    return Number.parseInt(value.trim(), 8);
  };
  let offset = 0,
    total = 0,
    terminated = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > bytes.length || !bytes.subarray(offset).every((byte) => byte === 0))
        throw new Error("Invalid TAR terminator");
      terminated = true;
      break;
    }
    const checksum = octal(string(header, 148, 8));
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== actual) throw new Error("Invalid TAR checksum");
    const magic = string(header, 257, 6);
    if (magic !== "ustar" && magic !== "") throw new Error("Only USTAR archives are accepted");
    const prefix = string(header, 345, 155),
      raw = (prefix ? prefix + "/" : "") + string(header, 0, 100);
    const type = header[156],
      size = octal(string(header, 124, 12));
    if (![0, 48, 53].includes(type!)) throw new Error("TAR links, devices and extended entries are refused");
    const name = raw.replace(/^(?:\.\/)+/, "").replace(/\/$/, "");
    if (name) {
      BenchPathSchema.parse(name);
      if (/^[A-Za-z]:/.test(name) || name.includes("\0") || name.includes("\n") || names.has(name))
        throw new Error("Invalid or duplicate archive path");
      names.add(name);
      if (names.size > 20_002) throw new Error("Too many archive entries");
    } else if (type !== 53) throw new Error("Empty TAR file path");
    if (type === 53 && size !== 0) throw new Error("TAR directory has content");
    total += size;
    if (total > maxBytes || offset + 512 + size > bytes.length) throw new Error("Archive content exceeds limits");
    if (name)
      entries.push({ name, ...(type !== 53 ? { data: bytes.subarray(offset + 512, offset + 512 + size) } : {}) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!terminated) throw new Error("Missing TAR terminator");
  const fileNames = new Set(entries.filter((entry) => entry.data !== undefined).map((entry) => entry.name));
  for (const entry of entries) {
    const parts = entry.name.split("/");
    if (parts.slice(0, -1).some((_, i) => fileNames.has(parts.slice(0, i + 1).join("/"))))
      throw new Error("Archive file used as a directory");
  }
  mkdirSync(directory, { recursive: true });
  for (const entry of entries) {
    const target = contained(path.resolve(directory), entry.name);
    if (entry.data === undefined) mkdirSync(target, { recursive: true });
    else {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, entry.data, { flag: "wx" });
    }
  }
  filesIn(directory).forEach((name) => contained(path.resolve(directory), name));
}
export async function fetchBenchBundle(body: string, directory: string, request: typeof fetch = fetch) {
  const fields = submissionFields(body);
  // Validate both URLs before making any request.
  attachmentUrl(fields.bundleUrl, BENCH_ATTACHMENT_HOSTS);
  attachmentUrl(fields.signatureUrl, BENCH_ATTACHMENT_HOSTS);
  const archive = await download(fields.bundleUrl, BUNDLE_MAX_BYTES, request, BENCH_ATTACHMENT_HOSTS);
  const signature = await download(fields.signatureUrl, 64 * 1024, request, BENCH_ATTACHMENT_HOSTS);
  if (!signature.toString("ascii").startsWith("-----BEGIN SSH SIGNATURE-----\n"))
    throw new Error("Invalid SSH signature encoding");
  extractBundle(archive, directory);
  const target = contained(path.resolve(directory), "manifest.json.sig");
  if (existsSync(target)) {
    if (!readFileSync(target).equals(signature)) throw new Error("Detached signature differs from archived signature");
  } else writeFileSync(target, signature, { flag: "wx" });
  return { bundle: directory, cells: fields.cells };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runOffline(async () => {
    const args = parseArgs([
      { name: "event", description: "GitHub issue event JSON (default GITHUB_EVENT_PATH)" },
      { name: "out", default: "out/bench-bundle", description: "New extracted bundle directory" },
    ] as const);
    const event = JSON.parse(readFileSync(args.event ?? process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as {
      issue: { body: string };
    };
    return { outputs: [args.out!], metadata: await fetchBenchBundle(event.issue.body, args.out!) };
  });
