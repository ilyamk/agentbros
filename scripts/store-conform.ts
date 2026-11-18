import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  CliErrorObject,
  emitProgress,
  emitResult,
  ensureFfmpeg,
  ensureFfprobe,
  parseArgs,
  runScript,
} from "../src/lib/cli";
import {
  APPLE_CLASSES,
  conformArgs,
  factsFromProbe,
  inputBlockers,
  PROBE_ARGS,
  specFor,
  STORES,
  verifyPreview,
  type Store,
} from "../src/lib/store/preview";

const SPECS = [
  { name: "input", required: true, description: "Rendered film (MP4 or MOV)" },
  {
    name: "store",
    choices: STORES,
    required: true,
    description: "apple (App Store Connect upload) or google (the YouTube master Play links to)",
  },
  { name: "class", description: `Apple device class: ${APPLE_CLASSES.join(", ")}; not used with google` },
  { name: "output", description: "Conformed MP4; omit to only check --input" },
  {
    name: "reencode-video",
    type: "boolean",
    description:
      "Re-encode the picture to H.264 High 4.0 at 11 Mbps even when it could be copied (same size, never rescaled)",
  },
] as const;

function probe(file: string) {
  const result = spawnSync("ffprobe", [...PROBE_ARGS, file], { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `ffprobe could not read ${file}: ${result.error?.message ?? result.stderr.slice(-400)}`,
    });
  try {
    return factsFromProbe(JSON.parse(result.stdout));
  } catch (error) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${file}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

void runScript(async () => {
  const startedAt = Date.now();
  const args = parseArgs(SPECS);
  let spec;
  try {
    spec = specFor(args.store as Store, args.class);
  } catch (error) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const input = path.resolve(args.input!);
  if (!existsSync(input) || !statSync(input).isFile())
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Input not found: ${input}` });
  ensureFfmpeg();
  ensureFfprobe();
  const before = probe(input);
  const target = { store: args.store, class: args.class ?? null, label: spec.label };

  if (!args.output) {
    const findings = verifyPreview(before, spec);
    const errors = findings.filter((finding) => finding.severity === "error");
    const metadata = { ...target, checkOnly: true, file: input, facts: before, findings, apiCalls: 0 };
    if (!errors.length) return { outputs: [], metadata };
    return emitResult({
      ok: false,
      error: "VALIDATION",
      message: `${input} does not meet ${spec.label}: ${errors.map((finding) => finding.code).join(", ")}. Read metadata.findings[].fix, or conform it with --output.`,
      metadata,
      elapsedMs: Date.now() - startedAt,
    });
  }

  const output = path.resolve(args.output);
  if (output === input)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--output must differ from --input." });
  if (path.extname(output).toLowerCase() !== ".mp4")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--output must be an .mp4 file." });
  const blockers = inputBlockers(before, spec).filter((finding) => finding.severity === "error");
  if (blockers.length)
    return emitResult({
      ok: false,
      error: "VALIDATION",
      message:
        `${input} cannot be conformed for ${spec.label}: ${blockers.map((finding) => finding.message).join(" ")} ${blockers[0]!.fix ?? ""}`.trim(),
      metadata: { ...target, facts: before, findings: blockers, apiCalls: 0 },
      elapsedMs: Date.now() - startedAt,
    });

  const plan = conformArgs(input, output, before, spec, Boolean(args["reencode-video"]));
  emitProgress(
    plan.reencodeReasons.length
      ? `Re-encoding the picture at the same size: ${plan.reencodeReasons.join("; ")}`
      : "Copying the picture untouched",
  );
  emitProgress(
    plan.addedSilence
      ? "No audio track: adding a silent stereo AAC track"
      : "Re-encoding the audio to AAC 256 kbps stereo 48 kHz",
  );
  mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync("ffmpeg", plan.args, { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg could not conform ${input}: ${result.error?.message ?? result.stderr.slice(-400)}`,
    });

  const after = probe(output);
  const findings = verifyPreview(after, spec);
  const errors = findings.filter((finding) => finding.severity === "error");
  const metadata = {
    ...target,
    input,
    output,
    pictureCopied: plan.reencodeReasons.length === 0,
    reencodeReasons: plan.reencodeReasons,
    addedSilence: plan.addedSilence,
    facts: after,
    findings,
    apiCalls: 0,
  };
  if (!errors.length) return { outputs: [output], metadata };
  return emitResult({
    ok: false,
    error: "VALIDATION",
    message: `Conformed to ${output}, but it does not meet ${spec.label}: ${errors.map((finding) => finding.code).join(", ")}. Read metadata.findings.`,
    metadata: { ...metadata, outputs: [output] },
    elapsedMs: Date.now() - startedAt,
  });
});
