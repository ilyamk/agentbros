import path from "node:path";
import { CliErrorObject, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { analyzeAudio } from "../src/lib/audio/analysis";
import { SHARED_SYNTH_PACK, writeSynthSfx } from "../src/lib/audio/sfx-pack";
import { SYNTH_SFX_KINDS, type SynthSfxKind } from "../src/lib/audio/sfx-synth";
import { earshot } from "../src/lib/audio/earshot";

const NOTES: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};
/** A note name as the root in the sub octave (A = 55 Hz), or a number in Hz. */
function rootHz(key: string): number {
  if (/^\d+(\.\d+)?$/.test(key)) return Number(key);
  const semitone = NOTES[key.replace(/m(inor)?$/i, "")];
  if (semitone === undefined)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Unknown key "${key}". Use a note name such as A, F#, Bb, or a frequency in Hz.`,
    });
  return Math.round(55 * 2 ** ((semitone - 9) / 12) * 100) / 100;
}

const SPECS = [
  {
    name: "engine",
    choices: ["native", "earshot"],
    default: "native",
    description: "Existing native synth (default), or prepared optional Earshot bank",
  },
  { name: "bank-id", description: "Shipped Earshot sound identifier" },
  { name: "list", type: "boolean", description: "List the prepared Earshot bank without rendering" },
  { name: "duration", type: "number", description: "Earshot duration in seconds" },
  { name: "apex", type: "number", description: "Earshot peak position in seconds" },
  { name: "pitch", description: "Earshot note, e.g. E5" },
  {
    name: "align",
    choices: ["onset", "peak", "end"],
    default: "peak",
    description: "Earshot measured phase to place on the picture cue",
  },
  { name: "output", description: "New project-local WAV for an Earshot take" },
  { name: "kind", default: "all", choices: ["all", ...SYNTH_SFX_KINDS], description: "Which sound, or all" },
  { name: "seed", type: "number", default: 1, description: "Take number; the same seed gives the same bytes" },
  { name: "key", default: "A", description: "Root note (A, F#, Bb...) or Hz; tonal sounds sit in it" },
  {
    name: "length-frames",
    type: "number",
    description: "Riser: length in frames, so its end lands on the cue frame (default 60)",
  },
  { name: "fps", type: "number", default: 30, description: "Riser: frames per second" },
  { name: "project", description: "Write into public/projects/<id>/assets/sfx/synth instead of the shared pack" },
  { name: "out-dir", description: `Output directory (default ${SHARED_SYNTH_PACK})` },
  { name: "force", type: "boolean", description: "Replace a file whose content differs" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  if (args.engine === "earshot") {
    if (args["out-dir"] || args.force)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Earshot writes immutable project takes; choose a new --output",
      });
    return earshot(
      args.list
        ? { action: "list" }
        : {
            action: "render",
            sound: args["bank-id"],
            seed: args.seed,
            duration: args.duration,
            apex: args.apex,
            pitch: args.pitch,
            alignTo: args.align,
            cueKind: args.kind === "all" ? undefined : args.kind,
          },
      { projectId: args.project, output: args.output },
    );
  }
  if (args.project && args["out-dir"])
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --project or --out-dir, not both." });
  if (args.project) requireProject(args.project);
  const directory =
    args["out-dir"] ??
    (args.project ? path.join("public/projects", args.project, "assets/sfx/synth") : SHARED_SYNTH_PACK);
  const seed = Math.trunc(args.seed!);
  if (!(seed >= 1)) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--seed must be a positive integer." });
  const lengthFrames = args["length-frames"];
  if (lengthFrames !== undefined && !(Number.isInteger(lengthFrames) && lengthFrames >= 2 && lengthFrames <= 300))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--length-frames must be an integer from 2 to 300." });
  if (!(args.fps! > 0)) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--fps must be positive." });
  const kinds: SynthSfxKind[] = args.kind === "all" ? [...SYNTH_SFX_KINDS] : [args.kind as SynthSfxKind];
  const root = rootHz(args.key!);
  const results = [];
  for (const kind of kinds) {
    try {
      const { entry, status } = writeSynthSfx(
        directory,
        { kind, seed, rootHz: root, ...(kind === "riser" ? { lengthFrames: lengthFrames ?? 60, fps: args.fps } : {}) },
        { force: args.force },
      );
      const file = path.join(directory, entry.file);
      const loudness = analyzeAudio(file, { minimumSilenceSec: 10 });
      results.push({
        ...entry,
        path: file,
        status,
        integratedLufs: loudness.integratedLufs,
        truePeakDb: loudness.truePeakDb,
      });
    } catch (error) {
      throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    outputs: [...results.map((item) => item.path), path.join(directory, "pack.json")],
    metadata: {
      directory,
      rootHz: root,
      sounds: results,
      notice: "Agents cannot hear: these are measured, not auditioned. The user judges how they sound.",
      apiCalls: 0,
    },
  };
});
