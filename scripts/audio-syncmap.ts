import path from "node:path";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { evidenceFor, writeJsonAtomic } from "../src/lib/film/evidence";
import { probeVideo } from "../src/lib/vision/media";
import { readAnyCues, readMapFile, syncMapForRender } from "../src/lib/audio/syncmap-files";
import { readMixPlan } from "../src/lib/audio/masking-files";

const SPECS = [
  { name: "render", required: true, description: "The rendered film (MP4)" },
  { name: "map", description: "Audio map of the music (audio:map): beats, downbeats, phrases" },
  { name: "cues", description: "Sound cue sheet (sfx:cues) or edit cue sheet (edit:snap)" },
  {
    name: "declared",
    description:
      "Another file declaring cuts: edit plan (edit:plan), placements, edit cue sheet or {cuts:[{frame}]}; merged with --cues and the detected cuts",
  },
  { name: "music", description: "Music file for the masking reading; default the map's source when it exists" },
  { name: "plan", description: "audio:mix plan: music and voice levels for the masking reading" },
  {
    name: "music-offset-sec",
    type: "number",
    description: "Film second where the music starts; default the cue sheet's, else 0",
  },
  { name: "output", required: true, description: "Sync map PNG; the JSON is written beside it" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  requireFile(args.render!);
  if (!/\.png$/i.test(args.output!))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--output must end in .png; the JSON goes beside it." });
  const output = path.resolve(args.output!);
  const jsonPath = output.replace(/\.png$/i, ".json");
  const info = probeVideo(args.render!);
  let cues: ReturnType<typeof readAnyCues> = { declared: [] };
  let extra: ReturnType<typeof readAnyCues> = { declared: [] };
  try {
    if (args.cues) cues = readAnyCues(args.cues, info.fps);
    if (args.declared) extra = readAnyCues(args.declared, info.fps);
  } catch (error) {
    throw new CliErrorObject({ code: "INVALID_INPUT", message: (error as Error).message });
  }
  const map = args.map ? readMapFile(args.map) : undefined;
  const evidence = evidenceFor(path.resolve(args.render!), output.replace(/\.png$/i, ".evidence.json"));
  const result = syncMapForRender({
    render: path.resolve(args.render!),
    info,
    evidence,
    map,
    musicOffsetSec: args["music-offset-sec"],
    sheet: cues.sheet ?? extra.sheet,
    cueSheet: cues.cueSheet ?? extra.cueSheet,
    declared: [...cues.declared, ...extra.declared],
    music: args.music,
    plan: readMixPlan(args.plan),
    planPath: args.plan,
    output: jsonPath,
    image: output,
  });
  writeJsonAtomic(jsonPath, result.masking ? { ...result.sync, masking: result.masking } : result.sync);
  return {
    outputs: [result.image, jsonPath],
    metadata: {
      ...result.sync.summary,
      ...(result.masking ? { masking: result.masking.summary } : {}),
      notice: "Measured offsets, not a verdict on feel. The user judges the result.",
      apiCalls: 0,
    },
  };
});
