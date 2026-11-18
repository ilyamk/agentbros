import { ensureFfmpeg, parseArgs, runScript } from "../src/lib/cli";
import { buildAudioMap } from "../src/lib/audio-map/analyse";

const SPECS = [
  { name: "input", required: true, description: "Audio or video file to read, a reference film included" },
  { name: "output", required: true, description: "Where to write the audio map JSON" },
  { name: "image", description: "Where to draw the map PNG. Defaults to the output path with .png" },
  { name: "no-image", type: "boolean", description: "Skip the map PNG" },
  {
    name: "aac-priming-correct",
    type: "boolean",
    description:
      "Remove AAC encoder priming the file presents (no edit list): the map then follows the encoder's timeline, not what players play",
  },
  {
    name: "stems",
    type: "boolean",
    description:
      "Split the track with Demucs first and read the drums from the drums stem (cached by audio hash; falls back to the mix)",
  },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  const result = buildAudioMap({
    input: args.input!,
    output: args.output!,
    imagePath: args["no-image"] ? null : args.image,
    stems: Boolean(args.stems),
    aacPrimingCorrect: Boolean(args["aac-priming-correct"]),
  });
  return {
    outputs: [result.jsonPath, ...(result.imagePath ? [result.imagePath] : [])],
    metadata: {
      brief: result.brief,
      bpm: result.map.tempo.bpm,
      gridTrust: result.map.tempo.gridTrust,
      gridSource: result.map.grid?.source,
      decoder: result.map.source.decoder,
      confidence: result.map.tempo.confidence,
      diagnostics: result.diagnostics,
      apiCalls: 0,
    },
  };
});
