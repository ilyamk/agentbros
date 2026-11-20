import { CliErrorObject } from "../cli";

/** Flags every colour measurement shares, in the order --help prints them. */
export const DECODE_SPECS = [
  {
    name: "crop",
    default: "auto",
    description: "Active picture: auto (drop letterbox/pillarbox bars), none, or x,y,w,h in source pixels",
  },
  {
    name: "matrix",
    choices: ["bt709", "bt601", "bt2020"],
    description: "Override the Y'CbCr matrix of an untagged stream",
  },
  { name: "range", choices: ["limited", "full"], description: "Override the code-value range of an untagged stream" },
  { name: "max-width", type: "number", default: 960, description: "Analysis width in pixels (frames are downscaled)" },
] as const;

function rect(value: string, flag: string): number[] {
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0) || parts[2]! <= 0 || parts[3]! <= 0)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${flag} must be x,y,w,h in pixels, got "${value}"` });
  return parts;
}

export function parseCrop(value: string | undefined, flag = "crop"): "auto" | "none" | number[] {
  if (!value || value === "auto") return "auto";
  if (value === "none") return "none";
  return rect(value, flag);
}

export function parseRegion(value: string | undefined, flag: string): number[] | undefined {
  return value ? rect(value, flag) : undefined;
}

export function decodeRequest(args: { crop?: string; matrix?: string; range?: string; "max-width"?: number }) {
  return {
    crop: parseCrop(args.crop),
    ...(args.matrix ? { matrix: args.matrix } : {}),
    ...(args.range ? { range: args.range } : {}),
    maxWidth: Math.max(64, Math.min(4096, Math.round(args["max-width"] ?? 960))),
  };
}

export function frameCount(value: number | undefined, fallback: number): number {
  const n = Math.round(value ?? fallback);
  if (!Number.isFinite(n) || n < 1 || n > 64)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--frames must be between 1 and 64" });
  return n;
}
