import path from "node:path";
import { attachVideoReview } from "../src/lib/vision/review-adapters";
import { readFileSync } from "node:fs";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { probeVideo, writeImage } from "../src/lib/vision/media";
import {
  buildShotSheet,
  buildStrip,
  phoneReport,
  resolveTileWidth,
  resolveWindow,
  ShotsFileSchema,
} from "../src/lib/vision/sheets";
import { buildVersusStrip, parseSecondsRange, resolveVersusMedia } from "../src/lib/vision/versus";

const SPECS = [
  {
    name: "profile",
    choices: ["overview", "motion", "typography", "ui", "captions", "reference"],
    description: "Detailed review purpose (default motion)",
  },
  { name: "input", required: true, description: "Video file" },
  { name: "output", required: true, description: "Image path (.png or .jpg)" },
  { name: "start-sec", type: "number", description: "Window start in seconds" },
  { name: "end-sec", type: "number", description: "Window end in seconds (exclusive)" },
  { name: "start-frame", type: "number", description: "First frame" },
  { name: "end-frame", type: "number", description: "Last frame (inclusive)" },
  { name: "step", type: "number", default: 1, description: "Keep every Nth frame" },
  { name: "columns", type: "number", description: "Tiles per row" },
  { name: "width", type: "number", description: "Tile width in pixels" },
  {
    name: "phone",
    type: "boolean",
    description: "Draw tiles at true phone viewing size (390 px wide), to expose text unreadable at that size",
  },
  { name: "diff", type: "boolean", description: "Add a frame-difference map under each tile" },
  { name: "by-shots", description: "JSON file with {shots:[{startSec,endSec}]}: first/mid/last frame per shot" },
  {
    name: "vs",
    description:
      "Reference video, or a reference directory (its cropped picture is used): each reference row sits above the matching row of ours",
  },
  {
    name: "vs-range",
    description:
      'With --vs: the reference stretch, "start:end" seconds, sampled into as many frames as ours. Default: the same times',
  },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  const input = args.input!;
  const info = probeVideo(input);
  const shared = { columns: args.columns, width: resolveTileWidth(args.phone, args.width) };
  const hasWindow = [args["start-sec"], args["end-sec"], args["start-frame"], args["end-frame"]].some(
    (value) => value !== undefined,
  );
  if (args["by-shots"] && (hasWindow || args.diff))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--by-shots cannot be combined with a window or --diff.",
    });
  if (args["vs-range"] && !args.vs)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--vs-range needs --vs." });
  if (args.vs) {
    if (args["by-shots"] || args.diff)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--vs cannot be combined with --by-shots or --diff.",
      });
    const reference = resolveVersusMedia(args.vs);
    const { image, ...details } = buildVersusStrip(input, info, reference.media, {
      ...shared,
      startSec: args["start-sec"],
      endSec: args["end-sec"],
      startFrame: args["start-frame"],
      endFrame: args["end-frame"],
      step: args.step,
      referenceRange: args["vs-range"] ? parseSecondsRange(args["vs-range"], "--vs-range") : undefined,
    });
    const output = writeImage(image, args.output!);
    const window = resolveWindow(info, {
      startSec: args["start-sec"],
      endSec: args["end-sec"],
      startFrame: args["start-frame"],
      endFrame: args["end-frame"],
    });
    const ours = attachVideoReview(
      input,
      path.dirname(output),
      details.frames.map((f) => ({
        frame: f.frame,
        reasons: [`paired reference at ${f.referenceSec}s`],
        basis: "declared",
      })),
      { profile: "reference", startFrame: window.first, endFrame: window.last, phone: args.phone },
    );
    const otherInfo = probeVideo(reference.media);
    const other = attachVideoReview(
      reference.media,
      path.dirname(output),
      details.frames.map((f) => ({
        frame: Math.min(otherInfo.frameCount - 1, Math.round(f.referenceSec * otherInfo.fps)),
        reasons: [`paired ours F${f.frame}`],
        basis: "declared",
      })),
      {
        profile: "reference",
        phone: args.phone,
        startFrame: Math.max(0, Math.floor(details.referenceRange.startSec * otherInfo.fps)),
        endFrame: Math.min(otherInfo.frameCount - 1, Math.ceil(details.referenceRange.endSec * otherInfo.fps) - 1),
      },
    );
    return {
      outputs: [output, ...ours.outputs, ...other.outputs],
      metadata: {
        reviewPacks: { ours: ours.reviewPack, reference: other.reviewPack },
        reviewWarnings: [...ours.reviewWarnings, ...other.reviewWarnings],
        input,
        video: info,
        reference: reference.media,
        ...(reference.note ? { note: reference.note } : {}),
        width: image.width,
        height: image.height,
        ...details,
        ...(args.phone ? phoneReport(image) : {}),
      },
    };
  }
  const { image, ...details } = args["by-shots"]
    ? buildShotSheet(
        input,
        info,
        ShotsFileSchema.parse(JSON.parse(readFileSync(args["by-shots"], "utf8"))).shots,
        shared,
      )
    : buildStrip(input, info, {
        ...shared,
        startSec: args["start-sec"],
        endSec: args["end-sec"],
        startFrame: args["start-frame"],
        endFrame: args["end-frame"],
        step: args.step,
        diff: args.diff,
      });
  const output = writeImage(image, args.output!);
  const window = args["by-shots"]
    ? undefined
    : resolveWindow(info, {
        startSec: args["start-sec"],
        endSec: args["end-sec"],
        startFrame: args["start-frame"],
        endFrame: args["end-frame"],
      });
  const events =
    "shots" in details
      ? details.shots.flatMap((shot) =>
          shot.frames.map((frame) => ({
            frame: frame.frame,
            reasons: [`shot ${shot.id ?? shot.index}: ${frame.position}`],
            clipId: shot.id ?? String(shot.index),
            basis: "declared" as const,
          })),
        )
      : [];
  const review = attachVideoReview(input, path.dirname(output), events, {
    profile: (args.profile ?? (args["by-shots"] ? "overview" : "motion")) as "motion",
    ...(window ? { startFrame: window.first, endFrame: window.last, step: args.step } : {}),
    phone: args.phone,
  });
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
      ...(args.phone ? phoneReport(image) : {}),
    },
  };
});
