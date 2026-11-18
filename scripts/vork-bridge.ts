import { parseArgs, runScript } from "../src/lib/cli";
import { parseResolution } from "../src/lib/backends/blender-run";
import { renderReturnedGeometry } from "../src/lib/vork/hybrid";
import { bridgeVork } from "../src/lib/vork/bridge";
void runScript(async () => {
  const args = parseArgs([
    {
      name: "action",
      choices: ["from-blender", "to-blender", "composite", "render-return"],
      required: true,
      description: "Export scenes, return geometry, render a static Cycles presentation or composite passes",
    },
    { name: "input", required: true, description: "Source .blend, Vork scene JSON, or a composition request JSON" },
    { name: "output", required: true, description: "Fresh bridge output directory" },
    { name: "animation", type: "boolean", default: true, description: "Sample source animation during Blender export" },
    { name: "frames", type: "number", default: 90, description: "Imported geometry presentation frames" },
    { name: "samples", type: "number", description: "Cycles presentation samples; default 64" },
    { name: "resolution", description: "Cycles presentation WIDTHxHEIGHT" },
    { name: "frame-range", description: "Inclusive zero-based source FIRST-LAST for render-return" },
    {
      name: "purpose",
      choices: ["draft", "production"],
      default: "draft",
      description: "Export/render provenance purpose",
    },
    { name: "device", choices: ["auto", "cpu", "gpu"], default: "auto", description: "Cycles presentation device" },
    {
      name: "node",
      default: "hero",
      description: "Named geometry subtree for to-blender; intentionally excludes scene lighting",
    },
    { name: "executable", description: "Vork executable" },
    { name: "blender", description: "Blender executable; 5.3.0 target, 5.2.1 upstream control" },
  ] as const);
  if (args.action === "render-return") {
    const range = args["frame-range"]?.match(/^(\d+)-(\d+)$/);
    if (args["frame-range"] && !range) throw new Error("--frame-range must be FIRST-LAST");
    const result = await renderReturnedGeometry(args.input!, args.output!, {
      frames: args.frames,
      range: range ? [Number(range[1]), Number(range[2])] : undefined,
      samples: args.samples,
      resolution: args.resolution ? parseResolution(args.resolution) : undefined,
      purpose: args.purpose as "draft" | "production",
      device: args.device as "auto" | "cpu" | "gpu",
      executable: args.executable,
      blender: args.blender,
    });
    return {
      outputs: [result.video, result.receiptFile],
      metadata: {
        output: result.output,
        video: result.video,
        receiptFile: result.receiptFile,
        settings: result.receipt.settings,
      },
    };
  }
  const result = await bridgeVork(
    args.action as "from-blender" | "to-blender" | "composite",
    args.input!,
    args.output!,
    {
      animation: args.animation,
      executable: args.executable,
      blender: args.blender,
      frames: args.frames,
      node: args.node,
      purpose: args.purpose as "draft" | "production",
    },
  );
  return {
    outputs: [result.scene, result.reportFile, result.receiptFile],
    metadata: {
      action: result.action,
      scene: result.scene,
      reportFile: result.reportFile,
      receiptFile: result.receiptFile,
    },
  };
});
