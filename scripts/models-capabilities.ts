import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { FalFindQuerySchema } from "../src/types/fal-catalog";
import { capabilityVocabulary, endpointProfiles, searchCapabilities } from "../src/lib/models/capability-search";

runScript(async () => {
  const args = parseArgs([
    { name: "list", type: "boolean", description: "The capability vocabulary with model counts per provider" },
    { name: "endpoint", description: "Full capability profile of one endpoint" },
    { name: "provider", choices: ["fal", "higgsfield", "any"], description: "Provider filter; default any" },
    { name: "capability", description: "Comma-separated capabilities, all required" },
    { name: "any-capability", description: "Comma-separated capabilities, at least one required" },
    { name: "field", description: "Raw schema fallback: regex one input field name must match" },
    { name: "category", description: "Comma-separated categories" },
    { name: "inputs", description: "Comma-separated required input media" },
    { name: "outputs", description: "Comma-separated output kinds" },
    { name: "duration", type: "number", description: "Output seconds: must be accepted, and prices the scenario" },
    { name: "aspect", description: "Aspect ratio, e.g. 9:16" },
    { name: "resolution", description: "Resolution, e.g. 1080p" },
    { name: "audio", choices: ["on", "off"], description: "Generated video audio for the price scenario" },
    { name: "chars", type: "number", description: "Input text characters for the price scenario (speech)" },
    { name: "input-audio-sec", type: "number", description: "Input audio seconds; rejects a stated max below it" },
    { name: "input-video-sec", type: "number", description: "Input video seconds; rejects a stated max below it" },
    { name: "max-usd", type: "number", description: "Require a bounded quote within this amount" },
    { name: "min-tier", description: "Minimum trust tier" },
    { name: "include-retiring", type: "boolean", description: "Include retiring endpoints" },
    { name: "limit", type: "number", description: "Rows (1–100, default 20)" },
    { name: "explain", type: "boolean", description: "Include ten rejected candidates with reasons" },
    { name: "project", description: "Optional MCP project scope" },
  ] as const);
  const split = (value?: string) => value?.split(",").map((item) => item.trim());
  const scenario = {
    ...(args.duration !== undefined ? { durationSec: args.duration } : {}),
    ...(args.resolution ? { resolution: args.resolution } : {}),
    ...(args.aspect ? { aspect: args.aspect } : {}),
    ...(args.audio ? { generateAudio: args.audio === "on" } : {}),
    ...(args.chars !== undefined ? { inputCharacters: args.chars } : {}),
    ...(args["input-audio-sec"] !== undefined ? { inputAudioSec: args["input-audio-sec"] } : {}),
    ...(args["input-video-sec"] !== undefined ? { inputVideoDurationSec: args["input-video-sec"] } : {}),
  };
  const search = Boolean(
    args.capability || args["any-capability"] || args.field || args.category || args.inputs || args.outputs,
  );
  const modes = [args.list, Boolean(args.endpoint), search].filter(Boolean).length;
  if (modes !== 1)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "Use exactly one of --list, --endpoint <id>, or a search (--capability, --any-capability, --field, --category, --inputs, --outputs).",
    });
  if (args.list) return { metadata: { capabilities: capabilityVocabulary() } };
  const provider = args.provider === "any" ? undefined : (args.provider as "fal" | "higgsfield" | undefined);
  if (args.endpoint) {
    const profiles = endpointProfiles(args.endpoint, scenario, { provider });
    if (!profiles.length)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `${args.endpoint} is not in the ${provider ?? "fal or Higgsfield"} catalogue; find one with pnpm models:capabilities --capability ...`,
      });
    return { metadata: { profiles } };
  }
  const query = FalFindQuerySchema.parse({
    provider: args.provider ?? "any",
    categories: split(args.category),
    inputs: split(args.inputs),
    outputs: split(args.outputs),
    capabilities: split(args.capability),
    anyCapabilities: split(args["any-capability"]),
    field: args.field,
    inputAudioSec: args["input-audio-sec"],
    inputVideoSec: args["input-video-sec"],
    durationSec: args.duration,
    aspect: args.aspect,
    resolution: args.resolution,
    maxUsd: args["max-usd"],
    minTier: args["min-tier"],
    includeRetiring: args["include-retiring"],
    explain: args.explain,
    limit: args.limit ?? 20,
  });
  return { metadata: { scenario, ...searchCapabilities(query, scenario) } };
});
