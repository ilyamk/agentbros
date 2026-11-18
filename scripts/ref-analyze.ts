import { ensureFfmpeg, ensureFfprobe, parseArgs, runScript } from "../src/lib/cli";
import { analyseReference, ANALYSIS_LAYERS, parseLayers } from "../src/lib/reference/analyse";
import { DEFAULT_LIBRARY_ROOT } from "../src/lib/reference/library";

const SPECS = [
  { name: "id", required: true, description: "Reference id" },
  { name: "library-root", default: DEFAULT_LIBRARY_ROOT, description: "Library directory" },
  { name: "layers", description: `Comma-separated subset of ${ANALYSIS_LAYERS.join(",")}. Defaults to all` },
  { name: "language", description: "Speech language such as en or ru. Defaults to automatic detection" },
  { name: "stems", type: "boolean", description: "Also separate audio stems with demucs (large first download)" },
] as const;

void runScript(async () => {
  const args = parseArgs(SPECS);
  ensureFfmpeg();
  ensureFfprobe();
  const result = await analyseReference({
    libraryRoot: args["library-root"]!,
    id: args.id!,
    layers: parseLayers(args.layers),
    stems: args.stems,
    language: args.language,
  });
  return {
    outputs: result.outputs,
    metadata: {
      directory: result.directory,
      crop: result.crop,
      layers: result.layers,
      summary: result.summary,
      apiCalls: 0,
    },
  };
});
