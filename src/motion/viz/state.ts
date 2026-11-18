import type { VizPlan } from "../../types/viz";
const ramp = (frame: number, start: number, duration: number): number =>
  Math.min(1, Math.max(0, (frame - start) / duration));
export function vizElementState(plan: VizPlan, primitive: VizPlan["primitives"][number], frame: number) {
  const hold = plan.spec.events.find(
    (e) =>
      e.action === "hold" &&
      (!e.target || e.target === primitive.id || e.target === primitive.datumId) &&
      frame >= e.frame &&
      frame < e.frame + e.duration,
  );
  const sample = hold ? hold.frame : frame;
  let progress = ramp(sample, 0, Math.min(90, plan.spec.durationFrames - 30));
  let opacity = progress;
  let fill = primitive.fill;
  for (const event of plan.spec.events) {
    if (event.target && event.target !== primitive.id && event.target !== primitive.datumId) continue;
    const t = ramp(sample, event.frame, event.duration);
    if (event.action === "reveal") {
      opacity = t;
      progress = t;
    }
    if (event.action === "draw") progress = t;
    if (event.action === "dim") opacity *= 1 - t * 0.7;
    if (event.action === "highlight" && t > 0) fill = plan.spec.theme.accent;
  }
  if (
    plan.spec.theme.background === "transparent" &&
    primitive.kind === "rect" &&
    plan.spec.groups?.some((g) => g.id === primitive.id)
  )
    opacity = 0;
  return { progress, opacity, fill };
}
export function vizObjectGeometry(plan: VizPlan, p: VizPlan["primitives"][number]) {
  const width = p.kind === "circle" ? (p.radius ?? 12) * 2 : (p.width ?? 1);
  const height = p.kind === "circle" ? (p.radius ?? 12) * 2 : (p.height ?? 1);
  const group = plan.spec.groups?.some((g) => g.id === p.id);
  return {
    z: group ? -0.4 : 0,
    width: width / 200,
    height: height / 200,
    x: (p.x + (p.kind === "rect" ? width / 2 : 0) - plan.width / 2) / 200,
    y: (plan.height / 2 - p.y - (p.kind === "rect" ? height / 2 : 0)) / 200,
    depth: group ? 0.02 : 0.3,
  };
}
export function bakeVizStates(plan: VizPlan) {
  return Array.from({ length: plan.spec.durationFrames }, (_, frame) =>
    plan.primitives
      .filter((p) => p.kind === "circle" || p.kind === "rect")
      .map((p) => ({ id: p.id, ...vizElementState(plan, p, frame), ...vizObjectGeometry(plan, p) })),
  );
}

export function vizCameraState(plan: VizPlan, frame: number) {
  const t = ramp(
    frame,
    plan.spec.camera.startFrame,
    Math.max(1, (plan.spec.camera.endFrame ?? plan.spec.durationFrames - 30) - plan.spec.camera.startFrame),
  );
  return {
    zoom: plan.spec.camera.move === "push" ? 1 + plan.spec.camera.amount * t : 1,
    panX: plan.spec.camera.move === "truck" ? plan.spec.camera.amount * t * plan.width : 0,
  };
}
export function vizLighting(plan: VizPlan) {
  return {
    ambient: plan.spec.light === "low-key" ? 0.3 : plan.spec.light === "high-key" ? 2 : 1.2,
    key: plan.spec.light === "low-key" ? 3 : 2,
  };
}

export function vizProjection(plan: VizPlan) {
  const yaw = (plan.spec.camera.azimuth * Math.PI) / 180,
    pitch = (plan.spec.camera.elevation * Math.PI) / 180;
  return {
    position: [20 * Math.sin(yaw) * Math.cos(pitch), 20 * Math.sin(pitch), 20 * Math.cos(yaw) * Math.cos(pitch)] as [
      number,
      number,
      number,
    ],
    matrix: [Math.cos(yaw), Math.sin(pitch) * Math.sin(yaw), 0, Math.cos(pitch)],
  };
}

export function vizScreenTransform(plan: VizPlan, frame: number) {
  const camera = vizCameraState(plan, frame);
  const projection = plan.spec.recipe.endsWith("-3d") ? vizProjection(plan).matrix : [1, 0, 0, 1];
  const [a, b, c, d] = projection.map((n) => n * camera.zoom) as [number, number, number, number];
  return [
    a,
    b,
    c,
    d,
    plan.width / 2 - (a * plan.width) / 2 - (c * plan.height) / 2 + camera.panX * a,
    plan.height / 2 - (b * plan.width) / 2 - (d * plan.height) / 2 + camera.panX * b,
  ] as const;
}
