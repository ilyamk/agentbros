import test from "node:test";
import assert from "node:assert/strict";
import { bakeBlenderScene, BlenderSceneSchema } from "../src/lib/backends/blender-scene";
import {
  bakeRotationalSphereContacts,
  quaternionFromEulerXYZ,
  ROTATIONAL_SPHERE_SOLVER,
  resolveSolidSphereImpulse,
  verifyRotationalReadback,
} from "../src/lib/backends/rotational-sphere-contacts";
const body = (id: string, location: number[], velocity: number[], extra = {}) => ({
  id,
  shape: "sphere",
  location,
  scale: [0.5, 0.5, 0.5],
  rotation: [0, 0, 0],
  material: { color: [1, 0.2, 0.1] },
  collider: { kind: "dynamic", radius: 0.5, mass: 1, velocity, restitution: 0, friction: 0.5, ...extra },
});
export const rotationalFixture = {
  version: 1,
  width: 128,
  height: 96,
  fps: 30,
  durationFrames: 61,
  frames: [0, 30, 60],
  substeps: 8,
  physics: { solver: ROTATIONAL_SPHERE_SOLVER, gravity: 9.81, iterations: 8 },
  camera: { location: [0, -7, 4], target: [0, 0, 0.5] },
  lights: [{ location: [2, -3, 5], energy: 1000 }],
  objects: [body("ball", [0, 0, 0.5], [2, 0, 0])],
};
const solve = (input: unknown) => bakeRotationalSphereContacts(BlenderSceneSchema.parse(input));
const close = (a: number, b: number, eps = 1e-8) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const energy = (b: ReturnType<typeof solve>[number]["bodies"][number], mass = 1) =>
  (mass * b.velocity.reduce((s, v) => s + v * v, 0)) / 2 +
  (b.inertia * b.angularVelocity.reduce((s, v) => s + v * v, 0)) / 2;
const end = (input: unknown) => solve(input).at(-1)!.bodies;

test("v1 parsed optional field absence and exact complete bake SHA remain unchanged", () => {
  const fixture = {
    version: 1,
    fps: 30,
    durationFrames: 2,
    frames: [0, 1],
    physics: { solver: "avc-sphere-contacts-v1", gravity: 0 },
    camera: { location: [0, -7, 4] },
    lights: [{ location: [2, -3, 5], energy: 1000 }],
    objects: [
      {
        id: "a",
        shape: "sphere",
        location: [0, 0, 1],
        scale: [0.5, 0.5, 0.5],
        material: { color: [1, 0, 0] },
        collider: { kind: "dynamic", radius: 0.5, velocity: [1, 0, 0] },
      },
    ],
  };
  const bake = bakeBlenderScene(fixture);
  assert.equal(bake.sha256, "460f393e8ac2d83492c8d9c0caaf1f9e072af3a67996845901f10808e521696b");
  assert.equal("angularVelocity" in bake.scene.objects[0]!.collider!, false);
  assert.equal("orientation" in bake.data.states[0]!.objects[0]!, false);
  assert.deepEqual(Object.keys(bake.data.contacts![0]!.bodies[0]!), ["id", "location", "velocity"]);
});
test("floor friction converts slip to ideal rolling rather than stopping the center", () => {
  const states = solve(rotationalFixture),
    final = states.at(-1)!.bodies[0]!;
  close(final.velocity[0]!, 10 / 7);
  close(final.angularVelocity[1]!, 20 / 7);
  close(final.velocity[0]! - 0.5 * final.angularVelocity[1]!, 0);
  close(final.inertia, 0.1);
  let previous = energy(states[0]!.bodies[0]!);
  for (const state of states) {
    const b = state.bodies[0]!;
    assert.ok(energy(b) <= previous + 1e-8);
    previous = energy(b);
    close(b.location[2]!, 0.5);
    close(Math.hypot(...b.orientation), 1);
  }
  assert.ok(Math.abs(final.orientation[2]!) > 0.1);
});
test("frictionless floor preserves translation/spin and arbitrary initial orientation", () => {
  const fixture = {
    ...rotationalFixture,
    objects: [
      {
        ...body("ball", [0, 0, 0.5], [2, 0, 0], { friction: 0, angularVelocity: [0, 0, 3] }),
        rotation: [0.3, -0.4, 0.7],
      },
    ],
  };
  const states = solve(fixture),
    b = states.at(-1)!.bodies[0]!;
  close(b.velocity[0]!, 2);
  assert.deepEqual(b.angularVelocity, [0, 0, 3]);
  assert.deepEqual(states[0]!.bodies[0]!.orientation, quaternionFromEulerXYZ([0.3, -0.4, 0.7]));
});
test("world spin integrates exact normalized quaternion and Blender XYZ initial convention", () => {
  const q = quaternionFromEulerXYZ([Math.PI / 2, Math.PI / 2, 0]);
  q.forEach((v, i) => close(v, [0.5, 0.5, 0.5, -0.5][i]!));
  const fixture = {
    ...rotationalFixture,
    physics: { ...rotationalFixture.physics, gravity: 0 },
    objects: [body("ball", [0, 0, 1], [0, 0, 0], { angularVelocity: [0, 0, 3] })],
  };
  const b = end(fixture)[0]!;
  close(b.orientation[0]!, Math.cos(3));
  close(b.orientation[3]!, Math.sin(3));
  const bake = bakeBlenderScene(fixture);
  assert.equal(bake.data.solver, ROTATIONAL_SPHERE_SOLVER);
  assert.deepEqual(bake.data.states.at(-1)!.objects[0]!.orientation, b.orientation);
});
test("oblique radial collision conserves linear momentum, creates friction spin and dissipates energy", () => {
  const fixture = {
    ...rotationalFixture,
    durationFrames: 2,
    frames: [0, 1],
    physics: { ...rotationalFixture.physics, gravity: 0 },
    objects: [
      body("a", [-0.5, 0, 1], [1, 1, 0], { friction: 1 }),
      body("b", [0.5, 0, 1], [-1, -1, 0], { friction: 1 }),
    ],
  };
  const states = solve(fixture),
    [a, b] = states.at(-1)!.bodies;
  for (let k = 0; k < 3; k++) close(a!.velocity[k]! + b!.velocity[k]!, 0);
  assert.ok(Math.abs(a!.angularVelocity[2]!) > 0.1);
  close(a!.angularVelocity[2]!, b!.angularVelocity[2]!);
  assert.ok(energy(a!) + energy(b!) < 2);
  // Angular momentum about origin: orbital + intrinsic. Positional correction is
  // a discrete approximation; evaluate this separated two-body case with tight dt tolerance.
  const momentum = (s: (typeof states)[number]) =>
    s.bodies.reduce(
      (sum, x) =>
        sum + x.location[0]! * x.velocity[1]! - x.location[1]! * x.velocity[0]! + x.inertia * x.angularVelocity[2]!,
      0,
    );
  const drift = Math.abs(momentum(states[0]!) - momentum(states[1]!));
  const dt = 1 / fixture.fps / fixture.substeps,
    reducedMass = 0.5,
    relativeSpeedSquared = 8;
  assert.ok(
    drift > 0 && drift <= reducedMass * relativeSpeedSquared * dt,
    "analytic isolated correction bound μ|vrel|²dt",
  );
  const refined = solve({ ...fixture, substeps: 16 });
  const refinedDrift = Math.abs(momentum(refined[0]!) - momentum(refined[1]!));
  assert.ok(refinedDrift <= (reducedMass * relativeSpeedSquared * dt) / 2);
  assert.ok(refinedDrift < drift, "same physical setup converges as substep halves");
});
test("unequal masses retain normal restitution and conserve momentum without spin for head-on hits", () => {
  const fixture = {
    ...rotationalFixture,
    durationFrames: 31,
    frames: [0, 30],
    physics: { ...rotationalFixture.physics, gravity: 0 },
    objects: [
      body("a", [-1, 0, 1], [2, 0, 0], { mass: 2, restitution: 0.5 }),
      body("b", [1, 0, 1], [-2, 0, 0], { restitution: 0.5 }),
    ],
  };
  const [a, b] = end(fixture);
  close(2 * a!.velocity[0]! + b!.velocity[0]!, 2);
  close(b!.velocity[0]! - a!.velocity[0]!, 2);
  assert.deepEqual(a!.angularVelocity, [0, 0, 0]);
});
test("static body has no linear/angular motion and retains nontrivial orientation", () => {
  const fixed = { ...body("fixed", [1, 0, 1], [0, 0, 0], { kind: "static" }), rotation: [0.3, 0.4, 0.5] };
  const fixture = {
    ...rotationalFixture,
    physics: { ...rotationalFixture.physics, gravity: 0 },
    objects: [body("ball", [-1, 0, 1], [2, 0.1, 0]), fixed],
  };
  for (const state of solve(fixture)) {
    const b = state.bodies.find((b) => b.id === "fixed")!;
    assert.deepEqual(b.location, [1, 0, 1]);
    assert.deepEqual(b.velocity, [0, 0, 0]);
    assert.deepEqual(b.angularVelocity, [0, 0, 0]);
    assert.deepEqual(b.orientation, quaternionFromEulerXYZ(fixed.rotation));
  }
});
test("separating touching spheres never attract or transfer spin without normal load", () => {
  const fixture = {
    ...rotationalFixture,
    durationFrames: 2,
    frames: [0, 1],
    physics: { ...rotationalFixture.physics, gravity: 0 },
    objects: [body("a", [-0.5, 0, 1], [-1, 0, 0], { angularVelocity: [0, 0, 2] }), body("b", [0.5, 0, 1], [1, 0, 0])],
  };
  const [a, b] = end(fixture);
  close(a!.velocity[0]!, -1);
  close(b!.velocity[0]!, 1);
  assert.deepEqual(a!.angularVelocity, [0, 0, 2]);
});
test("fixed-step bake is independent of requested seek and sorted contact enumeration", () => {
  const fixture = {
    ...rotationalFixture,
    objects: [body("a", [-2, 0, 0.5], [1, 0, 0]), body("b", [2, 0, 0.5], [-1, 0, 0])],
  };
  assert.equal(bakeBlenderScene(fixture).sha256, bakeBlenderScene({ ...fixture, frames: [60, 0, 30] }).sha256);
  assert.deepEqual(solve(fixture), solve({ ...fixture, objects: [...fixture.objects].reverse() }));
  assert.notEqual(bakeBlenderScene(fixture).sha256, bakeBlenderScene({ ...fixture, substeps: 16 }).sha256);
});
test("angular fields are refused for legacy/inactive/unknown profiles and fixed spin", () => {
  const objects = [body("ball", [0, 0, 1], [0, 0, 0], { angularVelocity: [0, 0, 0] })];
  for (const physics of [undefined, { solver: "avc-sphere-contacts-v1" }, { solver: "unknown" }])
    assert.throws(() => BlenderSceneSchema.parse({ ...rotationalFixture, physics, objects }));
  for (const extra of [
    { angularVelocity: [101, 0, 0] },
    { angularVelocity: [90, 90, 0] },
    { angularVelocity: [Infinity, 0, 0] },
    { kind: "static", angularVelocity: [0, 0, 1] },
    { inertia: 1 },
    { orientation: [1, 0, 0, 0] },
  ])
    assert.throws(() =>
      BlenderSceneSchema.parse({ ...rotationalFixture, objects: [body("ball", [0, 0, 1], [0, 0, 0], extra)] }),
    );
  assert.throws(() =>
    BlenderSceneSchema.parse({
      ...rotationalFixture,
      fps: 1,
      substeps: 1,
      objects: [body("ball", [0, 0, 1], [0, 0, 0], { angularVelocity: [0, 0, 1] })],
    }),
  );
});
test("v2 preserves overlap/body/state/travel/grazing/packed-contact refusals", () => {
  for (const fixture of [
    { ...rotationalFixture, durationFrames: 302 },
    {
      ...rotationalFixture,
      objects: Array.from({ length: 13 }, (_, i) => body(`b${i}`, [i * 2 - 12, 0, 1], [0, 0, 0])),
    },
    { ...rotationalFixture, objects: [body("a", [0, 0, 1], [0, 0, 0]), body("b", [0.9, 0, 1], [0, 0, 0])] },
  ])
    assert.throws(() => BlenderSceneSchema.parse(fixture));
  const base = {
    ...rotationalFixture,
    durationFrames: 2,
    frames: [0, 1],
    physics: { ...rotationalFixture.physics, gravity: 0 },
  };
  for (const x of [-0.05, -0.1])
    assert.throws(
      () =>
        bakeBlenderScene({
          ...base,
          objects: [
            body("a", [x, 0.9999, 1], [x === -0.05 ? 24 : 26.4, 0, 0]),
            body("b", [0, 0, 1], [0, 0, 0], { kind: "static" }),
          ],
        }),
      /Swept sphere passage/,
    );
  assert.throws(
    () =>
      bakeBlenderScene({
        ...rotationalFixture,
        durationFrames: 301,
        frames: [0, 300],
        physics: { ...rotationalFixture.physics, gravity: 30 },
        objects: [body("ball", [0, 0, 90], [0, 0, 0])],
      }),
    /anti-tunneling/,
  );
  assert.throws(
    () =>
      bakeBlenderScene({
        ...base,
        physics: { ...base.physics, iterations: 1 },
        objects: [
          body("a", [-1, 0, 1], [1, 0, 0]),
          body("b", [0, 0, 1], [0, 0, 0]),
          body("c", [1, 0, 1], [0, 0, 0], { kind: "static" }),
        ],
      }),
    /Unresolved sphere pair penetration/,
  );
});

test("isolated common-contact friction impulse conserves coupled angular and linear momentum exactly", () => {
  const make = (x: number, v: number[]) => ({
    id: "sphere",
    p: [x, 0, 0],
    v,
    w: [0, 0, 0],
    q: [1, 0, 0, 0],
    radius: 0.5,
    inertia: 0.1,
    invInertia: 10,
    invMass: 1,
    friction: 1,
    restitution: 0,
  });
  const a = make(-0.5, [1, 1, 0]),
    b = make(0.5, [-1, -1, 0]);
  const angular = () => a.p[0]! * a.v[1]! + b.p[0]! * b.v[1]! + 0.1 * (a.w[2]! + b.w[2]!);
  const initial = angular();
  resolveSolidSphereImpulse(a, b, [-1, 0, 0], 0, 1);
  close(angular(), initial, 1e-10);
  for (let k = 0; k < 3; k++) close(a.v[k]! + b.v[k]!, 0, 1e-10);
  close(a.v[1]!, 5 / 7);
  close(a.w[2]!, -10 / 7);
  close(b.w[2]!, -10 / 7);
  const kinetic = (o: typeof a) => o.v.reduce((s, n) => s + n * n, 0) / 2 + 0.05 * o.w.reduce((s, n) => s + n * n, 0);
  close(kinetic(a) + kinetic(b), 5 / 7);
});
test("native quaternion and matrix readback verifier rejects vacuous, stale or wrong transforms", () => {
  const expected = {
    frame: 7,
    objects: [{ id: "ball", orientation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], rotation: [0, 0, Math.PI / 2] }],
  };
  const record = {
    frame: 7,
    objects: [
      {
        id: "ball",
        mode: "QUATERNION",
        orientation: expected.objects[0]!.orientation,
        initialEulerOrientation: expected.objects[0]!.orientation,
        basis: [0, -1, 0, 1, 0, 0, 0, 0, 1],
      },
    ],
  };
  assert.doesNotThrow(() => verifyRotationalReadback(record, expected));
  assert.doesNotThrow(() =>
    verifyRotationalReadback(
      { ...record, objects: [{ ...record.objects[0], orientation: expected.objects[0]!.orientation.map((n) => -n) }] },
      expected,
    ),
  );
  assert.throws(() => verifyRotationalReadback({ frame: 7, objects: [] }, { frame: 7, objects: [] }));
  for (const change of [
    { frame: 0 },
    { objects: [] },
    { objects: [...record.objects, ...record.objects] },
    { objects: [{ ...record.objects[0], mode: "XYZ" }] },
    { objects: [{ ...record.objects[0], initialEulerOrientation: [1, 0, 0, 0] }] },
    { objects: [{ ...record.objects[0], id: "other" }] },
    { objects: [{ ...record.objects[0], orientation: [1, 0, 0, 0] }] },
    { objects: [{ ...record.objects[0], basis: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] },
    { objects: [{ ...record.objects[0], basis: [NaN, -1, 0, 1, 0, 0, 0, 0, 1] }] },
  ])
    assert.throws(() => verifyRotationalReadback({ ...record, ...change }, expected));
});

test("contact-point spin transfers energy into translation while reducing total kinetic energy", () => {
  const fixture = {
    ...rotationalFixture,
    objects: [body("ball", [0, 0, 0.5], [0, 0, 0], { angularVelocity: [0, 4, 0] })],
  };
  const states = solve(fixture),
    final = states.at(-1)!.bodies[0]!;
  close(final.velocity[0]!, 4 / 7);
  close(final.angularVelocity[1]!, 8 / 7);
  close(final.velocity[0]! - 0.5 * final.angularVelocity[1]!, 0);
  assert.ok(energy(final) < energy(states[0]!.bodies[0]!));
});
