import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { computeCurves, DEFAULT_CURVE_PARAMS } from "../src/lib/audio-curves/compute";
import { measureLevels, measureStems } from "../src/lib/audio-curves/measure";
import { AudioMapSchema } from "../src/types/film";

const SPECS = [
  { name: "map", required: true, description: "Audio map JSON from audio:map" },
  { name: "output", required: true, description: "Where to write the curves JSON" },
  {
    name: "input",
    description:
      "The mapped audio file: adds the mid band and measures level and bands per frame instead of resampling the map",
  },
  { name: "fps", type: "number", default: 30, description: "Film frame rate" },
  { name: "offset-sec", type: "number", default: 0, description: "Seconds of the track at the film's first frame" },
  { name: "frames", type: "number", description: "Number of frames; defaults to the rest of the track" },
  {
    name: "attack-ms",
    type: "number",
    default: DEFAULT_CURVE_PARAMS.attackMs,
    description: "Rise time of level, band and stem curves",
  },
  {
    name: "release-ms",
    type: "number",
    default: DEFAULT_CURVE_PARAMS.releaseMs,
    description: "Fall time of level, band and stem curves",
  },
  {
    name: "half-life-ms",
    type: "number",
    default: DEFAULT_CURVE_PARAMS.halfLifeMs,
    description: "Kick, snare and hat envelopes halve every this many ms (downbeat: twice that)",
  },
  {
    name: "energy-window-ms",
    type: "number",
    default: DEFAULT_CURVE_PARAMS.energyWindowMs,
    description: "Width of the centred window that smooths level into energy",
  },
  { name: "no-stems", type: "boolean", description: "Skip stem levels even when the map names a stems directory" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const fps = args.fps;
  if (!(fps > 0)) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--fps must be positive" });
  requireFile(args.map!);
  const parsed = AudioMapSchema.safeParse(JSON.parse(readFileSync(args.map!, "utf8")));
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${args.map} is not an audio map: ${parsed.error.message.slice(0, 300)}`,
    });
  const map = parsed.data;
  const offsetSec = args["offset-sec"];
  const frameCount = args.frames ?? Math.max(0, Math.round((map.source.durationSec - offsetSec) * fps));
  const window = { fps, offsetSec, frameCount };
  const decoder = map.source.decoder;
  let measured;
  if (args.input) {
    ensureFfmpeg();
    process.stderr.write(`Measuring level and bands of ${args.input}\n`);
    measured = measureLevels(args.input, { ...window, trimSec: decoder?.primingCorrected ? decoder.primingSec : 0 });
  }
  const stemsDir = !args["no-stems"] && map.stems?.dir && existsSync(map.stems.dir) ? map.stems.dir : undefined;
  let stems;
  if (stemsDir) {
    ensureFfmpeg();
    process.stderr.write(`Measuring stems in ${stemsDir}\n`);
    stems = measureStems(stemsDir, window);
  }
  const curves = computeCurves({
    map,
    fps,
    offsetSec,
    frameCount,
    ...(measured ? { measured } : {}),
    ...(stems ? { stems } : {}),
    params: {
      attackMs: args["attack-ms"],
      releaseMs: args["release-ms"],
      halfLifeMs: args["half-life-ms"],
      energyWindowMs: args["energy-window-ms"],
    },
    source: { map: args.map!, ...(args.input ? { input: args.input } : {}), ...(stemsDir ? { stemsDir } : {}) },
  });
  mkdirSync(path.dirname(path.resolve(args.output!)), { recursive: true });
  writeFileSync(args.output!, `${JSON.stringify(curves)}\n`);
  const names = Object.keys(curves.curves);
  const missing = [
    ...(measured ? [] : ["mid (needs --input)"]),
    ...(stems && Object.keys(stems).length ? [] : ["stems (needs a map made with --stems)"]),
    ...(curves.curves.beatPhase ? [] : [`beatPhase/barPhase/downbeat (grid trust ${curves.grid.trust})`]),
  ];
  return {
    outputs: [args.output!],
    metadata: { fps, frameCount, curves: names, missing, gridTrust: curves.grid.trust, apiCalls: 0 },
  };
});
