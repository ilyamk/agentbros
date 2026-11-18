import { parseArgs, runScript } from "../src/lib/cli";
import { parseResolution } from "../src/lib/backends/blender-run";
import { renderHybridVfx } from "../src/lib/vork/hybrid";
import { vfxAction } from "../src/lib/vork/vfx";
void runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      choices: ["prepare", "solve", "build", "review", "render"],
      required: true,
      description: "Prepare immutable footage, estimate a calibrated plane camera, build or review",
    },
    {
      name: "request",
      required: true,
      description: "Strict VFX JSON request; camera or explicit planar calibration required",
    },
    { name: "resolution", description: "Cycles preview WIDTHxHEIGHT; preserve source aspect ratio" },
    { name: "frames", description: "Inclusive source frame FIRST-LAST, zero based" },
    { name: "device", choices: ["auto", "cpu", "gpu"], default: "auto", description: "Explicit Cycles device" },
    { name: "samples", type: "number", description: "Explicit Cycles samples; default 64" },
    { name: "first-frame", type: "number", description: "Blender timeline start; source frame zero maps here" },
    {
      name: "purpose",
      choices: ["draft", "production"],
      default: "draft",
      description: "Receipt purpose; drafts stay preview-only",
    },
    { name: "output", required: true, description: "Fresh evidence/output directory" },
  ] as const);
  if (args.action === "render") {
    const range = args.frames?.match(/^(\d+)-(\d+)$/);
    if (args.frames && !range) throw new Error("--frames must be FIRST-LAST");
    const result = await renderHybridVfx(args.request!, args.output!, {
      samples: args.samples,
      frames: range ? [Number(range[1]), Number(range[2])] : undefined,
      resolution: args.resolution ? parseResolution(args.resolution) : undefined,
      device: args.device as "auto" | "cpu" | "gpu",
      firstFrame: args["first-frame"],
      purpose: args.purpose as "draft" | "production",
    });
    return {
      outputs: [result.receiptFile, result.video],
      metadata: {
        renderBackend: result.receipt.renderBackend,
        output: result.output,
        video: result.video,
        receiptFile: result.receiptFile,
        settings: result.receipt.settings,
        elapsedMs: result.receipt.elapsedMs,
      },
    };
  }
  const result = await vfxAction(args.action!, args.request!, args.output!);
  return { outputs: result.outputs, metadata: result };
});
