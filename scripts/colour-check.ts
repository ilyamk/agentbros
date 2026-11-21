import { readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { DECODE_SPECS, decodeRequest, frameCount, parseCrop, parseRegion } from "../src/lib/colour/args";
import { runColourWorker } from "../src/lib/colour/worker";
import { CheckResultSchema, ColourTargetSchema } from "../src/types/colour";

const SPECS = [
  { name: "input", required: true, description: "The graded file to validate" },
  {
    name: "source",
    description: "The ungraded file it was rendered from (same size and timing): skin is keyed here; runs the gate",
  },
  { name: "target", description: "target.json from colour:target: check every shot against its profile" },
  { name: "reference", description: "Also test how close the grade came to this clip or still" },
  { name: "output", required: true, description: "Directory for check.png and check.json" },
  { name: "frames", type: "number", default: 6, description: "Frames sampled across the clip" },
  { name: "at", type: "number", description: "Check one frame at this time in seconds" },
  { name: "skin-region", description: "Skin to protect as x,y,w,h in source pixels (default: the skin chroma rule)" },
  { name: "reference-skin-region", description: "Skin in the reference as x,y,w,h (default: the skin chroma rule)" },
  { name: "reference-crop", default: "auto", description: "Active picture of the reference: auto, none or x,y,w,h" },
  {
    name: "skin-chroma",
    type: "number",
    description: "Expected skin chroma ratio (a look's policy, e.g. 0.75 for a muted look; default 1)",
  },
  { name: "hue-allowance", type: "number", description: "Skin hue change allowed in degrees (default 6)" },
  { name: "strict", type: "boolean", description: "Exit with VALIDATION when the gate fails" },
  ...DECODE_SPECS,
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  requireFile(args.input!);
  if (!args.source && !args.target)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --source (the gate), --target, or both" });
  if (args.source) requireFile(args.source);
  if (args.target) requireFile(args.target);
  if (args.reference && !args.source)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--reference needs --source" });
  const target = args.target ? ColourTargetSchema.parse(JSON.parse(readFileSync(args.target, "utf8"))) : undefined;
  if (args.reference) requireFile(args.reference);
  ensureFfmpeg();
  const policy =
    args["skin-chroma"] !== undefined || args["hue-allowance"] !== undefined
      ? { chroma: args["skin-chroma"] ?? 1, hueAllowance: args["hue-allowance"] ?? 6 }
      : undefined;
  const result = runColourWorker(
    "check",
    {
      input: path.resolve(args.input!),
      ...(args.source ? { source: path.resolve(args.source) } : {}),
      ...(target ? { target } : {}),
      ...(args.reference ? { reference: path.resolve(args.reference) } : {}),
      output: path.resolve(args.output!),
      frames: frameCount(args.frames, 6),
      ...(args.at !== undefined ? { at: args.at } : {}),
      skinRegion: parseRegion(args["skin-region"], "skin-region"),
      referenceSkinRegion: parseRegion(args["reference-skin-region"], "reference-skin-region"),
      referenceCrop: parseCrop(args["reference-crop"], "reference-crop"),
      ...(policy ? { policy } : {}),
      ...decodeRequest(args),
    },
    CheckResultSchema,
  );
  if (args.strict && result.status === "fail")
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `colour gate failed: ${result.failed.join("; ")}`,
      details: { sheet: result.files.sheet },
    });
  return {
    outputs: Object.values(result.files),
    metadata: {
      status: result.status,
      failed: result.failed,
      warnings: result.warnings,
      checks: result.checks,
      sheet: result.files.sheet,
      ...(result.shots ? { shots: result.shots } : {}),
      apiCalls: 0,
    },
  };
});
