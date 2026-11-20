import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { DECODE_SPECS, decodeRequest, frameCount, parseCrop } from "../src/lib/colour/args";
import { runColourWorker } from "../src/lib/colour/worker";
import { CompareResultSchema } from "../src/types/colour";

const SPECS = [
  { name: "input", required: true, description: "The clip being judged (for example a generated video)" },
  { name: "reference", required: true, description: "The clip or still it should look like" },
  { name: "output", required: true, description: "Directory for compare.png and comparison.json" },
  { name: "frames", type: "number", default: 8, description: "Frames per clip, sampled at the same relative times" },
  { name: "at", type: "number", description: "Compare one frame at this input time (the reference at the same relative time)" },
  { name: "paired", type: "boolean", description: "Force per-pixel CIEDE2000 even when the frames do not look aligned" },
  { name: "reference-crop", default: "auto", description: "Active picture of the reference: auto, none or x,y,w,h" },
  ...DECODE_SPECS,
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  requireFile(args.input!);
  requireFile(args.reference!);
  ensureFfmpeg();
  const output = path.resolve(args.output!);
  mkdirSync(output, { recursive: true });
  const result = runColourWorker(
    "compare",
    {
      input: path.resolve(args.input!),
      reference: path.resolve(args.reference!),
      output,
      ...(args.at !== undefined ? { at: args.at } : { frames: frameCount(args.frames, 8) }),
      paired: Boolean(args.paired),
      referenceCrop: parseCrop(args["reference-crop"], "reference-crop"),
      ...decodeRequest(args),
    },
    CompareResultSchema,
  );
  const file = path.join(output, "comparison.json");
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return {
    outputs: [result.files.sheet!, file],
    metadata: {
      sheet: result.files.sheet,
      summary: result.summary,
      findings: result.findings,
      zones: result.zones,
      globalDeltaE2000: result.globalDeltaE2000,
      paired: result.paired,
      assumptions: { input: result.input.assumptions, reference: result.reference.assumptions },
      apiCalls: 0,
    },
  };
});
