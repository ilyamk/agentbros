import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { assertDubbingSnapshot } from "./dubbing";
import { projectOutput, regularInput, jsonHash } from "./files";
import { digest, immutableWrite } from "../jobs/model-artifacts";
import { inspectAsset } from "../assets/inspect";
import { ensureFfmpeg } from "../cli";

export const DubbingConformRequestSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    binding: z.string().min(1),
    targetLanguage: z.string().min(2),
    clips: z
      .array(
        z
          .object({
            sceneId: z.string().min(1),
            startSec: z.number().finite().nonnegative(),
            endSec: z.number().finite().positive(),
            output: z.string().min(1),
          })
          .strict()
          .refine((clip) => clip.endSec > clip.startSec),
      )
      .min(1)
      .max(1000),
  })
  .strict();

/** Explicit reviewed spans; no automatic splitting, word timing or translation approval. */
export function conformDubbingAudio(
  raw: unknown,
  options: { rootDir?: string; scopeRoot?: string; dryRun?: boolean } = {},
) {
  const request = DubbingConformRequestSchema.parse(raw),
    root = path.resolve(options.rootDir ?? process.cwd());
  const selected = assertDubbingSnapshot(root, request.binding, request.targetLanguage, options.scopeRoot);
  const source = regularInput(root, selected.output, options.scopeRoot ?? root);
  const duration = inspectAsset(source.file).media.durationSec!;
  if (request.clips.some((clip) => clip.endSec > duration + 1 / 48000)) throw Error("Dub span exceeds selected audio");
  const targets = request.clips.map((clip) => ({ clip, target: projectOutput(root, request.projectId, clip.output) }));
  if (
    new Set(targets.map((row) => row.target.file)).size !== targets.length ||
    new Set(request.clips.map((clip) => clip.sceneId)).size !== targets.length
  )
    throw Error("Conform clips need unique scenes and outputs");
  if (targets.some((row) => path.extname(row.target.file) !== ".mp3"))
    throw Error("Template speech conformance requires MP3 outputs");
  if (options.dryRun !== false)
    return {
      outputs: [],
      metadata: { state: "planned", request, sourceSha256: source.sha256, apiCalls: 0, alignmentRequired: true },
    };
  ensureFfmpeg();
  const directory = mkdtempSync(path.join(tmpdir(), "dub-conform-"));
  try {
    const outputs: string[] = [];
    for (const [index, { clip, target }] of targets.entries()) {
      const identity = jsonHash({ sourceSha256: source.sha256, clip, codec: "libmp3lame-192k-48k-v1" }),
        receiptFile = `${target.file}.dubbing-source.json`;
      if (existsSync(receiptFile)) {
        const saved = JSON.parse(readFileSync(receiptFile, "utf8"));
        if (saved.inputHash !== identity || regularInput(root, target.file).sha256 !== saved.sha256)
          throw Error("Conformed dub differs from its immutable receipt");
      } else {
        const temporary = path.join(directory, `${index}.mp3`);
        const result = spawnSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            source.file,
            "-ss",
            String(clip.startSec),
            "-t",
            String(clip.endSec - clip.startSec),
            "-vn",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            temporary,
          ],
          { timeout: 120_000, maxBuffer: 1024 * 1024 },
        );
        if (result.error || result.status !== 0) throw Error("Dub conformance failed");
        const bytes = readFileSync(temporary);
        if (regularInput(root, source.file).sha256 !== source.sha256)
          throw Error("Selected dub changed during conformance");
        immutableWrite(target.file, bytes);
        immutableWrite(
          receiptFile,
          `${JSON.stringify({ version: 1, sourceSha256: source.sha256, sha256: digest(bytes), inputHash: identity, sceneId: clip.sceneId, startSec: clip.startSec, endSec: clip.endSec, language: request.targetLanguage, binding: request.binding, alignmentRequired: true }, null, 2)}\n`,
        );
      }
      outputs.push(target.file, receiptFile);
    }
    return {
      outputs,
      metadata: { state: "published", sourceSha256: source.sha256, apiCalls: 0, alignmentRequired: true },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
