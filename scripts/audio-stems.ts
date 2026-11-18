import { ensureFfmpeg, parseArgs, runScript } from "../src/lib/cli";
import { separateStems, STEM_MODEL } from "../src/lib/audio-map/stems";

const SPECS = [
  { name: "input", required: true, description: "Audio or video file to split" },
  { name: "model", description: `Demucs model (default ${STEM_MODEL})` },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  const stems = separateStems(args.input!, { model: args.model ?? STEM_MODEL });
  return {
    outputs: Object.values(stems.paths),
    metadata: { model: stems.model, sha256: stems.sha256, dir: stems.dir, cached: stems.cached, apiCalls: 0 },
  };
});
