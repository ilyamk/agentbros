import { readLocalJson } from "../src/lib/audio/local-input";
import { parseArgs, runScript } from "../src/lib/cli";
import { VisionRequestSchema } from "../src/types/vision-review";
import { confineReviewPath, writeReviewPack } from "../src/lib/vision/review-pack";

void runScript(async () => {
  const args = parseArgs([
    { name: "request", description: "Version 1 declarative review request JSON" },
    { name: "input", description: "Local zero-origin CFR video; alternative to request" },
    { name: "output", required: true, description: "New immutable output directory" },
    {
      name: "profile",
      choices: ["overview", "motion", "typography", "ui", "captions", "reference"],
      description: "Review purpose",
    },
    { name: "scope-root", description: "Trusted filesystem boundary (supplied by MCP)" },
    { name: "project", description: "MCP project scope; does not select or alter the timeline" },
  ] as const);
  if (args["scope-root"] && args.request) confineReviewPath(args["scope-root"], args.request);
  const request = VisionRequestSchema.parse(
    args.request ? readLocalJson(args.request) : { input: args.input, profile: args.profile },
  );
  request.events = request.events.map((event) => ({ ...event, basis: "declared", reasonEvidence: undefined }));
  const result = writeReviewPack({ ...request, ...(args.profile ? { profile: args.profile } : {}) }, args.output!, {
    scopeRoot: args["scope-root"],
  });
  return {
    outputs: result.outputs,
    metadata: {
      manifest: result.manifest,
      pages: result.data.pages.length,
      warnings: result.data.warnings,
      apiCalls: 0,
    },
  };
});
