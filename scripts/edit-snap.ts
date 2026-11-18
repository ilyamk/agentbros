import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { readAudioMap } from "../src/lib/audio-map/analyse";
import { readCueDrafts, snapCues, suggestCuts } from "../src/lib/audio-map/snap";
import type { LeadOverrides } from "../src/lib/audio-map/leads";
import { z } from "zod";

const SPECS = [
  { name: "map", required: true, description: "Audio map JSON from audio:map" },
  { name: "fps", type: "number", required: true, description: "Film frames per second" },
  { name: "output", required: true, description: "Where to write the cue sheet JSON" },
  {
    name: "cues",
    description:
      "Cue drafts: a JSON array of {id, kind, intentSec, snap?, shotId?, sfx?}, or an object with a cues array",
  },
  { name: "offset", type: "number", default: 0, description: "Seconds of the track at the film's first frame" },
  { name: "suggest", type: "boolean", description: "Propose cuts from the map alone, instead of snapping drafts" },
  {
    name: "film-sec",
    type: "number",
    description: "With --suggest: film length in seconds. Defaults to what the track covers",
  },
  {
    name: "lead",
    description:
      'Per-kind lead in frames as JSON, e.g. {"hit":2}. Defaults: cut and transition 1, hit 1 (max 3), reveal, stop and sfx 0',
  },
  { name: "no-lead", type: "boolean", description: "Deliver every cue on its anchor frame, with no lead" },
] as const;

const frames = z.number().int().min(0).optional();
const LeadSchema = z
  .object({ cut: frames, transition: frames, reveal: frames, hit: frames, stop: frames, sfx: frames })
  .strict();

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (!(args.fps! > 0) || args.offset! < 0)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--fps must be positive and --offset must not be negative.",
    });
  if (args.suggest === Boolean(args.cues))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass either --cues or --suggest." });
  const map = readAudioMap(args.map!);
  const common = { map, fps: args.fps!, musicOffsetSec: args.offset!, audioMapPath: args.map! };
  mkdirSync(path.dirname(path.resolve(args.output!)), { recursive: true });
  if (args.suggest) {
    const { sheet, sections, stats } = suggestCuts({ ...common, filmSec: args["film-sec"] });
    writeFileSync(args.output!, `${JSON.stringify(sheet, null, 2)}\n`);
    return { outputs: [args.output!], metadata: { gridTrust: map.tempo.gridTrust, sections, stats, apiCalls: 0 } };
  }
  let leadFrames: LeadOverrides | false | undefined = args["no-lead"] ? false : undefined;
  if (args.lead && leadFrames !== false) {
    try {
      leadFrames = LeadSchema.parse(JSON.parse(args.lead));
    } catch {
      throw new CliErrorObject({ code: "INVALID_INPUT", message: '--lead must be JSON like {"cut":1,"hit":2}.' });
    }
  }
  const { sheet, unanchored, warnings } = snapCues({ ...common, drafts: readCueDrafts(args.cues!), leadFrames });
  writeFileSync(args.output!, `${JSON.stringify(sheet, null, 2)}\n`);
  return {
    outputs: [args.output!],
    metadata: { gridTrust: map.tempo.gridTrust, cues: sheet.cues.length, unanchored, warnings, apiCalls: 0 },
  };
});
