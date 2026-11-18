/** Durable project-local SFX and foley takes. Reinvoke identical arguments to resume. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, runScript } from "../src/lib/cli";
import { PAID_CLI_SPECS } from "../src/lib/jobs/execution";
import { runSfxGeneration } from "../src/lib/providers/fal-sfx";
export { runSfxGeneration, type SfxGenerationOptions } from "../src/lib/providers/fal-sfx";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runScript(async () => {
    const args = parseArgs([
      { name: "project", required: true, description: "Project for the take, provenance and durable budget" },
      { name: "endpoint", required: true, description: "Active verified SFX/foley endpoint ID (music is separate)" },
      { name: "prompt", description: "Sound description; optional guidance with --video" },
      { name: "video", description: "Local foley reference video (up to 8 MiB)" },
      { name: "duration", type: "number", description: "Requested sound duration in seconds" },
      { name: "output", required: true, description: "Project-local audio output path" },
      ...PAID_CLI_SPECS,
    ] as const);
    return runSfxGeneration({
      projectId: args.project!,
      endpoint: args.endpoint!,
      prompt: args.prompt,
      video: args.video,
      durationSec: args.duration,
      output: args.output!,
      dryRun: args["dry-run"],
      maxCostUsd: args["max-cost-usd"],
      operationId: args["operation-id"],
    });
  });
