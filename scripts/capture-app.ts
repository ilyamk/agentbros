import { readFileSync } from "node:fs";
import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";

runScript(async () => {
  const args = parseArgs([
    { name: "url", required: true, description: "Page URL, or a local HTML path" },
    { name: "script", description: "Steps JSON: { steps: [{ at | time, action, ... }] }" },
    { name: "fps", type: "number", default: 30, description: "Frames per second" },
    { name: "duration", type: "number", required: true, description: "Seconds to capture" },
    { name: "output", required: true, description: "Empty output directory" },
    { name: "width", type: "number", default: 1440, description: "Viewport width in CSS pixels" },
    { name: "height", type: "number", default: 900, description: "Viewport height in CSS pixels" },
    { name: "scale", type: "number", default: 2, description: "Device scale factor" },
    { name: "format", default: "both", choices: ["png", "mp4", "both"], description: "PNG sequence, mp4, or both" },
    {
      name: "settle",
      type: "number",
      default: 1000,
      description: "Virtual milliseconds the page may load before frame 0",
    },
    { name: "seed", type: "number", default: 1, description: "Seed for the page's Math.random" },
    {
      name: "show-caret",
      type: "boolean",
      default: false,
      description: "Keep the text caret (it blinks on the wall clock, so frames stop being repeatable)",
    },
    { name: "chrome", description: "Headless Chromium executable (default: Remotion's chrome-headless-shell)" },
  ] as const);
  for (const [name, value] of [
    ["fps", args.fps],
    ["duration", args.duration],
    ["width", args.width],
    ["height", args.height],
    ["scale", args.scale],
  ] as const) {
    if (!(value > 0)) throw new CliErrorObject({ code: "INVALID_INPUT", message: `--${name} must be positive` });
  }
  const { captureApp, captureScriptSchema } = await import("../src/lib/capture-app");
  let steps: ReturnType<typeof captureScriptSchema.parse>["steps"] = [];
  if (args.script) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(args.script, "utf8"));
    } catch (error) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Cannot read --script: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const parsed = captureScriptSchema.safeParse(raw);
    if (!parsed.success)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Invalid steps: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
      });
    steps = parsed.data.steps;
  }
  try {
    const manifest = await captureApp(
      {
        url: args.url!,
        steps,
        fps: args.fps,
        durationSec: args.duration,
        output: args.output!,
        width: args.width,
        height: args.height,
        scale: args.scale,
        format: args.format as "png" | "mp4" | "both",
        chrome: args.chrome,
        settleMs: args.settle,
        seed: args.seed,
        showCaret: args["show-caret"],
      },
      (line) => emitProgress(line),
    );
    const { frameHashes, ...metadata } = manifest;
    return {
      outputs: manifest.outputs,
      metadata: { ...metadata, firstFrameHash: frameHashes[0], lastFrameHash: frameHashes.at(-1) },
    };
  } catch (error) {
    if (error instanceof CliErrorObject) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CliErrorObject({ code: message.startsWith("timeout") ? "TIMEOUT" : "INTERNAL", message });
  }
});
