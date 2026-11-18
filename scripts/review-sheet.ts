import path from "node:path";
import { attachVideoReview } from "../src/lib/vision/review-adapters";
import { readFileSync } from "node:fs";
import {
  CliErrorObject,
  emitProgress,
  ensureFfmpeg,
  ensureFfprobe,
  parseArgs,
  requireProject,
  runScript,
} from "../src/lib/cli";
import { probeVideo, writeImage } from "../src/lib/vision/media";
import { latestProjectRender, projectTimelineContext } from "../src/lib/vision/project-context";
import {
  buildReviewSheet,
  CaptionsFileSchema,
  MarksFileSchema,
  phoneReport,
  resolveTileWidth,
  type CaptionSpan,
} from "../src/lib/vision/sheets";

const SPECS = [
  {
    name: "profile",
    choices: ["overview", "motion", "typography", "ui", "captions", "reference"],
    description: "Detailed review purpose",
  },
  { name: "input", description: "Video file; default is the newest MP4 in out/<project>/" },
  { name: "project", description: "Project ID: supplies the default input, cut marks and clip labels" },
  { name: "output", required: true, description: "Image path (.png or .jpg)" },
  { name: "count", type: "number", description: "Evenly spaced frames. Default 12, or 6 with --phone" },
  { name: "times", description: 'Exact times in seconds instead of --count, such as "0,2.5,8"' },
  { name: "marks", description: "JSON file: array of seconds, or {shots:[{startSec,endSec}]}" },
  { name: "captions", description: "JSON file: strings per frame, or [{startSec,endSec,text}]" },
  { name: "columns", type: "number", description: "Tiles per row" },
  { name: "width", type: "number", description: "Tile width in pixels" },
  {
    name: "phone",
    type: "boolean",
    description: "Draw tiles at true phone viewing size (390 px wide), to expose text unreadable at that size",
  },
] as const;

const readMarks = (file: string): number[] => {
  const parsed = MarksFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return Array.isArray(parsed) ? parsed : parsed.shots.map((shot) => shot.startSec).filter((value) => value > 0);
};

const parseTimes = (value: string): number[] => {
  const times = value.split(",").map((part) => Number(part.trim()));
  if (!value.trim() || times.some((time) => !Number.isFinite(time)))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--times must list seconds, got "${value}".` });
  return times;
};

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  if (!args.input && !args.project)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --input, --project or both." });
  if (args.project) requireProject(args.project);
  const input = args.input ?? latestProjectRender(args.project!);
  const warnings: string[] = [];
  let context: { marks: number[]; captions: CaptionSpan[] } | undefined;
  if (args.project)
    try {
      context = projectTimelineContext(args.project);
    } catch (error) {
      warnings.push(
        `Project timeline unavailable, so no project marks or labels: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  const info = probeVideo(input);
  emitProgress(`Building review sheet for ${input}`);
  const {
    image,
    timelineTop: _timelineTop,
    ...details
  } = buildReviewSheet(input, info, {
    count: args.count ?? (args.phone ? 6 : 12),
    times: args.times ? parseTimes(args.times) : undefined,
    marks: args.marks ? readMarks(args.marks) : context?.marks,
    captions: args.captions
      ? CaptionsFileSchema.parse(JSON.parse(readFileSync(args.captions, "utf8")))
      : context?.captions,
    columns: args.columns,
    width: resolveTileWidth(args.phone, args.width),
  });
  const output = writeImage(image, args.output!);
  const review = attachVideoReview(
    input,
    path.dirname(output),
    details.frames.map((frame) => ({
      frame: frame.frame,
      reasons: ["review sample; supplied labels are declared, source alignment unverified"],
      ...(frame.caption ? { text: frame.caption } : {}),
      basis: "declared",
    })),
    { profile: (args.profile ?? "overview") as "overview", phone: args.phone },
  );
  return {
    outputs: [output, ...review.outputs],
    metadata: {
      reviewPack: review.reviewPack,
      reviewWarnings: review.reviewWarnings,
      input,
      video: info,
      width: image.width,
      height: image.height,
      ...details,
      warnings: [...warnings, ...(args.phone ? phoneReport(image).warnings : [])],
      ...(args.phone ? { phone: true } : {}),
    },
  };
});
