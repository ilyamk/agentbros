import type { BlenderScene } from "./blender-scene";

/** Translational sphere impulses only. No spin, rolling, mesh or native Blender dynamics. */
export const SPHERE_CONTACT_SOLVER = "avc-sphere-contacts-v1" as const;
export const CONTACT_TOLERANCE = 1e-7;
type Body = {
  id: string;
  p: number[];
  v: number[];
  radius: number;
  invMass: number;
  restitution: number;
  friction: number;
};
const dot = (a: number[], b: number[]) => a.reduce((sum, n, i) => sum + n * b[i]!, 0);
const length = (a: number[]) => Math.hypot(...a);
function impulse(a: Body, b: Body | undefined, normal: number[], restitution: number, friction: number) {
  const inverse = a.invMass + (b?.invMass ?? 0);
  if (!inverse) return;
  const relative = a.v.map((v, i) => v - (b?.v[i] ?? 0));
  const approach = dot(relative, normal);
  if (approach >= 0) return; // separating contact never attracts either body
  const normalImpulse = (-(1 + restitution) * approach) / inverse;
  const tangent = relative.map((v, i) => v - approach * normal[i]!);
  const speed = length(tangent);
  const tangentImpulse = speed ? Math.min(speed / inverse, friction * normalImpulse) : 0;
  const change = normal.map((n, i) => normalImpulse * n - (speed ? (tangentImpulse * tangent[i]!) / speed : 0));
  a.v = a.v.map((v, i) => v + change[i]! * a.invMass);
  if (b) b.v = b.v.map((v, i) => v - change[i]! * b.invMass);
}
function floor(body: Body, floorZ: number) {
  if (!body.invMass) return;
  if (body.p[2]! <= floorZ + body.radius + CONTACT_TOLERANCE) {
    body.p[2] = Math.max(body.p[2]!, floorZ + body.radius);
    impulse(body, undefined, [0, 0, 1], body.restitution, body.friction);
  }
}
function pair(a: Body, b: Body) {
  const delta = a.p.map((p, i) => p - b.p[i]!);
  const distance = length(delta);
  const penetration = a.radius + b.radius - distance;
  if (penetration < -CONTACT_TOLERANCE || (!a.invMass && !b.invMass)) return;
  if (distance < 1e-12) throw new Error("Unresolved coincident sphere contact");
  const normal = delta.map((n) => n / distance),
    inverse = a.invMass + b.invMass;
  if (penetration > 0) {
    a.p = a.p.map((p, i) => p + (normal[i]! * penetration * a.invMass) / inverse);
    b.p = b.p.map((p, i) => p - (normal[i]! * penetration * b.invMass) / inverse);
  }
  impulse(a, b, normal, Math.min(a.restitution, b.restitution), Math.sqrt(a.friction * b.friction));
}
export function bakeSphereContacts(scene: BlenderScene) {
  const physics = scene.physics!;
  const bodies: Body[] = scene.objects
    .filter((o) => o.collider)
    .map((o) => ({
      id: o.id,
      p: [...o.location],
      v: [...o.collider!.velocity],
      radius: o.collider!.radius,
      invMass: o.collider!.kind === "dynamic" ? 1 / o.collider!.mass : 0,
      restitution: o.collider!.restitution,
      friction: o.collider!.friction,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dt = 1 / scene.fps / scene.substeps,
    maxTravel = Math.min(...bodies.map((b) => b.radius)) / 4;
  const states: { frame: number; bodies: { id: string; location: number[]; velocity: number[] }[] }[] = [];
  const check = () => {
    for (const body of bodies) {
      if ([...body.p, ...body.v].some((n) => !Number.isFinite(n) || Math.abs(n) > 100))
        throw new Error("Sphere state exceeds finite bounded domain");
      if (body.p[2]! < physics.floorZ + body.radius - CONTACT_TOLERANCE)
        throw new Error("Unresolved sphere floor penetration");
    }
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!,
          b = bodies[j]!;
        if (length(a.p.map((p, k) => p - b.p[k]!)) < a.radius + b.radius - CONTACT_TOLERANCE)
          throw new Error("Unresolved sphere pair penetration");
      }
  };
  check();
  for (let frame = 0; frame < scene.durationFrames; frame++) {
    if (frame)
      for (let step = 0; step < scene.substeps; step++) {
        const previous = bodies.map((b) => [...b.p]);
        for (const body of bodies)
          if (body.invMass) {
            body.v[2]! -= physics.gravity * dt;
            if (length(body.v) * dt > maxTravel)
              throw new Error("Sphere substep travel exceeds anti-tunneling bound; increase substeps or reduce speed");
            body.p = body.p.map((p, i) => p + body.v[i]! * dt);
          }
        // Refuse a missed grazing passage after closest approach, including an overlapping
        // but nonapproaching endpoint: position correction alone cannot model its impulse.
        for (let i = 0; i < bodies.length; i++)
          for (let j = i + 1; j < bodies.length; j++) {
            const a = bodies[i]!,
              b = bodies[j]!,
              start = previous[i]!.map((p, k) => p - previous[j]![k]!);
            const end = a.p.map((p, k) => p - b.p[k]!),
              travel = end.map((p, k) => p - start[k]!);
            const square = dot(travel, travel),
              t = square ? Math.max(0, Math.min(1, -dot(start, travel) / square)) : 0;
            // Conservative angular tolerance includes exact minimum endpoints and float-roundoff
            // just before them. This refuses unsupported contacts, never invents CCD response.
            const nonapproaching = dot(end, travel) >= -1e-10 * length(end) * length(travel);
            if (
              t > 0 &&
              nonapproaching &&
              length(start.map((p, k) => p + travel[k]! * t)) < a.radius + b.radius - CONTACT_TOLERANCE
            )
              throw new Error(
                "Swept sphere passage exceeds discrete contact resolution; increase substeps or change trajectory",
              );
          }
        for (let iteration = 0; iteration < physics.iterations; iteration++) {
          for (const body of bodies) floor(body, physics.floorZ);
          for (let i = 0; i < bodies.length; i++)
            for (let j = i + 1; j < bodies.length; j++) pair(bodies[i]!, bodies[j]!);
        }
        for (const body of bodies) floor(body, physics.floorZ);
        check();
      }
    states.push({ frame, bodies: bodies.map((b) => ({ id: b.id, location: [...b.p], velocity: [...b.v] })) });
  }
  return states;
}
