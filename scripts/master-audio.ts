import { writeFileSync } from "node:fs";
import { parseArgs, runScript, ensureFfmpeg, ensureFfprobe, CliErrorObject } from "../src/lib/cli";
import { localInputHash } from "../src/lib/audio/local-input";
import type { LoudnessPreset } from "../src/lib/audio/local-mix";
import { masterGraph, masterRenderedFile } from "../src/lib/audio/master-file";

runScript(async () => {
  const args = parseArgs([
    {
      name: "input",
      required: true,
      description: "Rendered MP4/MOV or WAV whose own audio is mastered; no project timeline needed",
    },
    {
      name: "output",
      required: true,
      description: "Output .wav (audio only) or .mp4/.mov (input video copied, mastered AAC audio)",
    },
    {
      name: "preset",
      choices: ["social", "review"],
      description: "Loudness target: social −14 LUFS / −1.5 dBTP (default), review −16 LUFS / −1.5 dBTP",
    },
    { name: "dry-run", type: "boolean", description: "Validate and return the FFmpeg graph without creating output" },
    { name: "force", type: "boolean", description: "Explicitly replace an existing output" },
  ]);
  ensureFfmpeg();
  ensureFfprobe();
  const input = String(args.input);
  const output = String(args.output);
  const preset = (args.preset ?? "social") as LoudnessPreset;
  try {
    if (args["dry-run"]) return { outputs: [], metadata: { dryRun: true, preset, ...masterGraph(input, preset) } };
    const result = masterRenderedFile(input, output, { preset, force: args.force === true });
    const report = {
      input,
      inputSha256: localInputHash(input),
      output,
      outputSha256: localInputHash(output),
      container: result.container,
      preset,
      durationSec: result.delivered.durationSec,
      integratedLufs: result.delivered.integratedLufs,
      truePeakDb: result.delivered.truePeakDb,
      targetLufs: result.plan.targetLufs,
      truePeakCeilingDb: result.plan.truePeakDb,
      createdAt: new Date().toISOString(),
    };
    const sidecar = `${output}.json`;
    writeFileSync(sidecar, JSON.stringify(report, null, 2) + "\n");
    return { outputs: [output, sidecar], metadata: { master: report, apiCalls: 0 } };
  } catch (error) {
    throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
  }
});
