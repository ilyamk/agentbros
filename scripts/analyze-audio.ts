import { parseArgs, runScript, ensureFfmpeg, ensureFfprobe, CliErrorObject } from "../src/lib/cli";
import { analyzeAudio } from "../src/lib/audio/analysis";
runScript(async () => {
  const args = parseArgs([{ name: "input", required: true, description: "Local audio/video file" }]);
  ensureFfmpeg();
  ensureFfprobe();
  try {
    return {
      outputs: [],
      metadata: { analysis: analyzeAudio(String(args.input)), apiCalls: 0 },
    };
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
