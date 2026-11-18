import { z } from "zod";
import { digest } from "../jobs/model-artifacts";
import { bakeSphereContacts, SPHERE_CONTACT_SOLVER } from "./sphere-contacts";
import {
  bakeRotationalSphereContacts,
  ROTATIONAL_SPHERE_SOLVER,
  MAX_ANGULAR_SPEED,
  MAX_ROTATION_STEP,
} from "./rotational-sphere-contacts";
const vector = z.tuple([
  z.number().finite().min(-100).max(100),
  z.number().finite().min(-100).max(100),
  z.number().finite().min(-100).max(100),
]);
const color = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
const transform = z
  .object({
    location: vector.default([0, 0, 0]),
    rotation: vector.default([0, 0, 0]),
    scale: vector.refine((v) => v.every((n) => n >= 0.01 && n <= 20), "Scale must be .01–20").default([1, 1, 1]),
  })
  .strict();
const keyframe = transform.extend({ frame: z.number().int().min(0).max(1800) });
const object = transform
  .extend({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
    shape: z.enum(["cube", "sphere", "cylinder", "plane"]),
    material: z
      .object({
        color: color,
        metallic: z.number().min(0).max(1).default(0),
        roughness: z.number().min(0.05).max(1).default(0.5),
      })
      .strict(),
    keyframes: z.array(keyframe).max(32).default([]),
    collider: z
      .object({
        kind: z.enum(["dynamic", "static"]),
        radius: z.number().finite().min(0.01).max(10),
        mass: z.number().finite().min(0.1).max(100).default(1),
        velocity: vector.default([0, 0, 0]),
        angularVelocity: vector.optional(),
        restitution: z.number().finite().min(0).max(0.95).default(0.5),
        friction: z.number().finite().min(0).max(1).default(0.3),
      })
      .strict()
      .optional(),
    motion: z
      .object({
        kind: z.literal("gravity-floor"),
        velocity: vector,
        gravity: z.number().min(0).max(30).default(9.81),
        floorZ: z.number().min(-20).max(20).default(0),
        restitution: z.number().min(0).max(0.95).default(0.5),
        radius: z.number().min(0.01).max(10).default(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export const BlenderSceneSchema = z
  .object({
    physics: z
      .object({
        solver: z.enum([SPHERE_CONTACT_SOLVER, ROTATIONAL_SPHERE_SOLVER]),
        gravity: z.number().finite().min(0).max(30).default(9.81),
        floorZ: z.number().finite().min(-20).max(20).default(0),
        iterations: z.number().int().min(1).max(8).default(4),
      })
      .strict()
      .optional(),
    version: z.literal(1),
    width: z.number().int().min(16).max(2048).default(512),
    height: z.number().int().min(16).max(2048).default(512),
    fps: z.number().int().min(1).max(60).default(30),
    durationFrames: z.number().int().min(1).max(1801),
    frames: z.array(z.number().int().min(0).max(1800)).min(1).max(120),
    objects: z.array(object).min(1).max(24),
    camera: z
      .object({
        location: vector,
        target: vector.default([0, 0, 0]),
        lens: z.number().min(10).max(200).default(50),
        keyframes: z
          .array(z.object({ frame: z.number().int().min(0).max(1800), location: vector, target: vector }))
          .max(32)
          .default([]),
      })
      .strict(),
    lights: z
      .array(
        z
          .object({
            location: vector,
            target: vector.default([0, 0, 0]),
            color: color.default([1, 1, 1]),
            energy: z.number().min(0).max(5000),
            size: z.number().min(0.1).max(20).default(4),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    background: color.default([0.04, 0.04, 0.04]),
    substeps: z.number().int().min(1).max(16).default(8),
  })
  .strict()
  .superRefine((scene, context) => {
    const error = (message: string) => context.addIssue({ code: "custom", message });
    if (new Set(scene.frames).size !== scene.frames.length || scene.frames.some((f) => f >= scene.durationFrames))
      error("Frames must be unique and inside duration");
    if (new Set(scene.objects.map((o) => o.id)).size !== scene.objects.length) error("Duplicate object IDs");
    const validKeys = (keys: { frame: number }[]) =>
      keys.every((k, i) => k.frame < scene.durationFrames && (i === 0 || k.frame > keys[i - 1]!.frame));
    if (!validKeys(scene.camera.keyframes)) error("Camera keyframes must be increasing and inside duration");
    if (
      scene.camera.location.every((n, i) => n === scene.camera.target[i]) ||
      scene.camera.keyframes.some((k) => k.location.every((n, i) => n === k.target[i]))
    )
      error("Camera location and target must differ");
    for (const o of scene.objects) {
      if (!validKeys(o.keyframes)) error(`Invalid keyframes for ${o.id}`);
      if (o.motion && (o.keyframes.length || o.shape === "plane" || o.location[2] < o.motion.floorZ + o.motion.radius))
        error(`Motion requires non-plane object above floor and no keyframes: ${o.id}`);
    }
    const colliders = scene.objects.filter((o) => o.collider);
    for (const o of colliders)
      if (o.collider!.angularVelocity !== undefined && scene.physics?.solver !== ROTATIONAL_SPHERE_SOLVER)
        error(`Angular velocity requires explicit rotational solver: ${o.id}`);
    if (!scene.physics && colliders.length) error("Colliders require explicit sphere-contact solver");
    if (scene.physics) {
      if (!colliders.length || colliders.length > 12 || scene.durationFrames > 301)
        error("Sphere solver requires 1–12 colliders and at most 301 states");
      if (scene.objects.some((o) => o.motion)) error("Legacy motion cannot be mixed with sphere solver");
      const dt = 1 / scene.fps / scene.substeps,
        minimumRadius = Math.min(...colliders.map((o) => o.collider!.radius));
      for (const o of colliders) {
        const c = o.collider!;
        if (o.shape !== "sphere" || o.keyframes.length || o.scale.some((n) => n !== c.radius))
          error(`Collider must be uniformly scaled sphere without keyframes: ${o.id}`);
        if (o.location[2] < scene.physics.floorZ + c.radius) error(`Collider starts below floor: ${o.id}`);
        if (scene.physics.solver === ROTATIONAL_SPHERE_SOLVER && c.angularVelocity) {
          const speed = Math.hypot(...c.angularVelocity);
          if (speed > MAX_ANGULAR_SPEED || speed * dt > MAX_ROTATION_STEP)
            error(`Angular velocity exceeds bounded rotational substep: ${o.id}`);
          if (c.kind === "static" && speed !== 0) error(`Static collider cannot have angular velocity: ${o.id}`);
        }
        if (c.kind === "static" && c.velocity.some((n) => n !== 0))
          error(`Static collider cannot have velocity: ${o.id}`);
        if (c.kind === "dynamic" && (Math.hypot(...c.velocity) + scene.physics.gravity * dt) * dt > minimumRadius / 4)
          error(`Collider speed exceeds substep anti-tunneling bound: ${o.id}`);
      }
      for (let i = 0; i < colliders.length; i++)
        for (let j = i + 1; j < colliders.length; j++) {
          const a = colliders[i]!,
            b = colliders[j]!;
          if (Math.hypot(...a.location.map((n, k) => n - b.location[k]!)) < a.collider!.radius + b.collider!.radius)
            error(`Initial sphere overlap: ${a.id}/${b.id}`);
        }
    }
    if (scene.width * scene.height * scene.frames.length > 128 * 1024 * 1024) error("Capture pixel budget exceeded");
  });
export type BlenderScene = z.infer<typeof BlenderSceneSchema>;
export type SceneState = {
  frame: number;
  objects: { id: string; location: number[]; rotation: number[]; orientation?: number[]; scale: number[] }[];
  camera: { location: number[]; target: number[] };
};
function blend(a: number[], b: number[], t: number) {
  return a.map((n, i) => n + (b[i]! - n) * t);
}
function sample<T extends { frame: number }>(
  keys: T[],
  frame: number,
  fallback: T,
  fields: string[],
): Record<string, number[]> {
  const points = keys[0]?.frame === 0 ? keys : [fallback, ...keys];
  const left = [...points].reverse().find((k) => k.frame <= frame) ?? fallback;
  const right = points.find((k) => k.frame > frame) ?? left;
  const t = right.frame === left.frame ? 0 : (frame - left.frame) / (right.frame - left.frame);
  return Object.fromEntries(
    fields.map((key) => [
      key,
      blend((left as Record<string, unknown>)[key] as number[], (right as Record<string, unknown>)[key] as number[], t),
    ]),
  );
}
/** Owned semi-implicit Euler bake: gravity + horizontal floor only, no Blender rigid-body solver. */
export function bakeBlenderScene(input: unknown) {
  const scene = BlenderSceneSchema.parse(input);
  const states: SceneState[] = [];
  const rotational =
    scene.physics?.solver === ROTATIONAL_SPHERE_SOLVER ? bakeRotationalSphereContacts(scene) : undefined;
  const contacts = rotational ?? (scene.physics ? bakeSphereContacts(scene) : undefined);
  const moving = new Map(
    scene.objects
      .filter((o) => o.motion)
      .map((o) => [o.id, { position: [...o.location], velocity: [...o.motion!.velocity] }]),
  );
  const dt = 1 / scene.fps / scene.substeps;
  for (let frame = 0; frame < scene.durationFrames; frame++) {
    if (frame > 0)
      for (let step = 0; step < scene.substeps; step++)
        for (const o of scene.objects)
          if (o.motion) {
            const state = moving.get(o.id)!;
            state.velocity[2]! -= o.motion.gravity * dt;
            state.position = state.position.map((p, i) => p + state.velocity[i]! * dt);
            const floor = o.motion.floorZ + o.motion.radius;
            if (state.position[2]! < floor) {
              state.position[2] = floor;
              state.velocity[2] = Math.abs(state.velocity[2]!) * o.motion.restitution;
            }
          }
    const objects = scene.objects.map((o) => {
      const values = sample(o.keyframes, frame, { frame: 0, ...o }, ["location", "rotation", "scale"]);
      const orientation = rotational?.[frame]?.bodies.find((b) => b.id === o.id)?.orientation;
      return {
        id: o.id,
        location:
          contacts?.[frame]?.bodies.find((b) => b.id === o.id)?.location.slice() ??
          moving.get(o.id)?.position.slice() ??
          values.location!,
        rotation: values.rotation!,
        ...(orientation ? { orientation: orientation.slice() } : {}),
        scale: values.scale!,
      };
    });
    const camera = sample(scene.camera.keyframes, frame, { frame: 0, ...scene.camera }, ["location", "target"]);
    if (camera.location!.every((n, i) => Math.abs(n - camera.target![i]!) < 1e-8))
      throw new Error("Interpolated camera target is degenerate");
    states.push({ frame, objects, camera: { location: camera.location!, target: camera.target! } });
  }
  const data = {
    version: 1,
    solver: scene.physics?.solver ?? "avc-floor-euler-v1",
    fps: scene.fps,
    substeps: scene.substeps,
    states,
    ...(contacts ? { contacts } : {}),
  };
  return { scene, data, sha256: digest(JSON.stringify(data)) };
}
