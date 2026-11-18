import { readFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { writeJsonAtomic } from "../src/lib/film/evidence";
import {
  calibrationReport,
  criticAccuracy,
  criticKeyPath,
  findManifests,
  mergeCriticResults,
  MIN_ACCURACY,
  MIN_PAIRS,
  readPairs,
  selectSensors,
  writeCriticPackets,
} from "../src/lib/reference/calibrate";
import { DEFAULT_CALIBRATION_DIR } from "../src/lib/reference/degrade";
import { CriticKeySchema, CriticResultsSchema } from "../src/types/calibration";

const SPECS = [
  { name: "manifest", description: "Comma-separated manifest.json files from ref:degrade" },
  {
    name: "dir",
    description: `Directory searched for manifest.json files; default ${DEFAULT_CALIBRATION_DIR} when no --manifest`,
  },
  {
    name: "sensors",
    description: "Comma-separated sensors or groups (film:measure, sync, candidate); all (default) or none",
  },
  {
    name: "critic-pack",
    type: "boolean",
    description:
      "Write blind pair packets for a creative-critic (pairs.json, strips, A/B clips) and the answer key outside them",
  },
  { name: "critic-dir", description: `The critic's folder: packets only; default ${DEFAULT_CALIBRATION_DIR}/critic` },
  { name: "critic-key", description: "Answer key, outside the critic's folder; default critic-key.json beside it" },
  {
    name: "batches",
    type: "number",
    description:
      "With --critic-pack: N batches (batch-<k>.json and batch-<k>/), one fresh critic each; no original twice in a batch, the two orders of a pair in different batches. At least twice the most pairs one original has",
  },
  {
    name: "critic-results",
    description:
      "Comma-separated JSON arrays of {pairId, order, winner: A|B|tie, reason}: one from pairs.json, or one per batch",
  },
  { name: "seed", default: "calibration-v1", description: "Seed of the blind pair ids and A/B order" },
  { name: "output", description: `Report path; default ${DEFAULT_CALIBRATION_DIR}/report.json` },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  const manifests = findManifests({
    manifests: args.manifest
      ?.split(",")
      .map((file) => file.trim())
      .filter(Boolean),
    dir: args.manifest ? args.dir : (args.dir ?? DEFAULT_CALIBRATION_DIR),
  });
  if (!manifests.length)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "No calibration manifests found. Run ref:degrade first, or pass --manifest.",
    });
  const sensors = selectSensors(args.sensors);
  const criticDir = args["critic-dir"] ?? path.join(DEFAULT_CALIBRATION_DIR, "critic");
  const keyPath = args["critic-key"] ?? criticKeyPath(criticDir);
  const outputs: string[] = [];
  let packets: ReturnType<typeof writeCriticPackets> | undefined;
  if (sensors.length || args["critic-results"]) ensureFfprobe();
  if (args.batches !== undefined && !args["critic-pack"])
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--batches goes with --critic-pack." });
  if (args["critic-pack"]) {
    ensureFfmpeg();
    ensureFfprobe();
    packets = writeCriticPackets(manifests, criticDir, args.seed!, {
      keyFile: keyPath,
      ...(args.batches !== undefined ? { batches: args.batches } : {}),
    });
    outputs.push(...(packets.batches ?? [packets.pairs]), packets.key);
  }
  if (!sensors.length && !args["critic-results"]) {
    if (!packets)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Nothing to do: --sensors none without --critic-pack or --critic-results.",
      });
    const note = packets.batches
      ? "Give each batch-<k>.json, with its batch-<k>/ folder only, to its own fresh critic, confined there; never one critic two batches. The answer key is outside."
      : "Give the critic the folder of pairs.json only, and confine it there; the answer key is outside it.";
    return {
      outputs,
      metadata: {
        manifests: manifests.length,
        questions: packets.questions,
        ...(packets.batches ? { batches: packets.batches.length } : {}),
        note,
        apiCalls: 0,
      },
    };
  }
  if (sensors.length) ensureFfmpeg();
  const pairs = sensors.length ? readPairs(manifests, sensors) : [];
  let critic: ReturnType<typeof criticAccuracy> | undefined;
  if (args["critic-results"]) {
    const key = CriticKeySchema.parse(JSON.parse(readFileSync(keyPath, "utf8")));
    const files = args["critic-results"]
      .split(",")
      .map((file) => file.trim())
      .filter(Boolean)
      .map((file) => ({ file, judgements: CriticResultsSchema.parse(JSON.parse(readFileSync(file, "utf8"))) }));
    critic = criticAccuracy(key, mergeCriticResults(key, files));
  }
  const report = calibrationReport({
    manifests: manifests.map((file) => path.relative(process.cwd(), file).split(path.sep).join("/")),
    sensors,
    pairs,
    ...(critic ? { critic: critic.critic, criticFailures: critic.failures } : {}),
  });
  outputs.push(writeJsonAtomic(args.output ?? path.join(DEFAULT_CALIBRATION_DIR, "report.json"), report));
  return {
    outputs,
    metadata: {
      manifests: manifests.length,
      pairs: pairs.length,
      rule: `eligible at accuracy >= ${MIN_ACCURACY} on >= ${MIN_PAIRS} pairs`,
      eligibleGates: report.eligibleGates,
      byKind: report.byKind,
      ...(critic
        ? { critic: { accuracy: critic.critic.accuracy, agreed: critic.critic.agreed, pairs: critic.critic.pairs } }
        : {}),
      failures: report.failures.length,
      apiCalls: 0,
    },
  };
});
