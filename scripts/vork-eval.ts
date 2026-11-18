import { parseArgs, runScript } from "../src/lib/cli";
import { evaluateQualification } from "../src/lib/vork/qualification";
import { evaluateVork, evaluationIds, evaluationReport, comparisonPackets } from "../src/lib/vork/evaluation";
void runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      choices: ["run", "report", "pack"],
      default: "report",
      description: "Real local recipe proof, report reading or blinded A/B packets",
    },
    {
      name: "mode",
      choices: ["proof", "qualification"],
      default: "proof",
      description: "Three-frame proof or complete-clip evidence qualification",
    },
    { name: "reviews", description: "Two independent source-bound review JSON files, comma separated" },
    { name: "output", description: "Fresh evaluation/packet directory" },
    { name: "input", description: "Existing evaluation JSON for report" },
    { name: "ids", description: "Comma-separated recipe IDs; default all" },
    { name: "resolution", default: "320x180", description: "Proof WIDTHxHEIGHT" },
    { name: "samples", type: "number", default: 4, description: "Proof sample budget" },
    { name: "executable", description: "Pinned Vork executable" },
    { name: "baseline", description: "Blender or prior matched PNG sequence/video for pack" },
    { name: "candidate", description: "Matched candidate PNG sequence/video for pack" },
    { name: "reference", description: "Creative intent and comparison reference, without source identity" },
  ] as const);
  if (args.action === "report") {
    if (!args.input) throw new Error("--input is required");
    return { outputs: [], metadata: evaluationReport(args.input) as Record<string, unknown> };
  }
  if (!args.output) throw new Error("--output is required");
  if (args.action === "pack") {
    if (!args.baseline || !args.candidate || !args.reference)
      throw new Error("--baseline, --candidate and --reference are required");
    const result = comparisonPackets({
      baseline: args.baseline,
      candidate: args.candidate,
      output: args.output,
      reference: args.reference,
    });
    return { outputs: [result.key, ...result.packets], metadata: result };
  }
  if (args.mode === "qualification") {
    if (!args.input) throw new Error("Qualification requires --input suite JSON");
    const result = evaluateQualification(args.input, args.output, args.reviews?.split(","));
    return {
      outputs: [result.file],
      metadata: {
        mode: "qualification",
        pass: result.report.pass,
        cases: result.report.cases.map((row) => ({ id: row.id, pass: row.pass, error: row.error })),
      },
    };
  }
  const parts = args.resolution!.split("x").map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isInteger(n) || n < 16))
    throw new Error("Resolution must be WIDTHxHEIGHT");
  const result = await evaluateVork(args.output, args.ids?.split(",") ?? evaluationIds(), {
    resolution: parts as [number, number],
    samples: args.samples,
    executable: args.executable,
  });
  return {
    outputs: [result.file],
    metadata: {
      pass: result.report.pass,
      recipes: result.report.recipes.map((row) => ({
        id: row.id,
        status: row.status,
        error: row.error,
        elapsedMs: row.elapsedMs,
      })),
    },
  };
});
