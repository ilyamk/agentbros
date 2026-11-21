import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { parseRegion } from "../src/lib/colour/args";
import { runColourWorker } from "../src/lib/colour/worker";
import { TrackResultSchema, TrackSchema } from "../src/types/colour";

const SPECS = [
  { name: "input", required: true, description: "Video whose subject the window follows" },
  {
    name: "box",
    required: true,
    description: "Window at --at as x,y,w,h in source pixels (read it off frame.png from colour:scopes)",
  },
  {
    name: "at",
    type: "number",
    default: 0,
    description: "Time in seconds where --box is placed; tracking runs forward and backward from it",
  },
  {
    name: "output",
    required: true,
    description: "Where to write the track .json (a track-preview.png goes beside it)",
  },
  { name: "max-width", type: "number", default: 640, description: "Tracking resolution (frames are downscaled)" },
  { name: "force", type: "boolean", description: "Overwrite an existing track" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  requireFile(args.input!);
  ensureFfmpeg();
  const output = path.resolve(args.output!);
  if (existsSync(output) && !args.force)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `${args.output} exists; pass --force to overwrite it` });
  const box = parseRegion(args.box, "box")!;
  const evidence = output.replace(/\.json$/i, "") + "-track";
  mkdirSync(evidence, { recursive: true });
  const result = runColourWorker(
    "track",
    {
      input: path.resolve(args.input!),
      box,
      at: args.at ?? 0,
      output: evidence,
      maxWidth: Math.round(args["max-width"] ?? 640),
    },
    TrackResultSchema,
  );
  const track = TrackSchema.parse({
    version: 1,
    input: path.basename(args.input!),
    box,
    at: args.at ?? 0,
    method: "opencv-template-ncc",
    keyframes: result.keyframes,
  });
  writeFileSync(output, `${JSON.stringify(track)}\n`);
  return {
    outputs: [output, result.files.preview!],
    metadata: {
      keyframes: track.keyframes.length,
      lostPct: result.lostPct,
      lostTimes: (result as { lostTimes?: number[] }).lostTimes,
      preview: result.files.preview,
      note: "Open the preview: a red box marks frames where the match was lost and the window held its position.",
      use: `"mask": { "kind": "shape", "shape": "ellipse", "track": "${path.basename(output)}", "softness": 0.25 }`,
      apiCalls: 0,
    },
  };
});
