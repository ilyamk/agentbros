/**
 * The film chain's narration step: measure every spoken beat's take (ffprobe), check its receipt and word timings,
 * write the edited caption words the build mounts and pipeline/narration.json. Spends nothing.
 *
 *   pnpm narration:check --project <id>
 *   pnpm narration:check --project <id> --local-result public/projects/<id>/pipeline/narration-local.json
 *
 * Guide: docs/production-chain/narration.md.
 */
import { CliErrorObject, ensureFfprobe, parseArgs, requireProject, runScript } from "../src/lib/cli";
import { inspectAsset } from "../src/lib/assets/inspect";
import { measureNarration } from "../src/lib/film/narration";

const SPECS = [
  { name: "project", short: "p", required: true, description: "Project ID" },
  {
    name: "local-result",
    description: "The voiceover:local result JSON (route local); default pipeline/narration-local.json",
  },
  { name: "dry-run", type: "boolean", description: "Check and measure without writing captions or narration.json" },
] as const;

runScript(async () => {
  const args = parseArgs(SPECS);
  const projectId = args.project!;
  requireProject(projectId);
  ensureFfprobe();
  const { narration, problems } = measureNarration({
    root: process.cwd(),
    projectId,
    localResult: args["local-result"],
    measure: (file) => inspectAsset(file).media?.durationSec ?? 0,
    write: !args["dry-run"],
  });
  if (!narration)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Narration is not ready: ${problems.length} problem(s)`,
      details: { problems },
    });
  return {
    outputs: args["dry-run"]
      ? []
      : [`public/projects/${projectId}/pipeline/narration.json`, ...narration.beats.map((beat) => beat.captions)],
    metadata: {
      route: narration.route,
      beats: narration.beats.length,
      totalSec: narration.totalSec,
      durations: Object.fromEntries(narration.beats.map((beat) => [beat.beatId, beat.durationSec])),
      dryRun: Boolean(args["dry-run"]),
    },
  };
});
