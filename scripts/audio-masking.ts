import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { writeJsonAtomic } from "../src/lib/film/evidence";
import { maskingFromFiles, readMixPlan } from "../src/lib/audio/masking-files";
import { projectPipeline } from "../src/lib/film/inputs";

const SPECS = [
  {
    name: "music",
    description: "Music file, or its audio map (source.path must exist); not needed when the plan has a music track",
  },
  {
    name: "plan",
    description:
      "audio:mix plan: music and speech tracks with their startSec, volume, keyframes and duckDb set the levels; default pipeline/mix-plan.json with --project",
  },
  { name: "project", description: "Project ID: default plan" },
  { name: "cues", required: true, description: "Sound cue sheet from sfx:cues ({fps, events})" },
  { name: "vo", description: "Voice-over file on the film timeline" },
  { name: "music-gain", type: "number", description: "Music volume in the mix when there is no plan (default 1)" },
  {
    name: "music-offset-sec",
    type: "number",
    description: "Film second where the music file starts when there is no plan (default 0)",
  },
  { name: "vo-gain", type: "number", description: "Voice volume when there is no plan (default 1)" },
  { name: "output", description: "Report JSON; default <cues>.masking.json" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  requireFile(args.cues!);
  if (args.vo) requireFile(args.vo);
  let report;
  try {
    const planPath = args.plan ?? (args.project ? projectPipeline(args.project, "mix-plan.json") : undefined);
    if (args.plan) requireFile(args.plan);
    const plan = readMixPlan(planPath);
    if (args.plan && !plan)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `${args.plan} is not an audio:mix plan.` });
    report = maskingFromFiles({
      cues: args.cues!,
      plan,
      planPath,
      music: args.music,
      vo: args.vo,
      musicGain: args["music-gain"],
      musicStartSec: args["music-offset-sec"],
      voGain: args["vo-gain"],
    });
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    throw new CliErrorObject({ code: "INVALID_INPUT", message: (error as Error).message });
  }
  const output = args.output ?? args.cues!.replace(/\.json$/, "") + ".masking.json";
  writeJsonAtomic(output, report);
  const problems = report.cues
    .filter((cue) => cue.status !== "audible")
    .map(
      (cue) =>
        `${cue.id} ${cue.status} ${cue.marginDb} dB (${cue.masker}); fix: ${cue.fixes.map((fix) => fix.type).join(", ") || "none"}`,
    );
  return {
    outputs: [path.resolve(output)],
    metadata: {
      ...report.summary,
      problems,
      assumed: report.inputs,
      collisions: report.collisions.map(
        (item) => `${item.kind} at ${item.atSec} s: ${item.ids.join(" + ")}${item.layered ? " (layered)" : ""}`,
      ),
      notice: "A masking model, not a listening test. The user judges the result.",
      apiCalls: 0,
    },
  };
});
