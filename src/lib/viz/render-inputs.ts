import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import type { VizPlan } from "../../types/viz";
import { hashFile } from "../assets/registry";
import { localFile } from "./store";

export function captureVizRenderInputs(workspace: string, bundleFile: string, plan: VizPlan): Record<string, string> {
  const codeRoot = path.resolve(import.meta.dirname, "../../..");
  const pins: Record<string, string> = {};
  const pin = (file: string) => {
    pins[file] = hashFile(file);
  };
  pin(localFile(workspace, bundleFile, 64 * 1024 * 1024));
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "src/types/viz.ts",
    "src/lib/viz/blender-plan.ts",
    "src/lib/viz/cli.ts",
    "src/lib/backends/blender-run.ts",
    "src/lib/vision/composition.ts",
    "src/motion/text.tsx",
    "src/motion/text-split.ts",
    "scripts/blender/viz_scene.py",
    "scripts/blender/viz_math.py",
    "scripts/workers/blender/avc_run.py",
    "scripts/workers/blender/avc_export.py",
  ])
    pin(path.join(codeRoot, name));
  const directory = path.join(codeRoot, "src/motion/viz");
  for (const name of readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    if (statSync(file).isFile()) pin(file);
  }
  for (const map of Object.values(plan.spec.textures?.maps ?? {})) {
    if (!map) continue;
    const file = localFile(workspace, path.join("public", map.path));
    if (hashFile(file) !== map.sha256) throw new Error("Texture differs from its prepared hash");
    pin(file);
  }
  return pins;
}
export function assertVizRenderInputs(pins: Record<string, string>): void {
  for (const [file, hash] of Object.entries(pins))
    if (hashFile(file) !== hash) throw new Error(`Visualisation dependency changed during render: ${file}`);
}
