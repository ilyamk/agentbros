import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, requireFile, requireProject } from "../cli";
import { ChapterManifestSchema } from "../../types/longform";
import { SHORTS_AXES, ShortsCalibrationSchema, ShortsWeightsSchema, type ShortsWeights } from "../../types/shorts";
import { TimelineEditStore } from "../timeline-ir/store";
import type { TimelineSource } from "./rank";
import { DEFAULT_WEIGHTS } from "./rank";

export function validation<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
  }
}

export function readJson(file: string): { raw: string; value: unknown } {
  requireFile(file);
  const raw = readFileSync(file, "utf8");
  return { raw, value: validation(() => JSON.parse(raw) as unknown) };
}

export const projectDir = (projectId: string) => {
  requireProject(projectId);
  return path.resolve("public/projects", projectId);
};
export const calibrationFile = (projectId: string) =>
  path.join(projectDir(projectId), "pipeline/shorts-calibration.json");

/** `hook=3,payoff=2`: named axes override the defaults. */
export function parseWeights(text: string | undefined): ShortsWeights {
  if (!text) return DEFAULT_WEIGHTS;
  const weights: Record<string, number> = { ...DEFAULT_WEIGHTS };
  for (const part of text.split(",")) {
    const [name, value] = part.split("=").map((s) => s.trim());
    if (
      !name ||
      !(SHORTS_AXES as readonly string[]).includes(name) ||
      value === undefined ||
      !Number.isFinite(Number(value))
    )
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Bad weight "${part}"; use axis=number with axes ${SHORTS_AXES.join(", ")}`,
      });
    weights[name] = Number(value);
  }
  return validation(() => ShortsWeightsSchema.parse(weights));
}

export function timelineSource(
  projectId: string,
  chapters: string,
  trackId?: string,
  assetId?: string,
): TimelineSource {
  const dir = projectDir(projectId);
  const journal = path.join(dir, "pipeline/timeline-edit.json");
  requireFile(journal);
  const ir = validation(() => new TimelineEditStore(journal).read().timeline);
  const chaptersFile = path.join(dir, chapters);
  const protectedSpans = existsSync(chaptersFile)
    ? validation(() => ChapterManifestSchema.parse(JSON.parse(readFileSync(chaptersFile, "utf8"))).protectedSpans)
    : [];
  return {
    ir,
    projectId,
    projectDir: dir,
    protectedSpans,
    ...(trackId ? { trackId } : {}),
    ...(assetId ? { assetId } : {}),
  };
}

export function readCalibration(file: string) {
  if (!existsSync(file)) return null;
  return validation(() => ShortsCalibrationSchema.parse(JSON.parse(readFileSync(file, "utf8"))));
}
