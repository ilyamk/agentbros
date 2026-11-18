import { CliErrorObject, ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { DEFAULT_CALIBRATION_DIR, degradeReference, parseKinds } from "../src/lib/reference/degrade";
import { DEFAULT_LIBRARY_ROOT } from "../src/lib/reference/library";
import { DEGRADE_KINDS } from "../src/types/calibration";

const SPECS = [
  { name: "id", required: true, description: "Reference id in the library" },
  { name: "library-root", default: DEFAULT_LIBRARY_ROOT, description: "Reference library directory" },
  { name: "start-sec", type: "number", description: "Segment start in the reference's time (2-4 s with --end-sec)" },
  { name: "end-sec", type: "number", description: "Segment end" },
  {
    name: "auto",
    type: "number",
    description: "Pick this many segments: windows with cuts and motion first, never overlapping",
  },
  { name: "segment-sec", type: "number", default: 3, description: "Length of an --auto segment, 2-4 s" },
  { name: "kinds", description: `Comma-separated degradations; default all: ${DEGRADE_KINDS.join(", ")}` },
  {
    name: "audio-map",
    description: "AudioMap JSON of the reference's track, for the beat grid; else audio.json's tempo",
  },
  {
    name: "out-dir",
    description: `Output directory; defaults to ${DEFAULT_CALIBRATION_DIR}/<id>/, one sub-directory per segment`,
  },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  const explicit = args["start-sec"] !== undefined || args["end-sec"] !== undefined;
  if (explicit && (args["start-sec"] === undefined || args["end-sec"] === undefined))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass both --start-sec and --end-sec, or --auto N." });
  if (explicit && args.auto !== undefined)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --start-sec/--end-sec or --auto, not both." });
  if (args.auto !== undefined && (!Number.isInteger(args.auto) || args.auto < 1))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--auto is a positive whole number of segments." });
  const segments = explicit ? [{ startSec: args["start-sec"]!, endSec: args["end-sec"]! }] : undefined;
  if (
    segments &&
    (segments[0]!.endSec - segments[0]!.startSec < 2 - 1e-6 || segments[0]!.endSec - segments[0]!.startSec > 4 + 1e-6)
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "A segment is 2-4 s long." });
  const result = degradeReference({
    libraryRoot: args["library-root"]!,
    id: args.id!,
    segments,
    auto: args.auto ?? (segments ? undefined : 1),
    segmentSec: args["segment-sec"],
    kinds: parseKinds(args.kinds),
    outDir: args["out-dir"],
    audioMap: args["audio-map"],
  });
  return { outputs: result.manifests, metadata: { referenceId: args.id, segments: result.segments, apiCalls: 0 } };
});
