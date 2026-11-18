import { pythonRequirementsHash } from "../src/lib/python";
import { appleVideoDetections } from "../src/lib/apple/detections";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject, emitProgress, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { toSource } from "../src/lib/multicam/angles";
import { probe, sha256File } from "../src/lib/multicam/media";
import { ensureModel, YUNET } from "../src/lib/multicam/models";
import {
  DEFAULT_REFRAME_RULES,
  followFromTranscript,
  planCropPath,
  retimeKeyframes,
  shotRanges,
  sliceKeyframes,
  type Detections,
  type Follow,
} from "../src/lib/multicam/reframe";
import { parseTimelineEditDocument } from "../src/lib/timeline-ir/store";
import { runMulticamWorker } from "../src/lib/multicam/worker";
import { TranscriptSchema } from "../src/types/transcript";
import {
  AngleMapSchema,
  AnglePlanSchema,
  CropPathSchema,
  MulticamSyncSchema,
  type CropPath,
} from "../src/types/multicam";

const SPECS = [
  { name: "input", required: true, description: "Video to reframe" },
  { name: "output", required: true, description: "Where to write crop-path.json" },
  { name: "format", default: "vertical", choices: ["vertical", "square", "landscape"], description: "Target format" },
  {
    name: "shots",
    description: "shots.json from footage:shots ({shots:[{startFrame,endFrame}]}); the path resets at each shot",
  },
  { name: "follow", description: "angles.json from multicam:angles: follow the active speaker in this camera" },
  { name: "sync", description: "sync.json, needed with --follow to place this camera on the reference timeline" },
  { name: "source-id", description: "This camera's id in sync.json (default: matched by sha256)" },
  {
    name: "transcript",
    description:
      "Diarised TranscriptSchema of this video: follow the active speaker in multi-face shots (needs --map speaker positions)",
  },
  {
    name: "map",
    description:
      "Angle map with speaker positions in the wide frame, used with --transcript, or with --follow when no visual focus exists",
  },
  {
    name: "detector",
    choices: ["opencv", "vision"],
    default: "opencv",
    description: "Explicit detector backend; Vision preserves decoded source frame indices and requires CFR",
  },
  {
    name: "detections",
    description: "Reuse a detections JSON written by --save-detections instead of running the detector",
  },
  { name: "save-detections", description: "Also write the raw detections JSON here" },
  { name: "sample-fps", type: "number", default: 5, description: "Detector samples per second" },
  {
    name: "deadzone",
    type: "number",
    default: DEFAULT_REFRAME_RULES.deadzone,
    description: "Stationary when the subject moves within this fraction of the crop",
  },
  {
    name: "min-move",
    type: "number",
    default: DEFAULT_REFRAME_RULES.minMove,
    description: "Ignore subject moves smaller than this fraction of the frame",
  },
  {
    name: "smoothing",
    type: "number",
    default: DEFAULT_REFRAME_RULES.smoothingSec,
    description: "Gaussian smoothing sigma of a pan, seconds",
  },
  { name: "command-output", description: "Also write a timeline-edit reframe-visual command carrying the path" },
  { name: "track-id", default: "visual", description: "Track id for --command-output" },
  {
    name: "clip-id",
    description:
      "Clip id for --command-output; with --timeline also a comma list or `all` (every clip of this video on the track)",
  },
  {
    name: "timeline",
    description: "pipeline/timeline-edit.json: each clip's command carries only the keyframes of its own source span",
  },
  {
    name: "recording-edit",
    description:
      "pipeline/recording-edit.json of a recut of this video: --command-output keyframes are re-keyed to the clip's 30 fps master frames",
  },
] as const;

const DetectionsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  frameCount: z.number().int().positive(),
  samples: z.array(
    z.object({
      frame: z.number().int().nonnegative(),
      faces: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), score: z.number() })),
      people: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), score: z.number() })),
    }),
  ),
});

const RecordingEditSchema = z
  .object({
    request: z.object({ source: z.object({ sha256: z.string() }).passthrough() }).passthrough(),
    normalization: z
      .object({ masterToDecodedFrame: z.array(z.number().int().nonnegative()).min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Recut picture clips read source frames on a 30 fps grid: the original's own frames when it was 30 fps CFR, else the normalised master. */
function masterKeyframes(raw: unknown, cropPath: CropPath, notes: string[]) {
  const edit = RecordingEditSchema.parse(raw);
  if (edit.request.source.sha256 !== cropPath.source.sha256)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--recording-edit is a recut of a different file than --input",
    });
  if (edit.normalization) {
    notes.push(
      `Keyframes re-keyed from ${cropPath.source.fps.num}/${cropPath.source.fps.den} fps original frames to ${edit.normalization.masterToDecodedFrame.length} master frames at 30 fps.`,
    );
    return retimeKeyframes(cropPath.keyframes, edit.normalization.masterToDecodedFrame);
  }
  if (cropPath.source.fps.num !== 30 * cropPath.source.fps.den)
    throw new CliErrorObject({
      code: "VALIDATION",
      message:
        "This recut has no normalised master, but the video is not 30 fps; its clips' source frames cannot be matched",
    });
  return cropPath.keyframes;
}

const readJson = (file: string) => {
  requireFile(file);
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
};

void runScript(async () => {
  const args = parseArgs(SPECS);
  requireFile(args.input!);
  if (args["command-output"] && !args["clip-id"])
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--command-output needs --clip-id" });
  const media = probe(args.input!);
  if (!media.video) throw new CliErrorObject({ code: "INVALID_INPUT", message: `${args.input} has no video stream` });
  const sha256 = sha256File(args.input!);
  let detections: Detections;
  if (args.detections) detections = DetectionsSchema.parse(readJson(args.detections));
  else if (args.detector === "vision") {
    detections = DetectionsSchema.parse(await appleVideoDetections(args.input!, args["sample-fps"]));
    if (args["save-detections"])
      writeFileSync(path.resolve(args["save-detections"]), `${JSON.stringify(detections)}\n`);
  } else {
    const model = await ensureModel(YUNET, "reframe", ".onnx");
    emitProgress(`Detecting faces and people at ${args["sample-fps"]} samples per second`);
    detections = DetectionsSchema.parse(
      runMulticamWorker("detect", {
        media: path.resolve(args.input!),
        model,
        sampleFps: args["sample-fps"],
        maxWidth: 640,
        faceScore: 0.6,
        personScore: 0.5,
      }),
    );
    if (args["save-detections"])
      writeFileSync(path.resolve(args["save-detections"]), `${JSON.stringify(detections)}\n`);
  }
  const shots = args.shots ? shotRanges(readJson(args.shots), detections.fps) : undefined;
  let follow: Follow | undefined;
  const notes: string[] = [];
  if (args.follow) {
    const plan = AnglePlanSchema.parse(readJson(args.follow));
    if (!args.sync)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--follow needs --sync to place this camera on the reference timeline",
      });
    const sync = MulticamSyncSchema.parse(readJson(args.sync));
    const camera = args["source-id"]
      ? sync.sources.find((source) => source.id === args["source-id"])
      : sync.sources.find((source) => source.sha256 === sha256);
    if (!camera || camera.videoOffsetSec === null)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "This video is not a synced camera in --sync (pass --source-id)",
      });
    const map = args.map ? AngleMapSchema.parse(readJson(args.map)) : null;
    const planFps = plan.fps.num / plan.fps.den;
    const toFrame = (referenceFrame: number) =>
      Math.round(
        (toSource(camera, referenceFrame / planFps) - (camera.videoOffsetSec! - camera.offsetSec)) * detections.fps,
      );
    follow = plan.segments.flatMap((segment) => {
      const placed =
        map?.wide === camera.id && segment.speaker
          ? map.speakers.find((row) => row.speaker === segment.speaker && row.position !== undefined)
          : undefined;
      const point =
        segment.focus && plan.focusSource === camera.id
          ? segment.focus
          : placed
            ? { x: placed.position!, y: 0.4 }
            : null;
      if (!point) return [];
      const { x, y } = point;
      return [{ startFrame: toFrame(segment.startFrame), endFrame: toFrame(segment.endFrame), x, y }];
    });
    if (!follow.length)
      notes.push(
        "Nothing to follow in this camera: no visual focus measured here and no speaker positions for it as the wide shot.",
      );
  }
  if (args.transcript) {
    if (follow) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Use --follow or --transcript, not both" });
    const transcript = TranscriptSchema.parse(readJson(args.transcript));
    if (transcript.source.sha256 !== sha256)
      notes.push(
        "The transcript was made from another file (for example its extracted audio); its times are taken as this video's.",
      );
    if (!transcript.engine.diarized) notes.push("The transcript is not diarised: nothing to follow.");
    const map = args.map ? AngleMapSchema.parse(readJson(args.map)) : null;
    const positions = Object.fromEntries(
      (map?.speakers ?? []).filter((row) => row.position !== undefined).map((row) => [row.speaker, row.position!]),
    );
    if (!Object.keys(positions).length)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--transcript needs --map with each speaker's position (0 left, 1 right) in the frame",
      });
    follow = followFromTranscript(transcript, positions, detections.fps);
  }
  const rules = { deadzone: args.deadzone, minMove: args["min-move"], smoothingSec: args.smoothing };
  const planned = planCropPath({
    detections,
    format: args.format as "vertical" | "square" | "landscape",
    shots,
    follow,
    rules,
  });
  const fps = media.video.fps;
  const cropPath = CropPathSchema.parse({
    version: 1,
    source: {
      file: args.input!,
      sha256,
      width: detections.width,
      height: detections.height,
      fps,
      frameCount: detections.frameCount,
    },
    format: args.format,
    crop: planned.crop,
    detector: {
      face: `${YUNET.name} (opencv_zoo, MIT) via OpenCV (uv.lock ${pythonRequirementsHash()})`,
      person: "OpenCV HOG people detector",
      sampleFps: args["sample-fps"],
    },
    rules,
    shots: planned.shots,
    keyframes: planned.keyframes,
  });
  const output = path.resolve(args.output!);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(cropPath, null, 2)}\n`);
  const outputs = [args.output!];
  if (args["command-output"]) {
    const keyframes = args["recording-edit"]
      ? masterKeyframes(readJson(args["recording-edit"]), cropPath, notes)
      : cropPath.keyframes;
    const one = (clipId: string, path: typeof keyframes) => ({
      type: "reframe-visual",
      trackId: args["track-id"],
      clipId,
      format: args.format,
      position: { keyframes: path },
    });
    let command: unknown = one(args["clip-id"]!, keyframes);
    if (args.timeline) {
      const track = parseTimelineEditDocument(readJson(args.timeline)).timeline.tracks.find(
        (item) => item.id === args["track-id"],
      );
      if (!track)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `Track ${args["track-id"]} is not in --timeline` });
      const clips =
        args["clip-id"] === "all"
          ? track.clips.filter((clip) =>
              args["recording-edit"] ? clip.payload?.sourceHash === sha256 : clip.assetId === `sha256:${sha256}`,
            )
          : args["clip-id"]!.split(",").map(
              (id) =>
                track.clips.find((clip) => clip.id === id) ??
                (() => {
                  throw new CliErrorObject({ code: "INVALID_INPUT", message: `Clip ${id} is not on ${track.id}` });
                })(),
            );
      if (!clips.length)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: `No clip of this video on ${track.id}` });
      if (clips.length > 100)
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: `${clips.length} clips exceed one timeline batch (100); pass --clip-id lists of at most 100`,
        });
      const commands = clips.map((clip) =>
        one(
          clip.id,
          sliceKeyframes(
            keyframes,
            Math.floor(clip.source.start.num / clip.source.start.den),
            Math.ceil(clip.source.end.num / clip.source.end.den),
          ),
        ),
      );
      command = commands.length === 1 ? commands[0] : { type: "batch", commands };
    }
    writeFileSync(path.resolve(args["command-output"]), `${JSON.stringify(command, null, 2)}\n`);
    outputs.push(args["command-output"]);
  }
  const modes = cropPath.shots.reduce<Record<string, number>>(
    (all, shot) => ({ ...all, [shot.mode]: (all[shot.mode] ?? 0) + 1 }),
    {},
  );
  return {
    outputs,
    metadata: {
      shots: cropPath.shots.length,
      modes,
      keyframes: cropPath.keyframes.length,
      crop: cropPath.crop,
      notes,
      apiCalls: 0,
    },
  };
});
