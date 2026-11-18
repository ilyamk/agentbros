/**
 * Free local subject or person cut-outs (docs/matte.md). Same output as `pnpm rmbg`: an RGBA PNG at the source's size,
 * subject opaque, the rest transparent; frames get one per frame plus grey alpha, optional ProRes 4444 and a receipt.
 */
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { DEFAULT_TEMPORAL } from "../src/lib/matte/temporal";
import { MatteEngineRequestSchema, MatteKindSchema } from "../src/types/matte";

runScript(async () => {
  const args = parseArgs([
    { name: "input", short: "i", description: "Image, video, or a folder of frames (sorted by name)" },
    {
      name: "out",
      description:
        "Output folder: <stem>.png (+ .alpha.png, .matte.json) for an image; cutout/, alpha/, matte.json for frames",
    },
    {
      name: "output",
      short: "o",
      description: "One image only: the cut-out .png path, as pnpm rmbg --output takes it",
    },
    { name: "kind", default: "subject", description: "subject (any salient object) or person" },
    {
      name: "engine",
      default: "auto",
      description: "auto (vision on macOS, else onnx), vision (Apple Vision, macOS) or onnx (BiRefNet lite, every OS)",
    },
    { name: "quality", default: "accurate", description: "Vision person quality: fast, balanced, accurate" },
    { name: "start-frame", type: "number", description: "First source frame (0-based) of a video or frame folder" },
    { name: "end-frame", type: "number", description: "Source frame to stop before (exclusive)" },
    { name: "max-frames", type: "number", default: 600, description: "Refuse ranges longer than this" },
    { name: "temporal", default: "ema", description: "Frames: ema (motion-gated smoothing of the alpha) or none" },
    {
      name: "strength",
      type: "number",
      default: DEFAULT_TEMPORAL.strength,
      description: "EMA history weight on still pixels, 0..0.95",
    },
    {
      name: "refine",
      type: "boolean",
      default: false,
      description: "Guided-filter edge refine against the source picture",
    },
    {
      name: "prores",
      type: "boolean",
      default: false,
      description: "Frames: also write cutout.mov, ProRes 4444 with alpha",
    },
    { name: "threads", type: "number", description: "onnx CPU threads (default cores - 2, at most 8)" },
    { name: "force", short: "f", type: "boolean", default: false, description: "Replace existing outputs" },
    { name: "probe", type: "boolean", default: false, description: "Report which engines can run here and exit" },
  ] as const);
  if (args.probe) {
    const { engineFacts } = await import("../src/lib/matte");
    const { selectEngine } = await import("../src/lib/matte/engine");
    const facts = await engineFacts();
    const auto = { subject: selectEngine("auto", "subject", facts), person: selectEngine("auto", "person", facts) };
    return {
      outputs: [],
      metadata: {
        platform: facts.platform,
        macosMajor: facts.macosMajor ?? null,
        vision: facts.vision,
        onnx: facts.onnx,
        auto,
      },
    };
  }
  if (!args.input) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--input is required (or --probe)" });
  const kind = MatteKindSchema.safeParse(args.kind);
  const engine = MatteEngineRequestSchema.safeParse(args.engine);
  if (!kind.success) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--kind is subject or person" });
  if (!engine.success) throw new CliErrorObject({ code: "INVALID_INPUT", message: "--engine is auto, vision or onnx" });
  if (!["fast", "balanced", "accurate"].includes(args.quality!))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--quality is fast, balanced or accurate" });
  if (args.temporal !== "ema" && args.temporal !== "none")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--temporal is ema or none" });
  if (!(args.strength! >= 0 && args.strength! <= 0.95))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--strength is 0..0.95" });
  const { runMatte } = await import("../src/lib/matte");
  const result = await runMatte({
    input: args.input,
    out: args.out,
    output: args.output,
    kind: kind.data,
    engine: engine.data,
    quality: args.quality as "fast" | "balanced" | "accurate",
    startFrame: args["start-frame"],
    endFrame: args["end-frame"],
    maxFrames: args["max-frames"]!,
    temporal: args.temporal,
    strength: args.strength!,
    refine: args.refine!,
    prores: args.prores!,
    force: args.force!,
    threads: args.threads,
  });
  const { receipt } = result;
  return {
    outputs: result.outputs,
    metadata: {
      receipt: result.receiptFile,
      engine: receipt.engine,
      fallback: receipt.fallback ?? null,
      frames: receipt.input.frames,
      cutout: receipt.outputs.cutout,
      alpha: receipt.outputs.alpha,
      prores: receipt.outputs.prores ?? null,
      timings: receipt.timings,
      coverage: receipt.coverage,
      temporal: receipt.temporal,
      warnings: receipt.warnings,
    },
  };
});
