import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertPathWithin, CliErrorObject } from "../cli";
import { hashFile } from "../assets/registry";
import { digest } from "../jobs/model-artifacts";
import type { z } from "zod";
import type { VoiceRefSchema } from "../../types/elevenlabs";

export function studioPath(root: string, value: string, scopeRoot = root): string {
  const file = path.resolve(root, value);
  assertPathWithin(path.resolve(scopeRoot), file);
  return file;
}
export function regularInput(root: string, value: string, scopeRoot = root, maxBytes = 512 * 1024 * 1024) {
  const file = studioPath(root, value, scopeRoot),
    stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Input must be a bounded nonempty regular file" });
  return { file, sha256: hashFile(file), bytes: stat.size };
}
export function projectOutput(root: string, projectId: string, output: string) {
  const project = studioPath(root, `public/projects/${projectId}`);
  if (!existsSync(path.join(project, "project.json")) && !existsSync(path.join(project, "pipeline/brief.json")))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `Project not found: ${projectId}` });
  const file = studioPath(root, output);
  assertPathWithin(project, file);
  if (file === project) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Output must be a project file" });
  return { project, file, relative: path.relative(project, file) };
}
export function readStudioRequest(root: string, value: string, scopeRoot = root): unknown {
  const input = regularInput(root, value, scopeRoot, 4 * 1024 * 1024);
  return JSON.parse(readFileSync(input.file, "utf8"));
}
export function verifyVoiceRef(
  root: string,
  ref: z.infer<typeof VoiceRefSchema>,
  scopeRoot = root,
  task?: "tts" | "dialogue" | "voice-change" | "video-reference",
) {
  if (ref.manifest) {
    const source = regularInput(root, ref.manifest, scopeRoot, 4 * 1024 * 1024);
    if (source.sha256 !== ref.manifestSha256) throw new Error("Pinned voice manifest changed");
    const data = JSON.parse(readFileSync(source.file, "utf8"));
    if (data.voiceId !== ref.voiceId || data.readiness !== "ready")
      throw new Error("Selected voice is not ready or does not match its manifest");
    if (task && Array.isArray(data.rights?.permittedUses) && !data.rights.permittedUses.includes(task))
      throw new Error("The supplied voice permission does not cover this operation");
    if (
      task !== "voice-change" &&
      ((data.model && data.model !== ref.model) ||
        (Array.isArray(data.supportedModels) && !data.supportedModels.includes(ref.model)))
    )
      throw new Error("Voice is not ready for the selected model");
  }
  if (ref.selection) {
    const choice = regularInput(root, ref.selection, scopeRoot, 4 * 1024 * 1024);
    if (choice.sha256 !== ref.selectionSha256) throw Error("Pinned voice selection changed");
    const data = JSON.parse(readFileSync(choice.file, "utf8"));
    if (
      data.version !== 1 ||
      data.status !== "approved" ||
      data.voiceId !== ref.voiceId ||
      data.model !== ref.model ||
      data.language !== ref.language ||
      (data.manifestSha256 ?? undefined) !== ref.manifestSha256
    )
      throw Error("Voice selection belongs to another voice, model, language or manifest");
  }
}
export const jsonHash = (value: unknown) => digest(JSON.stringify(value));
export const logicalJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
