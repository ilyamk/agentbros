import { parseArgs, runScript } from "../src/lib/cli";
import { ModelPickQuerySchema, pickModel } from "../src/lib/models/model-slots";
import { readModelPreferences } from "../src/lib/models/model-slots-project";

runScript(async () => {
  const args = parseArgs([
    { name: "use-case", description: "Exact production use case id" },
    { name: "slot", description: "Exact task slot id" },
    { name: "task", description: "Task in Russian or English" },
    { name: "class", choices: ["hero", "balanced", "budget", "draft"], description: "Requested planning class" },
    { name: "provider", choices: ["fal", "higgsfield", "any"], description: "Provider filter; default any" },
    { name: "model", description: "Explicit endpoint pin; failure never substitutes another endpoint" },
    { name: "project", description: "Read this project's preferences and quality tier" },
    { name: "max-usd", type: "number", description: "Maximum planning estimate in USD" },
    {
      name: "allow-unknown-price",
      type: "boolean",
      description: "Allow unknown planning prices within a budget filter",
    },
    { name: "duration", type: "number", description: "Duration in seconds" },
    { name: "aspect", description: "Aspect ratio" },
    { name: "chars", type: "number", description: "Input text characters; overrides the slot reference" },
    { name: "audio-seconds", type: "number", description: "Input audio seconds; overrides the slot reference" },
    { name: "images", type: "number", description: "Output image count; overrides the slot reference" },
    { name: "megapixels", type: "number", description: "Output megapixels per image; overrides the slot reference" },
    {
      name: "audio",
      choices: ["on", "off"],
      description: "Generated video audio variant for scenario/tariff comparison",
    },
    { name: "resolution", description: "Output resolution" },
    { name: "inputs", description: "Comma-separated required input media" },
    {
      name: "capability",
      description: "Comma-separated capabilities, all required (list: pnpm models:capabilities --list)",
    },
    { name: "any-capability", description: "Comma-separated capabilities, at least one required" },
    { name: "field", description: "Raw schema fallback: regex one input field name must match" },
    {
      name: "input-audio-sec",
      type: "number",
      description: "Input audio seconds (same as --audio-seconds); rejects a stated max below it",
    },
    { name: "input-video-sec", type: "number", description: "Input video seconds; rejects a stated max below it" },
  ] as const);
  const result = pickModel(
    ModelPickQuerySchema.parse({
      slot: args.slot,
      useCase: args["use-case"],
      task: args.task,
      class: args.class,
      provider: args.provider,
      model: args.model,
      project: args.project,
      maxUsd: args["max-usd"],
      allowUnknownPrice: args["allow-unknown-price"],
      durationSec: args.duration,
      aspect: args.aspect,
      resolution: args.resolution,
      generateAudio: args.audio === undefined ? undefined : args.audio === "on",
      inputCharacters: args.chars,
      inputAudioSec: args["input-audio-sec"] ?? args["audio-seconds"],
      inputVideoDurationSec: args["input-video-sec"],
      images: args.images,
      megapixels: args.megapixels,
      inputs: args.inputs?.split(",").map((s) => s.trim()),
      capabilities: args.capability?.split(",").map((s) => s.trim()),
      anyCapabilities: args["any-capability"]?.split(",").map((s) => s.trim()),
      field: args.field,
    }),
    args.project ? readModelPreferences(args.project) : {},
  );
  return { metadata: { offline: true, ...result } };
});
