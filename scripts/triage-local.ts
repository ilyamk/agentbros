import { parseArgs } from "../src/lib/cli";
import { runTriageScript } from "../src/lib/triage/cli";
import { localTriage } from "../src/lib/triage/local";
import { loadConfig } from "../src/lib/triage/vendors";

void runTriageScript(async () => {
  const args = parseArgs([
    {
      name: "pr",
      type: "number",
      required: true,
      description: "Pull request number to review through the maintainer's subscription harness",
    },
    { name: "repository", description: "GitHub owner/repository; defaults to the current gh repository" },
    {
      name: "harness",
      required: true,
      choices: ["codex", "claude", "both"],
      description: "Isolated local judge harnesses",
    },
    { name: "model", description: "Optional harness model ID (applies to each selected harness)" },
    {
      name: "post",
      type: "boolean",
      description: "Post advisory comment and triage labels after checking the head is unchanged",
    },
  ] as const);
  return {
    metadata: localTriage({
      pr: args.pr!,
      repository: args.repository,
      harness: args.harness as "codex" | "claude" | "both",
      model: args.model,
      post: args.post,
      maxDiffBytes: loadConfig().maxDiffBytes,
    }),
  };
});
