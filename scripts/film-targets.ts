import { readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { evidenceFor, gatherEvidence, hashFileSync, writeJsonAtomic } from "../src/lib/film/evidence";
import {
  anchorsFromAudioLayer,
  boundariesFromShots,
  cutCrossCheck,
  gridFromAudioLayer,
  judgedCutTimes,
  parseRange,
  targetsFromCorpus,
  targetsFromEvidence,
} from "../src/lib/film/targets";
import { analyseAudio } from "../src/lib/reference/audio";
import { buildCorpus } from "../src/lib/reference/corpus";
import { DEFAULT_LIBRARY_ROOT, readAnalysisMedia, readLayer, referenceDirectory } from "../src/lib/reference/library";
import { AudioMapSchema, FilmTargetsSchema } from "../src/types/film";

const SPECS = [
  { name: "reference", description: "Reference id in the library" },
  {
    name: "corpus",
    type: "boolean",
    description:
      "Targets from every analysed reference in the library: the p25-p75 of each pace metric (ref:corpus). No media needed",
  },
  { name: "playbook", description: "With --corpus: only references tagged for this playbook" },
  { name: "exclude", description: "With --corpus: comma-separated reference ids to leave out" },
  {
    name: "library-root",
    default: DEFAULT_LIBRARY_ROOT,
    description: "Library directory for --reference and --corpus",
  },
  {
    name: "reference-dir",
    description: "Decomposed reference directory, such as public/projects/ID/pipeline/reference/film",
  },
  { name: "video", description: "A video file measured directly, without a decomposition" },
  {
    name: "audio-map",
    description: "AudioMap JSON of the reference's own track, to read how its cuts sit on the music",
  },
  { name: "manual", type: "boolean", description: "Set the targets by hand; needs --reason" },
  { name: "reason", description: "With --manual: why this film has no reference" },
  { name: "median-shot", description: 'With --manual: median shot seconds, "min:max", "min:" or ":max"' },
  { name: "variety", description: "With --manual: shot length p90/p10 range" },
  { name: "cuts-per-minute", description: "With --manual: cuts per minute range" },
  { name: "longest-still", description: "With --manual: longest frozen stretch in seconds" },
  { name: "still-share", description: "With --manual: frozen share of the film, 0-1" },
  { name: "loudness", description: "With --manual: integrated LUFS; use --loudness=-16:-12" },
  { name: "cuts-on-audio", description: "With --manual: share of cuts on audio anchors, 0-1" },
  { name: "no-audio-required", type: "boolean", description: "With --manual: this film may be silent" },
  { name: "project", description: "Project ID: writes pipeline/film-targets.json by default" },
  { name: "output", description: "Output JSON path" },
  {
    name: "evidence",
    description: "Keep the slow measurements in this JSON and reuse them while the video is unchanged",
  },
] as const;

const required = (name: string, value: string | undefined) => {
  if (value === undefined)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--manual needs --${name}. A pace target has to be stated.`,
    });
  return value;
};

const range = (name: string, value: string | undefined) => {
  try {
    return parseRange(value) ?? {};
  } catch (error) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--${name}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};

void runScript(async () => {
  const args = parseArgs(SPECS);
  const sources = [
    args.reference,
    args["reference-dir"],
    args.video,
    args.manual ? "manual" : undefined,
    args.corpus ? "corpus" : undefined,
  ].filter(Boolean);
  if (sources.length !== 1)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Pass exactly one of --reference, --reference-dir, --video, --corpus or --manual.",
    });
  if (!args.corpus && (args.playbook || args.exclude))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--playbook and --exclude go with --corpus." });
  if (args.project) requireProject(args.project);
  const output =
    args.output ??
    (args.project ? path.join("public/projects", args.project, "pipeline/film-targets.json") : undefined);
  if (!output) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --output or --project." });

  if (args.manual) {
    if (!args.reason?.trim())
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--manual needs --reason: say why this film has no reference to measure.",
      });
    const targets = FilmTargetsSchema.parse({
      schemaVersion: 1,
      source: "manual",
      reason: args.reason.trim(),
      medianShotSec: range("median-shot", required("median-shot", args["median-shot"])),
      shotLengthVariety: range("variety", required("variety", args.variety)),
      cutsPerMinute: range("cuts-per-minute", required("cuts-per-minute", args["cuts-per-minute"])),
      longestStillSec: range("longest-still", required("longest-still", args["longest-still"])),
      stillShare: range("still-share", args["still-share"]),
      audioRequired: !args["no-audio-required"],
      loudnessLufs: range("loudness", args.loudness),
      cutsOnAudioRatio: range("cuts-on-audio", args["cuts-on-audio"]),
    });
    return { outputs: [writeJsonAtomic(output, targets)], metadata: { targets, apiCalls: 0 } };
  }

  if (args.corpus) {
    // Layers only: no media is read, so no FFmpeg is needed.
    const corpus = buildCorpus({
      libraryRoot: args["library-root"]!,
      exclude: args.exclude?.split(",") ?? [],
      playbook: args.playbook?.trim() || undefined,
    });
    let built: ReturnType<typeof targetsFromCorpus>;
    try {
      built = targetsFromCorpus(corpus);
    } catch (error) {
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      outputs: [writeJsonAtomic(output, built.targets)],
      metadata: {
        targets: built.targets,
        cutsFrom: "corpus",
        referenceIds: corpus.referenceIds,
        warnings: [...corpus.warnings, ...built.warnings],
        apiCalls: 0,
      },
    };
  }

  ensureFfmpeg();
  ensureFfprobe();
  const audioMap = args["audio-map"]
    ? AudioMapSchema.parse(JSON.parse(readFileSync(args["audio-map"], "utf8")))
    : undefined;
  const warnings: string[] = [];

  if (args.video) {
    const media = path.resolve(args.video);
    const evidence = evidenceFor(media, args.evidence);
    const referenceId =
      path
        .basename(media, path.extname(media))
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || undefined;
    let anchors: number[] | undefined;
    let grid: ReturnType<typeof gridFromAudioLayer>;
    if (!audioMap && evidence.video.hasAudio) {
      const layer = analyseAudio({
        referenceId: referenceId ?? "film",
        media,
        directory: path.dirname(media),
        hasAudio: true,
        sha256: hashFileSync(media),
      });
      if (layer.status?.available === false)
        warnings.push(`No beat reading, so no cuts-on-audio target: ${layer.status.unavailableReason}`);
      anchors = anchorsFromAudioLayer(layer);
      grid = gridFromAudioLayer(layer);
    }
    warnings.push(
      "Measured directly, with no analyst's corrections. Boundaries are the detector's reading: it can count motion inside a shot and misses flat text swaps.",
    );
    const targets = targetsFromEvidence({ evidence, referenceId, anchors, grid, audioMap });
    return { outputs: [writeJsonAtomic(output, targets)], metadata: { targets, warnings, apiCalls: 0 } };
  }

  const directory = args["reference-dir"]
    ? path.resolve(args["reference-dir"])
    : referenceDirectory(args["library-root"]!, args.reference!);
  const { source, media: sourceMedia, analysisMedia: media } = readAnalysisMedia(directory);
  const shots = readLayer(directory, "shots.json");
  if (!shots)
    throw new CliErrorObject({
      code: "STAGE_INCOMPLETE",
      message: `No shots.json in ${directory}. Run ref:analyze first, or pass --video.`,
    });
  const edit = readLayer(directory, "edit.json");
  const audio = readLayer(directory, "audio.json");
  const boundaries = boundariesFromShots(shots);
  const evidence = gatherEvidence(media, {
    shots: { boundaries, candidateCount: shots.candidates.length, detector: shots.detector.name },
    audioMedia: sourceMedia,
  });
  if (args.evidence) writeJsonAtomic(args.evidence, evidence);
  if (!edit)
    warnings.push(
      "No edit.json yet, so the cuts are the detector's: it misses flat swaps and the pace may be understated.",
    );
  const targets = targetsFromEvidence({
    evidence,
    referenceId: source.referenceId,
    judgedCuts: edit ? judgedCutTimes(shots, edit) : undefined,
    anchors: anchorsFromAudioLayer(audio),
    grid: gridFromAudioLayer(audio),
    audioMap,
  });
  const crossCheck = cutCrossCheck(targets);
  if (crossCheck?.note) warnings.push(crossCheck.note);
  return {
    outputs: [writeJsonAtomic(output, targets)],
    metadata: {
      targets,
      cutsFrom: edit ? "judged" : "detector",
      ...(crossCheck ? { crossCheck } : {}),
      warnings,
      apiCalls: 0,
    },
  };
});
