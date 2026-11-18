import { parseArgs, runScript } from "../src/lib/cli";
import { fieldReport } from "../src/lib/showcase/report";
void runScript(async () => {
  const args = parseArgs([{ name: "project", required: true, description: "Project ID; nothing is sent" }] as const);
  return { metadata: fieldReport(args.project!) };
});
