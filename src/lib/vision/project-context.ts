import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { TimelineIR } from "../../types/timeline";
import { CliErrorObject } from "../cli";
import { adaptLegacyProject, compileTimelineIR, numeric } from "../timeline-ir";
import type { CaptionSpan } from "./sheets";

/** Newest MP4 directly in out/<project>/. */
export function latestProjectRender(projectId: string, rootDir = "."): string {
  const directory = path.resolve(rootDir, "out", projectId);
  const renders = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".mp4"))
        .map((name) => path.join(directory, name))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (!renders[0])
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `No MP4 in ${directory}. Render first or pass --input.`,
    });
  return renders[0];
}

/** Visual clip boundaries and labels from the project's timeline, or its legacy project.json. */
export function projectTimelineContext(projectId: string, rootDir = "."): { marks: number[]; captions: CaptionSpan[] } {
  const project = path.resolve(rootDir, "public", "projects", projectId);
  const journal = path.join(project, "pipeline", "timeline-edit.json");
  const timeline: TimelineIR = existsSync(journal)
    ? JSON.parse(readFileSync(journal, "utf8")).timeline
    : adaptLegacyProject(JSON.parse(readFileSync(path.join(project, "project.json"), "utf8")), projectId);
  const compiled = compileTimelineIR(timeline);
  const seconds = (frame: Parameters<typeof numeric>[0]) => numeric(frame) / numeric(compiled.timebase);
  const captions = compiled.tracks
    .filter((track) => track.kind === "visual")
    .flatMap((track) =>
      track.clips.map((clip) => {
        const scene = (clip.payload as { scene?: { headline?: unknown; text?: unknown } } | undefined)?.scene;
        const text = [scene?.headline, scene?.text].find((value) => typeof value === "string" && value.trim());
        return {
          startSec: seconds(clip.start),
          endSec: seconds(clip.end),
          text: (text as string | undefined) ?? clip.id,
        };
      }),
    );
  return { marks: captions.map((span) => span.startSec).filter((value) => value > 0), captions };
}
