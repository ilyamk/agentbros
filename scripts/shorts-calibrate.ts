/**
 * Picks the shorts score threshold from human 1–5 ratings: the lowest score at which at least 70% of rated clips at or
 * above it were approved (rating 4 or 5). Stored per project in pipeline/shorts-calibration.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, parseArgs, relativisePath, runScript } from "../src/lib/cli";
import { ShortsProposalsSchema } from "../src/types/shorts";
import { calibrateThreshold } from "../src/lib/shorts/calibrate";
import { calibrationFile, readJson, validation } from "../src/lib/shorts/cli";
import { sha256 } from "../src/lib/shorts/prepare";

void runScript(async () => {
  const args = parseArgs([
    { name: "proposals", required: true, description: "proposals.json from shorts:rank (scores of every rated clip)" },
    {
      name: "ratings",
      required: true,
      description: 'Human ratings JSON: { "version": 1, "ratings": [{ "id": "c1", "rating": 4 }] }',
    },
    { name: "project", description: "Store the calibration in this project's pipeline/shorts-calibration.json" },
    { name: "output", description: "Calibration JSON path when no --project is given" },
    { name: "min-clips", type: "number", default: 10, description: "Fewest rated clips accepted" },
    {
      name: "min-above",
      type: "number",
      default: 3,
      description: "Fewest rated clips at or above the chosen threshold",
    },
  ] as const);
  if (!args.project && !args.output)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Pass --project or --output" });
  const proposals = readJson(args.proposals!),
    ratings = readJson(args.ratings!);
  const parsed = validation(() => ShortsProposalsSchema.parse(proposals.value));
  const calibration = validation(() =>
    calibrateThreshold(parsed, ratings.value, {
      minClips: args["min-clips"] as number,
      minAbove: args["min-above"] as number,
      ratingsSha256: sha256(ratings.raw),
      proposalsSha256: sha256(proposals.raw),
    }),
  );
  const output = path.resolve(args.project ? calibrationFile(args.project) : args.output!);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(calibration, null, 2)}\n`);
  return {
    outputs: [relativisePath(output)],
    metadata: {
      threshold: calibration.threshold,
      precision: calibration.precision,
      clipsAbove: calibration.clipsAbove,
      rated: calibration.rated,
    },
  };
});
