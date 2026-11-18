import { parseArgs, runScript } from "../src/lib/cli";
import { readStudioRequest } from "../src/lib/elevenlabs/files";
import { conformDubbingAudio, DubbingConformRequestSchema } from "../src/lib/elevenlabs/dubbing-conform";
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Target project ID" },
    { name: "request", required: true, description: "Reviewed source spans and new per-scene MP3 outputs" },
    {
      name: "dry-run",
      type: "boolean",
      default: true,
      description: "Plan offline; false writes immutable local files, never calls a provider",
    },
    { name: "scope-root", description: "Trusted MCP workspace boundary" },
  ] as const);
  const raw = DubbingConformRequestSchema.parse(readStudioRequest(process.cwd(), args.request!, args["scope-root"]));
  if (raw.projectId !== args.project) throw Error("Request project differs from CLI context");
  return conformDubbingAudio(raw, { scopeRoot: args["scope-root"], dryRun: args["dry-run"] });
});
