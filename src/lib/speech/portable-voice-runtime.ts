import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fileHash, objectHash } from "../apple/runtime";
import { cacheRoot } from "../cache-dir";
import { PYTHON_ROOT, pythonEnvironment, pythonRequirementsHash } from "../python";

export const PORTABLE_VOICE_BACKEND = "supertonic-3-parakeet-v3";
export const PORTABLE_VOICE_PROFILE = "portable-voice";
export const PORTABLE_VOICE_PREPARE = ["pnpm", "voiceover:local", "--engine", "portable", "--prepare"];
export const PORTABLE_VOICE_LANGUAGES = ["en", "ru"];
export const PORTABLE_VOICE_ID = /^supertonic:([0-9])$/;
export const PORTABLE_VOICE_WORKER = path.join(PYTHON_ROOT, "scripts/workers/portable-voice.py");
const manifest = path.join(PYTHON_ROOT, "scripts/workers/portable-voice-models.json");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const PORTABLE_VOICE_MODELS = z
  .array(
    z.object({
      name: z.string(),
      sha256: hash,
      bytes: z.number().int().positive(),
      files: z.record(z.string(), hash),
    }),
  )
  .parse(JSON.parse(readFileSync(manifest, "utf8")));

export const portableVoiceCache = () => path.resolve(cacheRoot(), "portable-voice");
export const portableVoiceModelsRoot = () => path.join(portableVoiceCache(), "models");
export const portableLanguage = (language: string | undefined) => language?.toLowerCase().split("-")[0];

export function portableVoiceIdentity(voice: string, platform = process.platform) {
  return objectHash({
    backend: PORTABLE_VOICE_BACKEND,
    voice,
    worker: fileHash(PORTABLE_VOICE_WORKER),
    manifest: fileHash(manifest),
    requirements: pythonRequirementsHash(),
    platform,
    arch: process.arch,
  });
}

export function portableVoicePrepared(platform = process.platform) {
  const environment = pythonEnvironment(PORTABLE_VOICE_PROFILE).UV_PROJECT_ENVIRONMENT!;
  return (
    existsSync(path.join(environment, platform === "win32" ? "Scripts/python.exe" : "bin/python")) &&
    PORTABLE_VOICE_MODELS.every((model) =>
      Object.keys(model.files).every((file) => existsSync(path.join(portableVoiceModelsRoot(), model.name, file))),
    )
  );
}
