import { parseArgs, runScript } from "../src/lib/cli";
import { buildSite } from "../site/build";
void runScript(async () => {
  const args = parseArgs([
    { name: "out", default: "out/site", description: "Site output directory under out/" },
  ] as const);
  return buildSite(process.cwd(), args.out!);
});
