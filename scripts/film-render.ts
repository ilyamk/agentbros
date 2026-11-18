import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
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
import { gatherEvidence, hashFileSync, writeJsonAtomic } from "../src/lib/film/evidence";
import { projectPipeline, readFilmInputs, readJsonFile } from "../src/lib/film/inputs";
import { measureRender } from "../src/lib/film/measure";
import { checkRender, probeRender } from "../src/lib/sensors/render-file";
import { CODEC_CHOICES, DEFAULT_ENTRY, GL_CHOICES, renderClip } from "../src/lib/vision/composition";
import { probeVideo } from "../src/lib/vision/media";
import { MusicDecisionSchema } from "../src/types/film";
import {
  bespokeFormat,
  bespokeOutput,
  captureBespokeIdentity,
  formatOfSize,
  isBespokeDelivery,
} from "../src/lib/delivery/bespoke";
import { publishRenderReceipt } from "../src/lib/delivery/render-receipt";
import { generationInputHash } from "../src/lib/jobs/runner";
import { snapshotFilmVersion } from "../src/lib/film/versions";

const DRAFT_SCALE = 0.5;
const BuildLooseSchema = z.object({ composition: z.string().min(1), entry: z.string().optional() }).loose();

const SPECS = [
  { name: "composition", required: true, description: "Composition ID" },
  { name: "entry", default: DEFAULT_ENTRY, description: "Remotion entry point" },
  { name: "audio", description: "Audio master, muxed without re-encoding the picture" },
  {
    name: "decision",
    description: "MusicDecision JSON; with no --audio it must state silence or delivery on the platform",
  },
  {
    name: "embedded-audio",
    type: "boolean",
    description: "The composition carries its own soundtrack; the render is refused afterwards if it does not",
  },
  { name: "draft", type: "boolean", description: "Half resolution, for speed" },
  { name: "project", description: "Project ID: supplies default paths under out/<project>/ and pipeline/" },
  { name: "output", description: "Output MP4; default out/<project>/film.mp4" },
  { name: "targets", description: "FilmTargets JSON" },
  { name: "audio-map", description: "AudioMap JSON" },
  { name: "cue-sheet", description: "CueSheet JSON" },
  { name: "sound-cues", description: "sfx:cues output for measured cue leads; default pipeline/sound-cues.json" },
  {
    name: "receipt",
    description:
      "film:render's own receipt JSON; default pipeline/film-render.json, or <output>.film-render.json. A bespoke project's full render to out/<project>/film.mp4 also gets delivery's <output>.receipt.json",
  },
  { name: "measure", description: "FilmMeasure JSON; default pipeline/film-measure.json, or <output>.measure.json" },
  { name: "codec", choices: CODEC_CHOICES, default: "h264", description: "Video codec" },
  { name: "crf", type: "number", description: "Constant rate factor" },
  { name: "props", description: "JSON file with input props" },
  { name: "public-dir", default: "public", description: "Public directory served to the composition" },
  { name: "gl", choices: GL_CHOICES, default: "angle", description: "Chromium GL backend" },
] as const;

function mux(picture: string, audio: string, output: string, durationSec: number) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      picture,
      "-i",
      audio,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-t",
      durationSec.toFixed(6),
      "-movflags",
      "+faststart",
      output,
    ],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not mux the audio master: ${result.error?.message ?? result.stderr.slice(-400)}`,
    });
}

void runScript(async () => {
  const startedAt = Date.now();
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  if (args.project) requireProject(args.project);
  const outputArg = args.output ?? (args.project ? path.join("out", args.project, "film.mp4") : undefined);
  if (!outputArg) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --output or --project." });
  const output = path.resolve(outputArg);
  if (args.audio && args["embedded-audio"])
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--audio replaces the composition's soundtrack; --embedded-audio keeps it. Pass one.",
    });

  const defaultDecision = args.project ? projectPipeline(args.project, "music-decision.json") : undefined;
  const decisionPath = args.decision ?? (defaultDecision && existsSync(defaultDecision) ? defaultDecision : undefined);
  const decision = decisionPath ? readJsonFile(decisionPath, MusicDecisionSchema, "Music decision") : undefined;
  const silenceDecided =
    decision !== undefined &&
    (decision.route === "silence" || decision.delivery === "none" || decision.delivery === "native-on-platform");
  if (!args.audio && !args["embedded-audio"] && !silenceDecided)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `film:render refuses a film with no sound. Pass --audio with the master${decision ? "" : ", or --decision with a music-decision.json stating silence"}.${decision ? ` The decision at ${decisionPath} says route ${decision.route}, delivery ${decision.delivery}, which is not silence.` : ""}`,
    });
  if (args.audio && !existsSync(args.audio))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Audio master not found: ${args.audio}` });

  // Delivery's receipt binds this output to the film's inputs: only a full render of the build's own composition, without other props.
  const deliveryProject = args.project && isBespokeDelivery(process.cwd(), args.project) ? args.project : undefined;
  const build = deliveryProject
    ? (readJsonFile(projectPipeline(deliveryProject, "build.json"), BuildLooseSchema, "Build record") as {
        composition: string;
        entry?: string;
        props?: string;
      })
    : undefined;
  const deliveryBlock = !deliveryProject
    ? undefined
    : args.draft
      ? "a draft is never delivered"
      : args.props
        ? "--props renders other props than the film's own"
        : build!.composition !== args.composition ||
            path.resolve(build!.entry ?? DEFAULT_ENTRY) !== path.resolve(args.entry!)
          ? `build.json names ${build!.composition} (${build!.entry ?? DEFAULT_ENTRY}), not ${args.composition} (${args.entry})`
          : path.resolve(output) !== bespokeOutput(process.cwd(), deliveryProject)
            ? `delivery reads out/${deliveryProject}/film.mp4, not ${path.relative(process.cwd(), output)}`
            : undefined;
  const audioMaster = args.audio ? path.relative(process.cwd(), path.resolve(args.audio)) : undefined;
  const identityBefore =
    deliveryProject && !deliveryBlock
      ? captureBespokeIdentity(deliveryProject, bespokeFormat(process.cwd(), deliveryProject) ?? "landscape", {
          audioMaster,
        })
      : undefined;

  const picture = args.audio ? `${output}.picture${path.extname(output)}` : output;
  emitProgress(`Rendering ${args.composition}${args.draft ? " at half resolution" : ""}`);
  const composition = await renderClip(
    {
      entry: args.entry!,
      composition: args.composition!,
      publicDir: args["public-dir"]!,
      gl: args.gl!,
      propsFile: args.props ?? (build?.props ? path.resolve("public", build.props) : undefined),
    },
    {
      output: picture,
      codec: args.codec!,
      crf: args.crf,
      ...(args.draft ? { scale: DRAFT_SCALE } : {}),
      ...(args.audio ? { muted: true } : {}),
    },
  );
  const warnings: string[] = [];
  if (args.audio) {
    const pictureInfo = probeVideo(picture);
    const audioDuration = Number(
      spawnSync(
        "ffprobe",
        ["-v", "error", "-select_streams", "a:0", "-show_entries", "format=duration", "-of", "csv=p=0", args.audio],
        { encoding: "utf8" },
      ).stdout.trim(),
    );
    if (Number.isFinite(audioDuration) && audioDuration < pictureInfo.durationSec - 0.1)
      warnings.push(
        `The audio master is ${audioDuration.toFixed(2)} s and the picture ${pictureInfo.durationSec.toFixed(2)} s, so the ending plays without sound.`,
      );
    emitProgress("Muxing the audio master, keeping the picture as rendered");
    mux(picture, args.audio, output, pictureInfo.durationSec);
    rmSync(picture, { force: true });
  }
  const info = probeVideo(output);
  if (args["embedded-audio"] && !info.hasAudio)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `--embedded-audio was given, but ${output} has no audio stream. Add the soundtrack to the composition, or pass --audio.`,
    });

  const scale = args.draft ? DRAFT_SCALE : 1;
  const summary = probeRender(output);
  const fileIssues = checkRender(output, summary, {
    codec: args.codec === "h265" ? "hevc" : args.codec!,
    width: Math.round(composition.width * scale),
    height: Math.round(composition.height * scale),
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
    lastFrame: composition.durationInFrames - 1,
  }).map(({ code, message, fix }) => ({ code, message, fix }));

  const inputs = readFilmInputs({
    project: args.project,
    targets: args.targets,
    audioMap: args["audio-map"],
    cueSheet: args["cue-sheet"],
    soundCues: args["sound-cues"],
    decision: decisionPath,
  });
  const evidence = gatherEvidence(output);
  const measure = measureRender(output, { evidence, ...inputs });
  for (const leg of measure.legs) emitProgress(`${leg.status.padEnd(7)} ${leg.id}: ${leg.message}`);
  const measurePath = writeJsonAtomic(
    args.measure ?? (args.project ? projectPipeline(args.project, "film-measure.json") : `${output}.measure.json`),
    measure,
  );
  // The next render replaces film.mp4; keep this one, passing or not, with its own measure verdict.
  let version: { file: string; sha256: string } | undefined;
  if (args.project && output === path.resolve("out", args.project, "film.mp4")) {
    try {
      const kept = snapshotFilmVersion(
        { id: args.project, rootDir: process.cwd(), projectDir: path.resolve("public/projects", args.project) },
        output,
        {
          step: "render",
          sha256: evidence.sha256,
          composition: args.composition,
          draft: Boolean(args.draft),
          measure: {
            verdict: measure.verdict,
            path: path.relative(process.cwd(), measurePath),
            failing: measure.legs.filter((leg) => leg.status === "fail").map((leg) => leg.id),
          },
        },
      );
      version = { file: kept.file, sha256: kept.sha256 };
    } catch (error) {
      warnings.push(
        `This render was not kept under out/${args.project}/versions/: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let deliveryReceipt: string | undefined;
  if (identityBefore) {
    const after = captureBespokeIdentity(
      deliveryProject!,
      bespokeFormat(process.cwd(), deliveryProject!) ?? formatOfSize(composition.width, composition.height),
      { audioMaster },
    );
    const same = (identity: typeof after) =>
      generationInputHash({
        sources: identity.sources,
        propsHash: identity.propsHash,
        durationInFrames: identity.durationInFrames,
      });
    if (same(identityBefore) !== same(after))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "The film's inputs changed while it rendered; render it again before delivery.",
      });
    deliveryReceipt = publishRenderReceipt(output, after, after);
  } else if (deliveryBlock) warnings.push(`No delivery receipt: ${deliveryBlock}.`);

  const receiptPath =
    args.receipt ?? (args.project ? projectPipeline(args.project, "film-render.json") : `${output}.film-render.json`);
  const receipt = {
    schemaVersion: 1,
    output,
    renderSha256: evidence.sha256,
    composition: args.composition,
    entry: args.entry,
    draft: Boolean(args.draft),
    durationInFrames: composition.durationInFrames,
    summary,
    fileIssues,
    audio: args.audio
      ? { path: path.resolve(args.audio), sha256: hashFileSync(args.audio) }
      : args["embedded-audio"]
        ? { embedded: true }
        : { silence: decisionPath },
    measure: {
      path: measurePath,
      verdict: measure.verdict,
      failing: measure.legs.filter((leg) => leg.status === "fail").map((leg) => leg.id),
    },
    warnings,
    ...(deliveryReceipt ? { deliveryReceipt } : {}),
    ...(version ? { version } : {}),
    renderedAt: new Date().toISOString(),
  };
  const receiptFile = writeJsonAtomic(receiptPath, receipt);
  const outputs = [output, measurePath, receiptFile, ...(deliveryReceipt ? [deliveryReceipt] : [])];
  const metadata = {
    ...receipt,
    receipt: receiptFile,
    legs: measure.legs,
    frozenSpans: measure.frozenSpans,
    apiCalls: 0,
  };
  if (measure.verdict === "pass" && !fileIssues.length) return { outputs, metadata };
  return emitResult({
    ok: false,
    error: "VALIDATION",
    message: `The film rendered but does not pass: ${[...receipt.measure.failing, ...fileIssues.map((issue) => issue.code)].join(", ")}. It is at ${output}. Read metadata.legs[].fix.`,
    outputs,
    metadata,
    elapsedMs: Date.now() - startedAt,
  });
});
