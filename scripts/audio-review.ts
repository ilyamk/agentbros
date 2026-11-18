import { parseArgs, runScript } from "../src/lib/cli";
import { earshot } from "../src/lib/audio/earshot";
runScript(async () => {
  const args = parseArgs([
    { name: "project", description: "Project for optional saved evidence" },
    { name: "input", required: true, description: "Local sound/render; never modified" },
    { name: "output", description: "New project-local advisory report JSON" },
    { name: "scope-root", description: "Trusted MCP workspace boundary" },
  ] as const);
  return earshot(
    { action: "check", input: args.input },
    { projectId: args.project, output: args.output, scopeRoot: args["scope-root"] },
  );
});
