import { parseArgs, runScript } from "../src/lib/cli";
import { updateShowcaseMedia } from "../src/lib/showcase/add";
import { readJson } from "../src/lib/showcase/data";
void runScript(async () => {
  const args = parseArgs([
    { name: "entry", required: true, description: "Showcase JSON path" },
    { name: "release-assets", required: true, description: "JSON array of uploaded release assets: name and url" },
  ] as const);
  return { outputs: [args.entry!], metadata: updateShowcaseMedia(args.entry!, readJson(args["release-assets"]!)) };
});
