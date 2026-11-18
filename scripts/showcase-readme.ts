import { parseArgs, runScript } from "../src/lib/cli";
import { showcaseReadme } from "../src/lib/showcase/readme";
void runScript(async () => {
  parseArgs([]);
  return showcaseReadme(process.cwd());
});
