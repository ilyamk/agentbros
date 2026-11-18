import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBlender, type BlenderRunRequest } from "../backends/blender-run";
import { CliErrorObject } from "../cli";
import { filesIn, hashFile, json, writeNew } from "./runtime";
import { exportVork, checkScene } from "./render";
import { VorkTaskSchema } from "../../types/vork";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
export async function bridgeVork(
  action: "from-blender" | "to-blender" | "composite",
  input: string,
  output: string,
  options: {
    animation?: boolean;
    executable?: string;
    blender?: string;
    frames?: number;
    node?: string;
    purpose?: "draft" | "production";
    diagnostics?: string;
  } = {},
) {
  input = path.resolve(input);
  output = path.resolve(output);
  if (!existsSync(input)) throw new Error(`Bridge input missing: ${input}`);
  if (existsSync(output)) throw new CliErrorObject({ code: "FILE_EXISTS", message: "Use a fresh bridge directory" });
  const before = hashFile(input);
  mkdirSync(output, { recursive: true });
  let geometry: Awaited<ReturnType<typeof exportVork>> | undefined;
  if (action === "to-blender")
    geometry = await exportVork(input, path.join(output, "asset.glb"), {
      executable: options.executable,
      node: options.node ?? "hero",
      purpose: options.purpose,
    });
  const config = {
    action,
    input: geometry?.output ?? input,
    output,
    animation: options.animation ?? true,
    frames: options.frames ?? 90,
    diagnostics: options.diagnostics,
    exporter: path.join(repository, "vendor/vork-blender/integrations/blender/export.py"),
  };
  const request: BlenderRunRequest = {
    script: path.join(repository, "scripts/workers/blender/avc_vork_bridge.py"),
    ...(action === "from-blender" ? { blend: input } : {}),
    output: path.join(output, "worker"),
    format: "png",
    device: "auto",
    factoryStartup: true,
    noRender: true,
    overwrite: false,
    resume: false,
    scriptArgs: [JSON.stringify(config)],
    executable: options.blender,
    timeoutSec: 600,
  };
  const result = await runBlender(request);
  if (hashFile(input) !== before) throw new Error("Bridge changed the original input");
  const reportFile =
    action === "from-blender" ? path.join(output, "export-report.json") : path.join(output, "bridge-report.json");
  const report = json(reportFile) as Record<string, unknown>;
  if (action === "from-blender") {
    const scene = path.join(output, "shot.json");
    await checkScene(scene, options.executable);
    const raw = json(scene) as { render: { duration?: number; fps?: number } };
    writeNew(
      path.join(output, "task.json"),
      VorkTaskSchema.parse({
        schemaVersion: 1,
        id: "blender-export",
        workflow: "blender-export",
        scene: "shot.json",
        inputs: [
          path.relative(output, input),
          "export-report.json",
          ...filesIn(path.join(repository, "vendor/vork-blender")).map((file) => path.relative(output, file)),
        ],
        intent: "Render the saved Blender scene with Vork and preserve its staging",
        notice: "The original subject and authored movement",
        duration: raw.render.duration ?? 1,
        fps: raw.render.fps ?? 30,
        seed: 42,
        camera: "Exported source camera",
        light: "Exported source lights",
        material: "Strict translated material graphs; inspect report",
        motion: "Sampled source animation",
        effect: "Explicit alternate renderer; no promise of BSDF parity",
        profile: "std/final",
        acceptance: ["No unexplained bridge omission", "Camera, material and timing inspected against Blender"],
      }),
    );
  }
  const receiptFile = writeNew(path.join(output, "bridge-receipt.json"), {
    schemaVersion: 1,
    action,
    source: { file: input, sha256: before },
    blender: result.render.blenderVersion,
    report,
    output: action === "from-blender" ? "shot.json" : "scene.blend",
  });
  return {
    action,
    output,
    reportFile,
    receiptFile,
    scene: path.join(output, action === "from-blender" ? "shot.json" : "scene.blend"),
    report,
    geometry,
  };
}
