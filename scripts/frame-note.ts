/**
 * The user's note on one frame of any video of a project (2026-11-20): `pnpm frame:note --project P --media <path>
 * [--root out] --frame N [--fps F] [--expect <sha256>] --answer "<the user's words>" [--marks-file marks.json]
 * [--overlay-file overlay.png] [--region x,y,w,h]`.
 *
 * Writes `public/projects/<id>/pipeline/frame-notes/<id>.json` and `<id>.png`: the frame taken from the video by ffmpeg
 * with the user's marks (points with arrows, boxes, their words) laid over it as the console drew them. The console's
 * `frame-note` decision runs it; `console:wait` then hands the agent the note and the still. Reopens nothing: on a film,
 * `feedback --frame` is what reopens the build.
 */
import { readFileSync } from "node:fs";
import { CliErrorObject, parseArgs, runScript, validateProjectId } from "../src/lib/cli";
import { requireUserWords } from "../src/lib/cli/user-words";
import { parseMarks, writeFrameNote } from "../src/lib/feedback/frame-note";
import { parseRegion } from "../src/lib/feedback/frame";
import { ChainRefusal } from "../src/lib/film/state";
import { CONSOLE_ENV } from "../src/types/console";

void runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    {
      name: "media",
      required: true,
      description: "The video, relative to the project folder (or to out/<id>/ with --root out)",
    },
    { name: "root", choices: ["project", "out"] as const, description: "Where --media is [default: project]" },
    { name: "frame", type: "number", required: true, description: "The frame the user points at (from 0)" },
    {
      name: "fps",
      type: "number",
      description: "Frame rate the frame number counts in [default: the video's (ffprobe)]",
    },
    { name: "expect", description: "SHA-256 of the video the user watched: refused when the file changed" },
    { name: "answer", required: true, description: "The user's own words about the frame, verbatim" },
    {
      name: "marks-file",
      description:
        "JSON array of marks: {x, y, text} a point, {x, y, w, h, text} a box; 0–1 from the top left; at most 9",
    },
    {
      name: "overlay-file",
      description: "Transparent PNG of the marks as the user saw them, laid over the frame (else boxes are drawn)",
    },
    { name: "region", description: "One area of the frame, x,y,w,h from 0 to 1 (top-left origin)" },
  ] as const);
  const project = args.project!;
  validateProjectId(project);
  const words = requireUserWords(args.answer, "--answer");
  let region;
  try {
    region = args.region ? parseRegion(args.region) : undefined;
  } catch (error) {
    if (error instanceof ChainRefusal) throw new CliErrorObject({ code: "INVALID_INPUT", message: error.message });
    throw error;
  }
  const marks = args["marks-file"] ? parseMarks(readFileSync(args["marks-file"], "utf8")) : undefined;
  const result = writeFrameNote({
    rootDir: process.cwd(),
    project,
    media: args.media!,
    root: args.root === "out" ? "out" : "project",
    frame: args.frame!,
    ...(args.fps !== undefined ? { fps: args.fps } : {}),
    ...(args.expect ? { expect: args.expect } : {}),
    words,
    ...(marks?.length ? { marks } : {}),
    ...(region ? { region } : {}),
    ...(args["overlay-file"] ? { overlay: args["overlay-file"] } : {}),
    // The console spawns its decisions with the user's channel (src/lib/console/spawn.ts).
    channel: process.env[CONSOLE_ENV.channel] === "console" ? "console" : "cli",
  });
  return {
    // The still first, then the note (console:wait reads them by their place under pipeline/frame-notes/).
    outputs: [...(result.still ? [result.still] : []), result.note],
    metadata: {
      projectId: project,
      note: result.note,
      ...(result.still ? { still: result.still } : {}),
      noteId: result.record.id,
      frame: result.record.frame,
      time: result.record.time,
      marks: result.record.marks?.length ?? 0,
      drawn: result.record.drawn,
    },
  };
});
