import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { regularInput } from "../elevenlabs/files";

/** Advisory reports can travel only with their exact current render or selected sound bytes. */
export function boundAudioReview(file: string, eligibleFiles: string[], root = process.cwd()) {
  const report = regularInput(root, file, root, 8 * 1024 * 1024);
  const value = z
    .object({
      engine: z.literal("earshot"),
      advisory: z.literal(true),
      source: z.object({ file: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(),
    })
    .passthrough()
    .parse(JSON.parse(readFileSync(report.file, "utf8")));
  if (regularInput(root, value.source.file).sha256 !== value.source.sha256) throw Error("Audio review source changed");
  if (!eligibleFiles.some((input) => regularInput(root, input).sha256 === value.source.sha256))
    throw Error("Audio review is unrelated to the render and selected cue sounds");
  return value;
}

/** A placed or rendered file and the saved Earshot audit of its exact bytes, when one exists. */
export type SoundReview = {
  file: string;
  sha256: string;
  review?: { ok: boolean; warnings: string[]; notes: string[]; report: string };
};

const SavedCheckSchema = z
  .object({
    engine: z.literal("earshot"),
    advisory: z.literal(true),
    source: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(),
    result: z
      .object({
        ok: z.boolean(),
        warnings: z.array(z.object({ code: z.string() }).passthrough()),
        notes: z.array(z.object({ code: z.string() }).passthrough()).default([]),
      })
      .passthrough(),
  })
  .passthrough();

/** Where a project keeps saved audits, one per audited file's sha256 (sfx:audition, `audio:review --output`). */
export const reviewDirOf = (projectDir: string) => path.join(projectDir, "pipeline", "audio-review");

/**
 * Saved audits (`<reviewDir>/<sha256>.json`) for each file, read by the file's current bytes. Never throws and never runs
 * Earshot: a missing report, a malformed one or one of other bytes leaves `review` unset; an unreadable file is skipped.
 */
export function readSoundReviews(
  files: string[],
  reviewDir: string,
  hash: (file: string) => string | undefined,
): SoundReview[] {
  const rows: SoundReview[] = [];
  for (const file of [...new Set(files)]) {
    const sha256 = hash(file);
    if (!sha256) continue;
    const report = path.join(reviewDir, `${sha256}.json`);
    let review: SoundReview["review"];
    try {
      if (existsSync(report)) {
        const saved = SavedCheckSchema.parse(JSON.parse(readFileSync(report, "utf8")));
        if (saved.source.sha256 === sha256)
          review = {
            ok: saved.result.ok,
            warnings: saved.result.warnings.map((warning) => warning.code),
            notes: saved.result.notes.map((note) => note.code),
            report,
          };
      }
    } catch {
      review = undefined;
    }
    rows.push({ file, sha256, ...(review ? { review } : {}) });
  }
  return rows;
}
