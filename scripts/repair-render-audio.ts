import { runScript, parseArgs, ensureFfmpeg, ensureFfprobe, CliErrorObject } from "../src/lib/cli";
import { repairRenderAudio } from "../src/lib/audio/repair";
runScript(async () => {
  const args = parseArgs([
    {
      name: "input",
      required: true,
      description: "Original local video (preserved)",
    },
    { name: "output", required: true, description: "New repaired MP4 output" },
  ]);
  ensureFfmpeg();
  ensureFfprobe();
  try {
    const result = repairRenderAudio(String(args.input), String(args.output));
    return {
      outputs: [result.output],
      metadata: {
        ...result,
        qaApproval: false,
        note: "Audio repair is measured; run complete editorial/render QA before approval",
      },
    };
  } catch (error) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
