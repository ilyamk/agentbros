// Back-timing idea from ext/motion-video-kit/business-motion-film/scripts/backtime-music.py (MIT). Own code in src/lib/audio-map/backtime.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { readAudioMap } from "../src/lib/audio-map/analyse";
import { backtime } from "../src/lib/audio-map/backtime";
import { readCueDrafts } from "../src/lib/audio-map/snap";

const SPECS = [
  { name: "map", required: true, description: "Audio map JSON from audio:map" },
  { name: "film-sec", type: "number", required: true, description: "Film length in seconds" },
  { name: "end-card-frame", type: "number", required: true, description: "Frame the end card starts on" },
  { name: "fps", type: "number", required: true, description: "Film frames per second" },
  { name: "cues", description: "Planned cue drafts, to count how many fall on anchors at each offset" },
  { name: "top", type: "number", default: 5, description: "How many offsets to return" },
  { name: "output", description: "Also write the ranked offsets to this JSON file" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (
    !(args.fps! > 0) ||
    !(args["film-sec"]! > 0) ||
    args["end-card-frame"]! < 0 ||
    args["end-card-frame"]! / args.fps! > args["film-sec"]!
  )
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--fps and --film-sec must be positive, and the end card must fall inside the film.",
    });
  const result = backtime({
    map: readAudioMap(args.map!),
    filmSec: args["film-sec"]!,
    endCardFrame: args["end-card-frame"]!,
    fps: args.fps!,
    drafts: args.cues ? readCueDrafts(args.cues) : undefined,
    audioMapPath: args.map!,
    top: args.top,
  });
  const metadata = {
    ...result,
    note: "Ranked by measurement. Automatic picks of an ending can be wrong: confirm the chosen offset by ear.",
    apiCalls: 0,
  };
  if (args.output) {
    mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    writeFileSync(args.output, `${JSON.stringify(metadata, null, 2)}\n`);
  }
  return { outputs: args.output ? [args.output] : [], metadata };
});
