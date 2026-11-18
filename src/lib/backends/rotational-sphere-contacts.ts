import type { BlenderScene } from "./blender-scene";

/** Owned discrete solid-sphere impulses. World spin, isotropic inertia, no native dynamics. */
export const ROTATIONAL_SPHERE_SOLVER = "avc-solid-sphere-contacts-v2" as const;
export const MAX_ANGULAR_SPEED = 100;
export const MAX_ROTATION_STEP = 0.25;
const MAX_KINETIC_ENERGY = 1e9;
export const CONTACT_TOLERANCE = 1e-7;
export type SolidSphereBody = {
  id: string;
  p: number[];
  v: number[];
  radius: number;
  invMass: number;
  restitution: number;
  friction: number;
  w: number[];
  q: number[];
  inertia: number;
  invInertia: number;
};
const dot = (a: number[], b: number[]) => a.reduce((sum, n, i) => sum + n * b[i]!, 0);
const length = (a: number[]) => Math.hypot(...a);
const cross = (a: number[], b: number[]) => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
const scale = (a: number[], k: number) => a.map((n) => n * k);
const add = (a: number[], b: number[]) => a.map((n, i) => n + b[i]!);
const multiply = (a: number[], b: number[]) => [
  a[0]! * b[0]! - dot(a.slice(1), b.slice(1)),
  ...add(add(scale(b.slice(1), a[0]!), scale(a.slice(1), b[0]!)), cross(a.slice(1), b.slice(1))),
];
const normalize = (q: number[]) => {
  const n = length(q);
  if (!Number.isFinite(n) || n < 1e-12) throw new Error("Invalid sphere orientation");
  return scale(q, 1 / n);
};
/** Blender XYZ Euler: local X then Y then Z, quaternion scalar first. */
export function quaternionFromEulerXYZ(rotation: number[]) {
  const axes = rotation.map((angle, i) => [
    Math.cos(angle / 2),
    ...[0, 1, 2].map((k) => (k === i ? Math.sin(angle / 2) : 0)),
  ]);
  return normalize(multiply(axes[2]!, multiply(axes[1]!, axes[0]!)));
}
function integrateOrientation(body: SolidSphereBody, dt: number) {
  const speed = length(body.w);
  if (speed * dt > MAX_ROTATION_STEP)
    throw new Error("Sphere angular substep exceeds rotation bound; increase substeps or reduce spin");
  if (speed)
    body.q = normalize(
      multiply([Math.cos((speed * dt) / 2), ...scale(body.w, Math.sin((speed * dt) / 2) / speed)], body.q),
    );
}
const kinetic = (body: SolidSphereBody) =>
  body.invMass ? dot(body.v, body.v) / (2 * body.invMass) + (body.inertia * dot(body.w, body.w)) / 2 : 0;
function applyImpulse(body: SolidSphereBody, offset: number[], change: number[]) {
  body.v = add(body.v, scale(change, body.invMass));
  body.w = add(body.w, scale(cross(offset, change), body.invInertia));
}
/** Trusted internal contact kernel; callers supply validated bodies and a unit radial normal. */
export function resolveSolidSphereImpulse(
  a: SolidSphereBody,
  b: SolidSphereBody | undefined,
  normal: number[],
  restitution: number,
  friction: number,
) {
  const inverse = a.invMass + (b?.invMass ?? 0);
  if (!inverse) return;
  const ra = scale(normal, -a.radius),
    rb = b ? scale(normal, b.radius) : [0, 0, 0];
  const other = b ? add(b.v, cross(b.w, rb)) : [0, 0, 0];
  const relative = add(a.v, cross(a.w, ra)).map((v, i) => v - other[i]!);
  const approach = dot(relative, normal);
  if (approach >= 0) return; // separating contact never attracts
  const before = kinetic(a) + (b ? kinetic(b) : 0);
  const normalImpulse = (-(1 + restitution) * approach) / inverse; // radial normal creates no spin
  const tangent = relative.map((v, i) => v - approach * normal[i]!);
  const speed = length(tangent);
  const effective = inverse + a.radius ** 2 * a.invInertia + (b ? b.radius ** 2 * b.invInertia : 0);
  const tangentImpulse = speed ? Math.min(speed / effective, friction * normalImpulse) : 0;
  const change = normal.map((n, i) => normalImpulse * n - (speed ? (tangentImpulse * tangent[i]!) / speed : 0));
  applyImpulse(a, ra, change);
  if (b) applyImpulse(b, rb, scale(change, -1));
  const after = kinetic(a) + (b ? kinetic(b) : 0);
  if (!Number.isFinite(after) || after > before + 1e-8 * Math.max(1, before))
    throw new Error("Sphere contact increased kinetic energy");
}
function floor(body: SolidSphereBody, floorZ: number) {
  if (!body.invMass) return;
  if (body.p[2]! <= floorZ + body.radius + CONTACT_TOLERANCE) {
    body.p[2] = Math.max(body.p[2]!, floorZ + body.radius);
    resolveSolidSphereImpulse(body, undefined, [0, 0, 1], body.restitution, body.friction);
  }
}
function pair(a: SolidSphereBody, b: SolidSphereBody) {
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
  resolveSolidSphereImpulse(a, b, normal, Math.min(a.restitution, b.restitution), Math.sqrt(a.friction * b.friction));
}
export function bakeRotationalSphereContacts(scene: BlenderScene) {
  if (scene.physics?.solver !== ROTATIONAL_SPHERE_SOLVER)
    throw new Error("Rotational bake requires explicit v2 solver");
  const physics = scene.physics;
  const bodies: SolidSphereBody[] = scene.objects
    .filter((o) => o.collider)
    .map((o) => ({
      id: o.id,
      p: [...o.location],
      v: [...o.collider!.velocity],
      radius: o.collider!.radius,
      invMass: o.collider!.kind === "dynamic" ? 1 / o.collider!.mass : 0,
      restitution: o.collider!.restitution,
      friction: o.collider!.friction,
      w: [...(o.collider!.angularVelocity ?? [0, 0, 0])],
      q: quaternionFromEulerXYZ(o.rotation),
      inertia: 0.4 * o.collider!.mass * o.collider!.radius ** 2,
      invInertia: o.collider!.kind === "dynamic" ? 1 / (0.4 * o.collider!.mass * o.collider!.radius ** 2) : 0,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dt = 1 / scene.fps / scene.substeps,
    maxTravel = Math.min(...bodies.map((b) => b.radius)) / 4;
  const states: {
    frame: number;
    bodies: {
      id: string;
      location: number[];
      velocity: number[];
      angularVelocity: number[];
      orientation: number[];
      inertia: number;
    }[];
  }[] = [];
  const check = () => {
    for (const body of bodies) {
      if ([...body.p, ...body.v, ...body.w].some((n) => !Number.isFinite(n) || Math.abs(n) > 100))
        throw new Error("Sphere state exceeds finite bounded domain");
      if (length(body.w) > MAX_ANGULAR_SPEED || kinetic(body) > MAX_KINETIC_ENERGY)
        throw new Error("Sphere angular speed or kinetic energy exceeds bounded domain");
      if (Math.abs(length(body.q) - 1) > 1e-10) throw new Error("Sphere orientation is not normalized");
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
        for (const body of bodies) if (body.invMass) integrateOrientation(body, dt);
      }
    states.push({
      frame,
      bodies: bodies.map((b) => ({
        id: b.id,
        location: [...b.p],
        velocity: [...b.v],
        angularVelocity: [...b.w],
        orientation: [...b.q],
        inertia: b.inertia,
      })),
    });
  }
  return states;
}

/** Read-only native transform proof, not a dynamics/visual-motion approval. */
export function verifyRotationalReadback(
  input: unknown,
  expected: { frame: number; objects: { id: string; orientation?: number[]; rotation?: number[] }[] },
) {
  if (!input || typeof input !== "object") throw new Error("Invalid native rotational readback");
  const record = input as { frame?: unknown; objects?: unknown };
  const objects = expected.objects.filter((o) => o.orientation);
  if (
    !objects.length ||
    record.frame !== expected.frame ||
    !Array.isArray(record.objects) ||
    record.objects.length !== objects.length
  )
    throw new Error("Native rotational readback frame/count mismatch");
  const seen = new Set<string>();
  for (const value of record.objects) {
    if (!value || typeof value !== "object") throw new Error("Invalid native rotational transform");
    const obj = value as {
      id: string;
      mode: unknown;
      orientation: unknown;
      initialEulerOrientation?: unknown;
      basis: unknown;
    };
    const state = objects.find((o) => o.id === obj.id);
    if (!state || seen.has(obj.id) || obj.mode !== "QUATERNION")
      throw new Error("Native rotational readback ID/mode mismatch");
    seen.add(obj.id);
    const [w, x, y, z] = state.orientation!;
    // Matrix row-major, positive uniform scale removed from each column.
    const basis = [
      1 - 2 * (y! ** 2 + z! ** 2),
      2 * (x! * y! - z! * w!),
      2 * (x! * z! + y! * w!),
      2 * (x! * y! + z! * w!),
      1 - 2 * (x! ** 2 + z! ** 2),
      2 * (y! * z! - x! * w!),
      2 * (x! * z! - y! * w!),
      2 * (y! * z! + x! * w!),
      1 - 2 * (x! ** 2 + y! ** 2),
    ];
    if (state.rotation) {
      const initial = quaternionFromEulerXYZ(state.rotation);
      const actual = obj.initialEulerOrientation;
      if (
        !Array.isArray(actual) ||
        actual.length !== 4 ||
        ![1, -1].some((sign) =>
          actual.every(
            (n, i) => typeof n === "number" && Number.isFinite(n) && Math.abs(n - sign * initial[i]!) <= 3e-6,
          ),
        )
      )
        throw new Error("Native initial Euler convention mismatch");
    }
    const orientation = state.orientation!;
    // Blender can choose either representative of the same unit quaternion.
    const sign =
      Array.isArray(obj.orientation) &&
      obj.orientation.length === 4 &&
      obj.orientation.every(
        (n, i) => typeof n === "number" && Number.isFinite(n) && Math.abs(n + orientation[i]!) <= 3e-6,
      )
        ? -1
        : 1;
    for (const [actual, target] of [
      [obj.orientation, orientation.map((n) => n * sign)],
      [obj.basis, basis],
    ] as const) {
      if (
        !Array.isArray(actual) ||
        actual.length !== target.length ||
        actual.some((n, i) => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n - target[i]!) > 3e-6)
      )
        throw new Error("Native rotational quaternion/basis mismatch");
    }
  }
  return record;
}
