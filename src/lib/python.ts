import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const PYTHON_ROOT = path.resolve(import.meta.dirname, "../..");
export const PYTHON_VERSION = readFileSync(path.join(PYTHON_ROOT, ".python-version"), "utf8").trim();
if (!/^3\.13\.\d+$/.test(PYTHON_VERSION)) throw new Error("Expected a pinned Python 3.13 patch in .python-version");

export type PythonProfile =
  | "stdlib"
  | "reference"
  | "reference-audio"
  | "transnet"
  | "audio-map"
  | "stems"
  | "multicam"
  | "offset"
  | "asr"
  | "vad"
  | "diarize"
  | "sfx-index"
  | "clap"
  | "matte"
  | "vork"
  | "earshot"
  | "cmake"
  | "yt-dlp";

/** audio-offset-finder still requires NumPy 1.x, which has no Python 3.13 wheels. */
export const pythonVersion = (profile: PythonProfile) => (profile === "offset" ? "3.12.16" : PYTHON_VERSION);

/** Historical *_UVX overrides now accept a uv-compatible executable or test shim. */
export const pythonUv = (override?: string) => override ?? process.env.AGENTBROS_UV ?? "uv";

export function pythonArgs(profile: PythonProfile, args: string[]): string[] {
  return pythonToolArgs(profile, "python", ["-I", ...args]);
}

export function pythonToolArgs(profile: PythonProfile, command: string, args: string[]): string[] {
  return [
    "run",
    "--project",
    PYTHON_ROOT,
    "--locked",
    "--exact",
    "--no-default-groups",
    ...(profile === "stdlib" ? [] : ["--group", profile]),
    "--python",
    pythonVersion(profile),
    command,
    ...args,
  ];
}

/** Separate environments prevent one worker's NumPy/PyTorch sync removing another's packages. */
export function pythonEnvironment(profile: PythonProfile, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of ["VIRTUAL_ENV", "UV_NO_SYNC", "UV_FROZEN", "UV_ISOLATED", "UV_ENV_FILE"]) delete env[key];
  return { ...env, UV_PROJECT_ENVIRONMENT: path.join(PYTHON_ROOT, ".cache", "python", profile), UV_NO_ENV_FILE: "1" };
}

export function pythonRequirementsHash(): string {
  const hash = createHash("sha256");
  for (const file of [".python-version", "pyproject.toml", "uv.lock"])
    hash.update(readFileSync(path.join(PYTHON_ROOT, file)));
  return hash.digest("hex");
}
