/**
 * Validates the agent's shorts candidates (verbatim quotes, vetoes, durations), computes the weighted score, snaps to
 * sentence edges padded into silence, drops overlaps and applies the threshold. Writes unapproved proposals; with
 * --project, each proposal also carries a ShortSelection draft in timeline frames for a human to approve.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress, parseArgs, relativisePath, runScript } from "../src/lib/cli";
import { stableHash } from "../src/lib/longform/plans";
import {
  calibrationFile,
  parseWeights,
  readCalibration,
  readJson,
  timelineSource,
  validation,
} from "../src/lib/shorts/cli";
import { loadPrepared, sha256 } from "../src/lib/shorts/prepare";
import { SpeechMaskSchema } from "../src/types/speech-mask";
import { DEFAULT_THRESHOLD, proposalsMarkdown, rankCandidates } from "../src/lib/shorts/rank";

void runScript(async () => {
  const args = parseArgs([
    { name: "prepared", required: true, description: "Directory written by shorts:prepare" },
    { name: "candidates", required: true, description: "The agent's candidates JSON" },
    { name: "threshold", type: "number", description: "Minimum score 0–100; overrides the calibration" },
    { name: "weights", description: "Axis weights, e.g. hook=3,payoff=2 (others keep their defaults)" },
    {
      name: "project",
      description: "Project whose timeline holds the recording: adds ShortSelection drafts and reads its calibration",
    },
    {
      name: "chapters",
      default: "pipeline/chapters.json",
      description: "Chapter manifest with protected spans, relative to the project",
    },
    { name: "track", description: "Timeline track that holds the recording" },
    { name: "asset", description: "Timeline assetId of the recording when it cannot be matched by hash" },
    { name: "calibration", description: "Calibration JSON (default: the project's pipeline/shorts-calibration.json)" },
    {
      name: "speech-mask",
      description:
        "Silero speech mask (speech:local, pipeline/speech-mask.json): edges reach the detected speech and padding stops at neighbouring speech",
    },
    { name: "output", description: "Proposals JSON (default: <prepared>/proposals.json)" },
  ] as const);
  const dir = path.resolve(args.prepared!);
  const { prepared, preparedSha256, transcript, sentences } = validation(() => loadPrepared(dir));
  const candidates = readJson(args.candidates!);
  const weights = parseWeights(args.weights);
  const calibration = args.calibration
    ? readCalibration(path.resolve(args.calibration))
    : args.project
      ? readCalibration(calibrationFile(args.project))
      : null;
  if (args.calibration && !calibration)
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Calibration not found: ${args.calibration}` });
  let threshold = DEFAULT_THRESHOLD,
    thresholdSource: "flag" | "calibration" | "default" = "default";
  if (args.threshold !== undefined) {
    if ((args.threshold as number) < 0 || (args.threshold as number) > 100)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--threshold must be 0–100" });
    threshold = args.threshold as number;
    thresholdSource = "flag";
  } else if (calibration) {
    if (calibration.weightsHash !== stableHash(weights))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "The calibration was made with other weights; recalibrate or pass --threshold",
      });
    threshold = calibration.threshold;
    thresholdSource = "calibration";
  }
  const speechMask = args["speech-mask"]
    ? validation(() => SpeechMaskSchema.parse(readJson(args["speech-mask"]!).value))
    : undefined;
  const timeline = args.project ? timelineSource(args.project, args.chapters!, args.track, args.asset) : undefined;
  const result = validation(() =>
    rankCandidates(prepared, transcript, sentences, candidates.value, {
      weights,
      threshold,
      thresholdSource,
      ...(timeline ? { timeline, publicDir: path.resolve("public") } : {}),
      ...(speechMask ? { speechMask } : {}),
      preparedSha256,
      candidatesSha256: sha256(candidates.raw),
    }),
  );
  const output = path.resolve(args.output ?? path.join(dir, "proposals.json"));
  const markdown = output.replace(/\.json$/, "") + ".md";
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(markdown, proposalsMarkdown(result));
  if (result.proposals.length < 2)
    emitProgress(`Only ${result.proposals.length} proposal(s): shorts-series needs at least 2 approved selections`);
  return {
    outputs: [relativisePath(output), relativisePath(markdown)],
    metadata: {
      proposals: result.proposals.length,
      others: result.others.length,
      rejected: result.rejected.length,
      droppedOverlaps: result.droppedOverlaps.length,
      threshold,
      thresholdSource,
      speechMask: Boolean(speechMask),
      selectionDrafts: result.proposals.filter((p) => p.selection).length,
      enoughForSeries: result.proposals.length >= 2,
      approval: "human: add approval { approvedBy, approvedAt, selectionHash } to each reviewed selection",
    },
  };
});
