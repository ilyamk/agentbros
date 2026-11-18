import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject } from "../cli";
import { hashFile } from "../assets/registry";
import { readSoundReviews, reviewDirOf } from "../audio/review-evidence";
import { AudioMapSchema, CueSheetSchema, FilmTargetsSchema, MusicDecisionSchema } from "../../types/film";

export const projectPipeline = (project: string, file: string) =>
  path.join("public/projects", project, "pipeline", file);

export function readJsonFile<S extends z.ZodType>(file: string, schema: S, what: string): z.output<S> {
  if (!existsSync(file)) throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `${what} not found: ${file}` });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${what} ${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${what} ${file} does not match its schema: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    });
  return parsed.data;
}

/** An explicit flag must exist. A project's default path is used only when the file is there. */
const resolve = (explicit: string | undefined, project: string | undefined, file: string) =>
  explicit ?? (project && existsSync(projectPipeline(project, file)) ? projectPipeline(project, file) : undefined);

export function readFilmInputs(options: {
  project?: string;
  targets?: string;
  audioMap?: string;
  cueSheet?: string;
  decision?: string;
  soundCues?: string;
}) {
  const targetsPath = resolve(options.targets, options.project, "film-targets.json");
  const audioMapPath = resolve(options.audioMap, options.project, "audio-map.json");
  const cueSheetPath = resolve(options.cueSheet, options.project, "cue-sheet.json");
  const decisionPath = resolve(options.decision, options.project, "music-decision.json");
  const soundCuesPath = resolve(options.soundCues, options.project, "sound-cues.json");
  const soundCues = soundCuesPath ? readJsonFile(soundCuesPath, PlacedSoundsSchema, "Sound cues") : undefined;
  // Saved Earshot audits of the placed files, by their current bytes; read only, never run.
  const sfxReviews =
    soundCues && options.project
      ? readSoundReviews(
          soundCues.events.map((event) => event.file),
          reviewDirOf(path.join("public/projects", options.project)),
          (file) => {
            const absolute = path.join("public", file);
            return existsSync(absolute) ? hashFile(absolute) : undefined;
          },
        )
      : undefined;
  return {
    ...(targetsPath ? { targets: readJsonFile(targetsPath, FilmTargetsSchema, "Targets"), targetsPath } : {}),
    ...(audioMapPath ? { audioMap: readJsonFile(audioMapPath, AudioMapSchema, "Audio map") } : {}),
    ...(cueSheetPath ? { cueSheet: readJsonFile(cueSheetPath, CueSheetSchema, "Cue sheet") } : {}),
    ...(decisionPath ? { decision: readJsonFile(decisionPath, MusicDecisionSchema, "Music decision") } : {}),
    ...(soundCues ? { soundCues, soundCuesPath } : {}),
    ...(sfxReviews ? { sfxReviews } : {}),
  };
}

/** What film:measure reads of sfx:cues' sound cue sheet: frames, files and measured attacks of the placed sounds. */
export const PlacedSoundsSchema = z
  .object({
    fps: z.number().positive(),
    events: z.array(
      z
        .object({
          id: z.string(),
          sfx: z.string(),
          cueFrame: z.number(),
          startFrame: z.number(),
          file: z.string(),
          onsetSec: z.number().nonnegative().optional(),
          weight: z.enum(["hero", "support"]).optional(),
          label: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
