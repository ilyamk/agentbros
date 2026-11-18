import { parseArgs, runScript } from "../src/lib/cli";
import { readLocalPolicy, writeLocalPolicy } from "../src/lib/local-capabilities";
runScript(async () => {
  const args = parseArgs([
    {
      name: "mode",
      choices: ["interactive", "autonomous"],
      description: "Whether the orchestrator can ask the user; never inferred from a TTY",
    },
    {
      name: "downloads",
      choices: ["task", "ask", "never"],
      description: "Task-scoped model/dependency preparation policy",
    },
  ] as const);
  const current = readLocalPolicy();
  return {
    metadata:
      args.mode || args.downloads
        ? writeLocalPolicy({
            ...current,
            ...(args.mode ? { mode: args.mode } : {}),
            ...(args.downloads ? { downloads: args.downloads } : {}),
          })
        : current,
  };
});
