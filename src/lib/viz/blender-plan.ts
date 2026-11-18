import type { VizPlan } from "../../types/viz";
import { vizProjection, vizCameraState, vizLighting, bakeVizStates, vizElementState } from "../../motion/viz/state";
import { vizPathPoints } from "../../motion/viz/paths";
export const vizPreviewFrames = (duration: number) => [0, Math.floor(duration / 2), duration - 1];
export function vizBlenderRanges(duration: number, preview: boolean): Array<[number, number]> {
  return preview ? vizPreviewFrames(duration).map((frame) => [frame + 1, frame + 1]) : [[1, duration]];
}
export function prepareVizBlenderPlan(plan: VizPlan, resolveTexture: (publicPath: string) => string) {
  return {
    ...plan,
    states: bakeVizStates(plan),
    paths: plan.primitives
      .filter((p) => p.kind === "path")
      .map((p) => ({
        id: p.id,
        points: vizPathPoints(plan, p),
        width: p.strokeWidth ?? 5,
        states: Array.from({ length: plan.spec.durationFrames }, (_, frame) => vizElementState(plan, p, frame)),
      })),
    cameraFrames: Array.from({ length: plan.spec.durationFrames }, (_, frame) => vizCameraState(plan, frame)),
    lighting: vizLighting(plan),
    projection: vizProjection(plan),
    textureFiles: Object.fromEntries(
      Object.entries(plan.spec.textures?.maps ?? {})
        .filter(([, map]) => map)
        .map(([role, map]) => [role, { ...map, absolutePath: resolveTexture(map!.path) }]),
    ),
  };
}
