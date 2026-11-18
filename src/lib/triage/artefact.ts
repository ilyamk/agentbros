import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { TriageArtefactMetadataSchema } from "../../types/triage";
import { assertPathWithin, CliErrorObject } from "../cli";

export function truncateDiff(diff: string, maxBytes: number): { text: string; truncated: boolean; files: string[] } {
  const bytes = Buffer.from(diff);
  const files: string[] = [];
  let summaryBytes = 0;
  for (const line of diff.split("\n")) {
    if (!line.startsWith("diff --git ")) continue;
    const header = utf8Prefix(line, 500);
    const nextBytes = Buffer.byteLength(header) + 1;
    if (files.length >= 100 || summaryBytes + nextBytes > 8192) break;
    files.push(header.length < line.length ? `${header.slice(0, -3)}...` : header);
    summaryBytes += nextBytes;
  }
  const prefix = utf8Prefix(bytes, maxBytes);
  return { text: prefix, truncated: bytes.length > maxBytes, files };
}

export function utf8Prefix(value: string | Buffer, maxBytes: number): string {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function readArtefact(
  directory: string,
  maxDiffBytes: number,
): { material: string; truncated: boolean; files: string[] } {
  const root = path.resolve(directory);
  const read = (name: string): string => {
    const file = path.join(root, name);
    assertPathWithin(root, file);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Artefact ${name} must be a regular text file of at most 16 MiB.`,
      });
    return readFileSync(file, "utf8");
  };
  const metadata = read("metadata.json");
  const body = read("body.md");
  const change = read("change.md");
  const diff = truncateDiff(read("diff.patch"), maxDiffBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    /* Legacy artefacts have no reliable completeness metadata. */
  }
  const summary = TriageArtefactMetadataSchema.safeParse(parsed);
  if (summary.success) {
    if (Buffer.byteLength(JSON.stringify(summary.data.files)) > 1024 * 1024)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Complete file summary exceeds 1 MiB." });
    diff.files = summary.data.files.map((file) => `${JSON.stringify(file.path)} +${file.additions} -${file.deletions}`);
  }
  diff.truncated ||= !summary.success || summary.data.diff.truncated;
  return {
    ...diff,
    material: [
      `metadata.json (untrusted text):\n${metadata}`,
      `body.md:\n${body}`,
      `change.md:\n${change}`,
      `Changed-file summary (untrusted metadata; complete when supplied by intake, bounded to 3000 paths and 1 MiB; legacy diff headers may be incomplete):\n${diff.files.join("\n")}`,
      `diff.patch${diff.truncated ? ` (truncated to ${maxDiffBytes} UTF-8 bytes; omitted content is not reviewed)` : ""}:\n${diff.text}`,
    ].join("\n\n"),
  };
}
