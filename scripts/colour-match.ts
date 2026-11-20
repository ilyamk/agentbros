import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { DECODE_SPECS, decodeRequest, frameCount, parseCrop } from "../src/lib/colour/args";
import { runColourWorker } from "../src/lib/colour/worker";
import { GradeSchema, MatchResultSchema } from "../src/types/colour";

const SPECS = [
  { name: "input", required: true, description: "The clip to grade" },
  { name: "reference", required: true, description: "The clip or still to match" },
  { name: "output", required: true, description: "Where to write the editable grade.json" },
  { name: "method", choices: ["stats", "paired"], default: "stats", description: "stats: Lab statistics per zone (any content); paired: per-pixel fit (same shot, aligned frames)" },
  { name: "strength", type: "number", default: 1, description: "Blend the solved grade toward identity, 0..1" },
  { name: "frames", type: "number", default: 8, description: "Frames per clip used for the fit" },
  { name: "reference-crop", default: "auto", description: "Active picture of the reference: auto, none or x,y,w,h" },
  { name: "force", type: "boolean", description: "Overwrite an existing grade file" },
  ...DECODE_SPECS,
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  requireFile(args.input!);
  requireFile(args.reference!);
  ensureFfmpeg();
  const output = path.resolve(args.output!);
  if (existsSync(output) && !args.force)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `${args.output} exists; pass --force to overwrite it or choose another path` });
  const strength = args.strength ?? 1;
  if (!(strength >= 0 && strength <= 1)) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--strength must be between 0 and 1" });
  const frames = frameCount(args.frames, 8);
  const evidence = output.replace(/\.json$/i, "") + "-match";
  mkdirSync(evidence, { recursive: true });
  const result = runColourWorker(
    "match",
    {
      input: path.resolve(args.input!),
      reference: path.resolve(args.reference!),
      output: evidence,
      method: args.method,
      strength,
      frames,
      referenceCrop: parseCrop(args["reference-crop"], "reference-crop"),
      ...decodeRequest(args),
    },
    MatchResultSchema,
  );
  const grade = GradeSchema.parse({
    version: 1,
    name: `match ${path.basename(args.input!)} to ${path.basename(args.reference!)}`,
    notes: "Solved by colour:match. Edit any value; colour:grade re-bakes the LUT from this file.",
    matchedTo: { reference: path.basename(args.reference!), method: result.method, frames, strength },
    ...result.grade,
  });
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(grade, null, 2)}\n`);
  const report = path.join(evidence, "match.json");
  writeFileSync(report, `${JSON.stringify({ metrics: result.metrics, input: result.input, reference: result.reference, grade }, null, 2)}\n`);
  return {
    outputs: [output, result.files.preview!, report],
    metadata: {
      grade,
      method: result.method,
      zoneDeltaE2000: { before: result.metrics.zoneDeltaE2000Before, after: result.metrics.zoneDeltaE2000After },
      preview: result.files.preview,
      note: "Metrics are on sampled frames; render with colour:grade and re-measure with colour:compare for evidence.",
      apiCalls: 0,
    },
  };
});
