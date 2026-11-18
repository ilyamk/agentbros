import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MotionPlan } from "../../types/creative";
import { collectActiveViz } from "./usage";

export function assertVizMotionPlan(root: string, project: string, plan: MotionPlan): void {
  const active = collectActiveViz(root, project, plan);
  for (const shot of plan.shots) {
    if (!shot.vizBinding) continue;
    const item = active.find(
      (a) => a.sceneId === shot.vizBinding!.sceneId && a.bundle.hash === shot.vizBinding!.revision,
    )!;
    if (plan.fps !== 30 || shot.durationFrames !== item.bundle.plans[0]!.spec.durationFrames)
      throw new Error(`Visualisation ${shot.id} must match its exact 30fps shot duration`);
  }
}
export function vizProjectAdvice(root: string, project: string) {
  const directory = path.join(root, "public/projects", project);
  const read = (name: string): unknown => {
    const file = path.join(directory, "pipeline", name);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const configFile = path.join(directory, "project.json");
  const consumed =
    read("timeline-edit.json") ??
    (existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : read("motion-plan.json"));
  const active = collectActiveViz(root, project, consumed);
  if (!active.length) return undefined;
  return {
    scenes: active.map((a) => ({
      sceneId: a.sceneId,
      revision: a.bundle.hash,
      recipe: a.bundle.plans[0]!.spec.recipe,
      formats: a.bundle.plans.map((p) => p.format),
    })),
    commands: active.map((a) => `pnpm viz:check --project ${project} --scene ${a.sceneId} --revision ${a.bundle.hash}`),
    read: ["docs/visualisations.md"],
    factualTruth: "unverified" as const,
  };
}
