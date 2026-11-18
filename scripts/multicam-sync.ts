import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, parseArgs, requireFile, runScript } from "../src/lib/cli";
import { takeList } from "../src/lib/multicam/args";
import { DEFAULT_THRESHOLDS, syncSources } from "../src/lib/multicam/sync";

const SPECS = [
  {
    name: "inputs",
    description:
      "Two or more recordings (video or audio), space separated; the first is the reference unless --reference says otherwise",
  },
  { name: "output", required: true, description: "Where to write sync.json" },
  { name: "ids", description: "Comma-separated source ids, one per input (default: file names)" },
  { name: "reference", type: "number", default: 0, description: "Index of the reference input" },
  {
    name: "min-score",
    type: "number",
    default: DEFAULT_THRESHOLDS.minStandardScore,
    description: "Minimum audio-offset-finder standard score",
  },
  {
    name: "min-peak-ratio",
    type: "number",
    default: DEFAULT_THRESHOLDS.minPeakRatio,
    description: "Minimum GCC-PHAT peak to next-peak ratio",
  },
  {
    name: "drift-tolerance-ms",
    type: "number",
    default: DEFAULT_THRESHOLDS.driftToleranceMs,
    description: "Accumulated drift over the take above which resampling is recommended",
  },
] as const;

void runScript(async () => {
  const argv = process.argv.slice(2);
  const { values: listed, rest } = takeList(argv[0] === "--" ? argv.slice(1) : argv, "inputs");
  const inputs = listed?.length === 1 ? listed[0]!.split(",") : listed;
  const args = parseArgs(SPECS, rest);
  if (!inputs || inputs.length < 2)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--inputs needs at least two files" });
  inputs.forEach(requireFile);
  ensureFfmpeg();
  const sync = syncSources(inputs, {
    ids: args.ids?.split(",").map((id) => id.trim()),
    reference: args.reference,
    thresholds: {
      minStandardScore: args["min-score"],
      minPeakRatio: args["min-peak-ratio"],
      driftToleranceMs: args["drift-tolerance-ms"],
    },
  });
  const output = path.resolve(args.output!);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(sync, null, 2)}\n`);
  return {
    outputs: [args.output!],
    metadata: {
      referenceId: sync.referenceId,
      sources: sync.sources.map((source) => ({
        id: source.id,
        offsetSec: source.offsetSec,
        videoOffsetSec: source.videoOffsetSec,
        driftPpm: source.drift.ppm,
        needsResample: source.drift.needsResample,
        confidence: source.confidence,
      })),
      apiCalls: 0,
    },
  };
});
