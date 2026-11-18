import { CliErrorObject, ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { detectFootageShots, type Engine } from "../src/lib/footage/shots";

const SPECS = [
  { name: "input", required: true, description: "Video file" },
  {
    name: "output-dir",
    required: true,
    description: "Directory for shots.json, storyboard-NN.jpg, strips/ and cfr.mp4 when the input needed one",
  },
  {
    name: "engine",
    default: "auto",
    choices: ["auto", "transnetv2", "reference"],
    description: "auto tries TransNetV2 on CPU and falls back to the reference detector",
  },
  {
    name: "fps",
    type: "number",
    description:
      "Convert to this constant frame rate first. Variable frame rate input is converted to 30 by default, as recording-edit does",
  },
  { name: "strips", type: "boolean", description: "Also write strips/<shot>.jpg with up to 12 frames of each shot" },
  { name: "width", type: "number", description: "Storyboard tile width in pixels" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  if (args.fps !== undefined && !(args.fps > 0 && args.fps <= 240))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--fps must be between 0 and 240, got ${args.fps}.` });
  const { result, outputs } = detectFootageShots({
    input: args.input!,
    outputDir: args["output-dir"]!,
    engine: args.engine as Engine | "auto",
    fps: args.fps,
    strips: args.strips,
    width: args.width,
  });
  return {
    outputs,
    metadata: {
      engine: result.detector.engine,
      device: result.detector.device,
      fallback: result.detector.fallback,
      fps: result.fps,
      frames: result.frames,
      variableFrameRate: result.source.variableFrameRate,
      normalised: result.source.normalised,
      shots: result.shots.length,
      cuts: Object.fromEntries(
        (["cut", "dissolve", "fade"] as const).map((type) => [
          type,
          result.cuts.filter((cut) => cut.type === type).length,
        ]),
      ),
      apiCalls: 0,
    },
  };
});
