import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { readAudioMap } from "../src/lib/audio-map/analyse";
import { EDIT_STYLES, planEdit, type EditStyle } from "../src/lib/audio-map/edit-plan";

const SPECS = [
  { name: "map", required: true, description: "Audio map JSON from audio:map (with its structure)" },
  { name: "output", description: "Where to write the edit plan JSON. Defaults to edit-plan.json next to the map" },
  { name: "fps", type: "number", default: 30, description: "Film frames per second" },
  { name: "duration-frames", type: "number", description: "Film length in frames. Defaults to the music's stop" },
  { name: "offset", type: "number", default: 0, description: "Seconds of the track at the film's first frame" },
  {
    name: "style",
    default: "punchy",
    description:
      "calm (cuts on phrase lines, no flurries), punchy (sections and drops on phrase lines, beat cuts inside, beat flurries on fills) or flurry (shorter beat patterns, half-beat flurries)",
  },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (!EDIT_STYLES.includes(args.style as EditStyle))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--style must be one of ${EDIT_STYLES.join(", ")}.` });
  if (!(args.fps! > 0) || args.offset! < 0)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--fps must be positive and --offset must not be negative.",
    });
  const frames = args["duration-frames"];
  if (frames !== undefined && !(Number.isInteger(frames) && frames > 0))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--duration-frames must be a positive integer." });
  const map = readAudioMap(args.map!);
  const plan = planEdit({
    map,
    fps: args.fps!,
    style: args.style as EditStyle,
    durationFrames: frames,
    musicOffsetSec: args.offset!,
    audioMapPath: args.map!,
  });
  const output = args.output ?? path.join(path.dirname(args.map!), "edit-plan.json");
  mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`);
  const roles = plan.slots.reduce<Record<string, number>>(
    (counts, slot) => ({ ...counts, [slot.role]: (counts[slot.role] ?? 0) + 1 }),
    {},
  );
  return {
    outputs: [output],
    metadata: {
      style: plan.style,
      slots: plan.slots.length,
      roles,
      cues: plan.cues.length,
      durationFrames: plan.durationFrames,
      structureSource: plan.structureSource,
      next: `edit:snap --cues ${output} --map ${args.map} --fps ${args.fps} --offset ${args.offset} --output <cue-sheet.json>`,
      notes: plan.notes,
      apiCalls: 0,
    },
  };
});
