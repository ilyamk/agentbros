import { parseArgs, runScript } from "../src/lib/cli";
import { elevenLabsCapabilities } from "../src/lib/elevenlabs/capabilities";
import { ElevenLabsClient } from "../src/lib/elevenlabs/client";
runScript(async () => {
  const args = parseArgs([
    { name: "project", description: "Project context for scoped MCP sessions" },
    {
      name: "refresh",
      choices: ["models", "effects"],
      description: "Explicit read-only authenticated metadata request; absent means entirely offline",
    },
  ] as const);
  const capabilities = elevenLabsCapabilities();
  const remote = args.refresh
    ? await new ElevenLabsClient().value(args.refresh === "models" ? "/v1/models" : "/v1/audio-effects/catalog")
    : undefined;
  return {
    outputs: [],
    metadata: { ...capabilities, ...(remote ? { remote, observedAt: new Date().toISOString() } : {}) },
  };
});
