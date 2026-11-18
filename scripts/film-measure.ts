import path from "node:path";
import {
  CliErrorObject,
  emitProgress,
  emitResult,
  ensureFfmpeg,
  ensureFfprobe,
  parseArgs,
  requireProject,
  runScript,
} from "../src/lib/cli";
import { evidenceFor, writeJsonAtomic } from "../src/lib/film/evidence";
import { readFilmInputs } from "../src/lib/film/inputs";
import { measureRender } from "../src/lib/film/measure";
import { snapshotFilmVersion } from "../src/lib/film/versions";
import { noteSensorFail } from "../src/lib/memory/capture";
import { judgeMotion, summariseMotion } from "../src/lib/sensors/motion-expect";

const SPECS = [
  { name: "render", description: "The film; default out/<project>/film.mp4" },
  { name: "project", description: "Project ID: supplies default paths under pipeline/" },
  { name: "targets", description: "FilmTargets JSON from film:targets" },
  { name: "audio-map", description: "AudioMap JSON of the film's track" },
  { name: "cue-sheet", description: "CueSheet JSON: says which boundaries are cuts" },
  {
    name: "sound-cues",
    description:
      "sfx:cues output: cut-sound-coverage measures each cue's lead from the placed sounds; default pipeline/sound-cues.json",
  },
  { name: "decision", description: "MusicDecision JSON: a stated silence makes the audio legs pass" },
  {
    name: "evidence",
    description: "Keep the slow measurements in this JSON and reuse them while the render is unchanged",
  },
  {
    name: "expect-motion",
    description: "animated|still: also judge the render's motion against this expectation (as generate:model does)",
  },
  { name: "output", description: "Output JSON path; default pipeline/film-measure.json with --project" },
] as const;

void runScript(async () => {
  const startedAt = Date.now();
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  if (args.project) requireProject(args.project);
  const render = args.render ?? (args.project ? path.join("out", args.project, "film.mp4") : undefined);
  if (!render) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --render or --project." });
  const inputs = readFilmInputs({
    project: args.project,
    targets: args.targets,
    audioMap: args["audio-map"],
    cueSheet: args["cue-sheet"],
    soundCues: args["sound-cues"],
    decision: args.decision,
  });
  const evidence = evidenceFor(path.resolve(render), args.evidence);
  const expectMotion = args["expect-motion"];
  if (expectMotion !== undefined && expectMotion !== "animated" && expectMotion !== "still")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--expect-motion takes animated or still." });
  const measure = measureRender(path.resolve(render), { evidence, ...inputs });
  const motionExpect = expectMotion
    ? evidence.spread
      ? (() => {
          const motion = summariseMotion(evidence.motion, evidence.spread, evidence.video.durationSec);
          return { expect: expectMotion, motion, ...judgeMotion(motion, { motion: expectMotion }) };
        })()
      : { expect: expectMotion, skipped: "evidence has no spread readings; re-measure without the cached --evidence" }
    : undefined;
  if (motionExpect && "findings" in motionExpect)
    emitProgress(
      `${motionExpect.passed ? "pass" : "fail"}    motion-expect: ${motionExpect.findings.join(" ") || expectMotion}`,
    );
  for (const leg of measure.legs) emitProgress(`${leg.status.padEnd(7)} ${leg.id}: ${leg.message}`);
  const output =
    args.output ??
    (args.project ? path.join("public/projects", args.project, "pipeline/film-measure.json") : undefined);
  const outputs = output ? [writeJsonAtomic(output, measure)] : [];
  // Keep the film this verdict is about, so the next render cannot take the verdict's object away.
  let versionWarning: string | undefined;
  if (args.project && path.resolve(render) === path.resolve("out", args.project, "film.mp4")) {
    try {
      snapshotFilmVersion(
        { id: args.project, rootDir: process.cwd(), projectDir: path.resolve("public/projects", args.project) },
        render,
        {
          step: "measure",
          sha256: measure.renderSha256,
          measure: {
            verdict: measure.verdict,
            ...(output ? { path: output } : {}),
            failing: measure.legs.filter((leg) => leg.status === "fail").map((leg) => leg.id),
          },
        },
      );
    } catch (error) {
      versionWarning = `This render was not kept under out/${args.project}/versions/: ${error instanceof Error ? error.message : String(error)}`;
      emitProgress(versionWarning);
    }
  }
  const metadata = {
    ...(versionWarning ? { versionWarning } : {}),
    ...measure,
    durationSec: evidence.video.durationSec,
    detector: evidence.detector,
    boundaries: evidence.boundaries.length,
    ...(motionExpect ? { motionExpect } : {}),
  };
  const motionFailed = motionExpect !== undefined && "passed" in motionExpect && !motionExpect.passed;
  if (measure.verdict === "pass" && !motionFailed) return { outputs, metadata };
  const failing = [
    ...measure.legs.filter((leg) => leg.status === "fail"),
    ...(motionFailed ? [{ id: "motion-expect" }] : []),
  ];
  const memoryWarning = args.project
    ? noteSensorFail(
        args.project,
        "film:measure",
        failing.map((leg) => leg.id),
        { step: "measure" },
      )
    : undefined;
  if (memoryWarning) emitProgress(memoryWarning);
  return emitResult({
    ok: false,
    error: "VALIDATION",
    message: `film:measure failed ${failing.length} leg(s): ${failing.map((leg) => leg.id).join(", ")}. Read metadata.legs[].fix${motionFailed ? " and metadata.motionExpect.findings" : ""}.`,
    outputs,
    metadata: { ...metadata, ...(memoryWarning ? { memoryWarning } : {}) },
    elapsedMs: Date.now() - startedAt,
  });
});
