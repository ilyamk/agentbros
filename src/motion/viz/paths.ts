import { getLength, getPointAtLength } from "@remotion/paths";
import type { VizPlan } from "../../types/viz";
/** Shared sampled centreline lies behind solid geometry and participates in depth testing. */
export function vizPathPoints(plan: VizPlan, p: VizPlan["primitives"][number]): Array<[number, number, number]> {
  if (!p.d) return [];
  const length = getLength(p.d);
  if (!Number.isFinite(length) || length === 0) return [];
  const count = Math.min(512, Math.max(2, Math.ceil(length / 8)));
  return Array.from({ length: count + 1 }, (_, i) => {
    const point = getPointAtLength(p.d!, (length * i) / count);
    if (!point) throw new Error(`Cannot sample visualisation path ${p.id}`);
    return [(p.x + point.x - plan.width / 2) / 200, (plan.height / 2 - p.y - point.y) / 200, -0.17];
  });
}
export function vizClippedPathPoints(
  points: Array<[number, number, number]>,
  progress: number,
): Array<[number, number, number]> {
  if (progress <= 0 || points.length < 2) return [];
  if (progress >= 1) return points;
  const position = progress * (points.length - 1),
    index = Math.floor(position),
    fraction = position - index;
  const a = points[index]!,
    b = points[index + 1]!;
  return [
    ...points.slice(0, index + 1),
    a.map((value, i) => value + (b[i]! - value) * fraction) as [number, number, number],
  ];
}
