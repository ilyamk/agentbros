import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject } from "../cli";

/** ISO-BMFF major brands of HEIF stills and sequences (iPhone photos are "heic"). */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);

/** Major brand of an ISO-BMFF file from its first bytes (`ftyp` box), or null. */
export function majorBrand(head: Uint8Array): string | null {
  if (head.length < 12) return null;
  const text = (from: number) => String.fromCharCode(...head.subarray(from, from + 4));
  return text(4) === "ftyp" ? text(8) : null;
}

export const isHeif = (file: string, brand: string | null) =>
  /\.(heic|heif)$/i.test(file) || (brand !== null && HEIF_BRANDS.has(brand));

export function readHead(file: string, bytes = 16): Uint8Array {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

export type HeicPlan =
  | { action: "convert"; tool: "sips" | "ffmpeg"; command: string[] }
  | { action: "refuse"; message: string; fix: string };

const manual = (input: string, output: string) =>
  `Convert it to JPEG first: \`sips -s format jpeg "${input}" --out "${output}"\` (macOS), \`heif-convert "${input}" "${output}"\` (libheif), or \`ffmpeg -i "${input}" -frames:v 1 -q:v 2 "${output}"\` (ffmpeg 7.1 or later), then import the JPEG.`;

/** How a HEIC/HEIF photo becomes a JPEG on this machine: sips on macOS, else ffmpeg when it decodes the file, else a refusal with the exact commands. */
export function heicPlan(opts: {
  input: string;
  output: string;
  platform: NodeJS.Platform;
  hasSips: boolean;
  ffmpegDecodes: boolean;
}): HeicPlan {
  if (opts.platform === "darwin" && opts.hasSips)
    return {
      action: "convert",
      tool: "sips",
      command: ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "best", opts.input, "--out", opts.output],
    };
  if (opts.ffmpegDecodes)
    return {
      action: "convert",
      tool: "ffmpeg",
      command: ["ffmpeg", "-v", "error", "-y", "-i", opts.input, "-frames:v", "1", "-q:v", "2", opts.output],
    };
  return {
    action: "refuse",
    message: `${path.basename(opts.input)} is HEIC/HEIF, which this machine cannot convert and the renderer cannot show.`,
    fix: manual(opts.input, opts.output),
  };
}

const succeeds = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60000 });
  return !result.error && result.status === 0;
};

/** Converts a HEIC/HEIF photo to a JPEG in a fresh temporary folder; returns the JPEG and the tool used. */
export function convertHeic(input: string): { output: string; tool: "sips" | "ffmpeg"; command: string[] } {
  const output = path.join(mkdtempSync(path.join(tmpdir(), "heic-")), `${path.parse(input).name}.jpg`);
  const hasSips = process.platform === "darwin" && succeeds("sips", ["--help"]);
  const plan = heicPlan({
    input,
    output,
    platform: process.platform,
    hasSips,
    ffmpegDecodes: !hasSips && succeeds("ffmpeg", ["-v", "error", "-i", input, "-frames:v", "1", "-f", "null", "-"]),
  });
  if (plan.action === "refuse")
    throw new CliErrorObject({ code: "VALIDATION", message: plan.message, details: { fix: plan.fix } });
  const [command, ...args] = plan.command;
  const result = spawnSync(command!, args, { encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `HEIC conversion with ${plan.tool} failed: ${(result.error?.message ?? result.stderr).trim().slice(-400)}`,
      details: { fix: manual(input, output) },
    });
  return { output, tool: plan.tool, command: plan.command };
}

/** The refusal importAsset gives a HEIC/HEIF file, naming the exact conversion. */
export const heicRefusal = (input: string) =>
  new CliErrorObject({
    code: "VALIDATION",
    message: `${path.basename(input)} is HEIC/HEIF: pnpm asset:import converts it to JPEG itself; other callers convert first.`,
    details: { fix: manual(input, input.replace(/\.(heic|heif)$/i, "") + ".jpg") },
  });
