import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { DECODE_SPECS, decodeRequest, frameCount, parseRegion } from "../src/lib/colour/args";
import { runColourWorker } from "../src/lib/colour/worker";
import { ScopesResultSchema } from "../src/types/colour";

const SPECS = [
  { name: "input", required: true, description: "Video or still image to measure" },
  { name: "output", required: true, description: "Directory for the scope PNGs, sheet.png and stats.json" },
  { name: "at", type: "number", description: "Measure one frame at this time in seconds" },
  { name: "frames", type: "number", default: 6, description: "Frames sampled evenly across a video (scopes accumulate them)" },
  { name: "skin-region", description: "Measure skin inside x,y,w,h (source pixels) instead of the chroma mask" },
  ...DECODE_SPECS,
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  requireFile(args.input!);
  ensureFfmpeg();
  const output = path.resolve(args.output!);
  mkdirSync(output, { recursive: true });
  const result = runColourWorker(
    "scopes",
    {
      input: path.resolve(args.input!),
      output,
      ...(args.at !== undefined ? { at: args.at } : { frames: frameCount(args.frames, 6) }),
      skinRegion: parseRegion(args["skin-region"], "skin-region"),
      ...decodeRequest(args),
    },
    ScopesResultSchema,
  );
  const statsFile = path.join(output, "stats.json");
  writeFileSync(statsFile, `${JSON.stringify({ media: result.media, stats: result.stats, files: result.files }, null, 2)}\n`);
  const stats = result.stats as Record<string, Record<string, unknown>>;
  return {
    outputs: [result.files.sheet!, statsFile],
    metadata: {
      sheet: result.files.sheet,
      files: result.files,
      decode: result.media.decode,
      assumptions: result.media.assumptions,
      activePicture: result.media.activePicture,
      luma: stats.luma,
      clipping: stats.clipping,
      whiteBalance: stats.whiteBalance,
      skin: stats.skin,
      apiCalls: 0,
    },
  };
});
