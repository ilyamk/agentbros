import { parseArgs, runScript } from "../src/lib/cli";
import { discoverVoices } from "../src/lib/elevenlabs/voices";
runScript(async () => {
  const args = parseArgs([
    { name: "project", description: "Project context for scoped MCP sessions" },
    {
      name: "action",
      choices: ["search", "shared", "inspect"],
      default: "search",
      description: "Read account voices, shared library or one voice; never creates or selects one",
    },
    { name: "query", description: "Search terms" },
    { name: "voice-id", description: "Provider ID for inspect" },
    { name: "limit", type: "number", default: 20, description: "Maximum page size, 1–100" },
  ] as const);
  return {
    outputs: [],
    metadata: await discoverVoices({
      action: args.action as "search" | "shared" | "inspect",
      query: args.query,
      voiceId: args["voice-id"],
      limit: args.limit,
    }),
  };
});
