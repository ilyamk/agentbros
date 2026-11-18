import { parseArgs, runScript } from "../src/lib/cli";
import { earshot } from "../src/lib/audio/earshot";
runScript(async () => {
  const args = parseArgs([
    { name: "project", description: "Project for optional saved evidence" },
    { name: "input", required: true, description: "Local recording; never modified" },
    { name: "query", required: true, description: "Describe the wanted sound" },
    { name: "top", type: "number", default: 5, description: "Maximum non-overlapping segments, 1–20" },
    { name: "start", type: "number", description: "Start in original source seconds" },
    { name: "end", type: "number", description: "End in original source seconds; range at most 600 seconds" },
    {
      name: "kind",
      choices: ["auto", "event", "texture"],
      default: "auto",
      description: "One-shot or continuous sound candidates",
    },
    { name: "output", description: "New project-local evidence JSON; no trimming or import is automatic" },
    { name: "scope-root", description: "Trusted MCP workspace boundary" },
  ] as const);
  return earshot(
    {
      action: "find",
      input: args.input,
      query: args.query,
      top: args.top,
      start: args.start,
      end: args.end,
      kind: args.kind,
    },
    { projectId: args.project, output: args.output, scopeRoot: args["scope-root"] },
  );
});
