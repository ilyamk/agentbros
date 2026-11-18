import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { readMixPlan, readSoundSheet } from "../src/lib/audio/masking-files";
import { buildCriticPack } from "../src/lib/film/critic-pack";
import { readSoundReviews, reviewDirOf } from "../src/lib/audio/review-evidence";
import { hashFile } from "../src/lib/assets/registry";
import { evidenceFor, writeJsonAtomic } from "../src/lib/film/evidence";
import { projectPipeline, readJsonFile } from "../src/lib/film/inputs";
import { AudioMapSchema, CueSheetSchema } from "../src/types/film";

const SPECS = [
  { name: "render", description: "The film; default out/<project>/film.mp4" },
  { name: "project", description: "Project ID: supplies the default render, cue sheet and output directory" },
  { name: "cue-sheet", description: "CueSheet JSON: adds frames around each cue" },
  {
    name: "reference",
    description:
      "Reference video, drawn beside the film on matching downbeats (else matching times); from a library entry also adds its sync and pilot-spec.md",
  },
  {
    name: "audio-map",
    description: "The film's audio map: sync v2 and downbeats; default pipeline/audio-map.json with --project",
  },
  {
    name: "mix-report",
    description:
      "audio:mix's kept result: mixed loudness and duck depth; default pipeline/mix-report.json with --project",
  },
  {
    name: "sound-cues",
    description:
      "Sound cue sheet (sfx:cues): SFX and masking on the sync map; default pipeline/sound-cues.json with --project",
  },
  {
    name: "mix-plan",
    description:
      "audio:mix plan: music and voice levels (startSec, volume, keyframes, duckDb) for the masking reading; default pipeline/mix-plan.json with --project",
  },
  { name: "music", description: "Music file for the masking reading; default the audio map's source when it exists" },
  {
    name: "audio-review",
    description:
      "Optional saved source-bound Earshot report for this render or a selected cue sound; advisory only. With --project, every saved audit in pipeline/audio-review/ of the render's or a placed sound's bytes is attached as audio-reviews.json",
  },
  { name: "previous-critique", description: "The previous round's critique, passed on by path, unchanged" },
  { name: "output-dir", description: "Directory for the pack; default pipeline/critic-pack/ with --project" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  if (args.project) requireProject(args.project);
  const render = args.render ?? (args.project ? path.join("out", args.project, "film.mp4") : undefined);
  const directory = args["output-dir"] ?? (args.project ? projectPipeline(args.project, "critic-pack") : undefined);
  if (!render || !directory)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --render and --output-dir, or --project." });
  if (args["previous-critique"] && !existsSync(args["previous-critique"]))
    throw new CliErrorObject({
      code: "FILE_NOT_FOUND",
      message: `Previous critique not found: ${args["previous-critique"]}`,
    });
  const defaultCues = args.project ? projectPipeline(args.project, "cue-sheet.json") : undefined;
  const cuePath = args["cue-sheet"] ?? (defaultCues && existsSync(defaultCues) ? defaultCues : undefined);
  const fromProject = (flag: string | undefined, file: string) =>
    flag ??
    (args.project && existsSync(projectPipeline(args.project, file)) ? projectPipeline(args.project, file) : undefined);
  const mapPath = fromProject(args["audio-map"], "audio-map.json");
  const mixReport = fromProject(args["mix-report"], "mix-report.json");
  const soundCuesPath = fromProject(args["sound-cues"], "sound-cues.json");
  const mixPlanPath = fromProject(args["mix-plan"], "mix-plan.json");
  const soundCues = soundCuesPath ? readSoundSheet(soundCuesPath) : undefined;
  const evidence = evidenceFor(path.resolve(render), path.join(directory, "evidence.json"));
  const pack = buildCriticPack({
    render: path.resolve(render),
    evidence,
    directory: path.resolve(directory),
    cueSheet: cuePath ? readJsonFile(cuePath, CueSheetSchema, "Cue sheet") : undefined,
    reference: args.reference,
    audioMap: mapPath ? readJsonFile(mapPath, AudioMapSchema, "Audio map") : undefined,
    mixReport,
    previousCritique: args["previous-critique"],
    soundCues,
    music: args.music,
    mixPlan: readMixPlan(mixPlanPath),
    mixPlanPath,
    audioReview: args["audio-review"],
    // Every saved audit of the render's or a placed sound's current bytes travels with the pack.
    ...(args.project
      ? {
          audioReviews: readSoundReviews(
            [render, ...(soundCues?.events ?? []).map((event) => path.join("public", event.file))],
            reviewDirOf(path.join("public/projects", args.project)),
            (file) => (existsSync(file) ? hashFile(file) : undefined),
          ),
        }
      : {}),
  });
  const manifest = writeJsonAtomic(path.join(directory, "pack.json"), pack);
  return { outputs: [manifest, ...pack.readingOrder], metadata: { manifest, ...pack, apiCalls: 0 } };
});
