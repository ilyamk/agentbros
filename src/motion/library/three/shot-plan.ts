import { Box3, CatmullRomCurve3, Matrix4, Quaternion, Vector3, type Object3D } from "three";
import { z } from "zod";
import { easeInOut, fitDistance, mix, ramp } from "./shared";

const xyz = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const frame = z.number().int().nonnegative();
const localModel = z
  .string()
  .regex(/^projects\/[a-z0-9][a-z0-9_-]*\/(?:[\w.-]+\/)*[\w.-]+\.glb$/i)
  .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."), "Use a local project GLB path");

export const shotModelSchema = z
  .object({
    src: localModel,
    yaw: z.number().min(-180).max(180).optional(),
    offset: xyz.optional(),
  })
  .strict();

export const shotCameraSchema = z
  .object({
    points: z.array(xyz).min(2).max(8),
    target: xyz,
    targetEnd: xyz.optional(),
    startFrame: frame,
    endFrame: frame,
  })
  .strict()
  .refine(({ startFrame, endFrame }) => startFrame < endFrame, "End frame must follow start frame");

const clipSchema = z
  .object({ name: z.string().min(1), startFrame: frame, endFrame: frame })
  .strict()
  .refine(({ startFrame, endFrame }) => startFrame < endFrame, "End frame must follow start frame");
const highlightSchema = z
  .object({ node: z.string().min(1), startFrame: frame, endFrame: frame })
  .strict()
  .refine(({ startFrame, endFrame }) => startFrame < endFrame, "End frame must follow start frame");
const glassSchema = z
  .object({
    startFrame: frame,
    endFrame: frame,
    roughness: z.number().min(0).max(1).default(0.34),
    control: z.boolean().default(false),
  })
  .strict()
  .refine(({ startFrame, endFrame }) => startFrame < endFrame, "End frame must follow start frame");

export const modelShotSchema = z
  .object({
    model: shotModelSchema.optional(),
    durationInFrames: z.number().int().min(2).default(150),
    background: z.string().default("#080f19"),
    accent: z.string().default("#65edce"),
    fill: z.number().min(0.3).max(0.9).default(0.78),
    orbitDegrees: z.number().min(0).max(180).default(44),
    camera: shotCameraSchema.optional(),
    clip: clipSchema.optional(),
    highlights: z.array(highlightSchema).max(16).optional(),
    glass: glassSchema.optional(),
  })
  .strict()
  .superRefine((props, context) => {
    const events = [
      ...(props.camera ? [{ event: props.camera, path: ["camera"] }] : []),
      ...(props.clip ? [{ event: props.clip, path: ["clip"] }] : []),
      ...(props.glass ? [{ event: props.glass, path: ["glass"] }] : []),
      ...(props.highlights?.map((event, index) => ({ event, path: ["highlights", index] })) ?? []),
    ];
    for (const { event, path } of events) {
      if (event.endFrame >= props.durationInFrames) {
        context.addIssue({ code: "custom", path, message: "End frame must be inside the shot" });
      }
    }
  });

export const assemblySchema = z
  .object({
    groupCount: z.number().int().min(1).max(8).default(3),
    unitsPerGroup: z.number().int().min(1).max(24).default(8),
    seed: z.string().min(1).default("cell-modules"),
    durationInFrames: z.number().int().min(72).default(180),
    background: z.string().default("#0c1021"),
    accent: z.string().default("#84b3ff"),
  })
  .strict();

export type ModelShotProps = z.infer<typeof modelShotSchema>;
export type AssemblyProps = z.infer<typeof assemblySchema>;
export type ShotCamera = z.infer<typeof shotCameraSchema>;
type XYZ = z.infer<typeof xyz>;

export function modelFit(object: Object3D) {
  const bounds = new Box3().setFromObject(object, true);
  const centre = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const largest = Math.max(size.x, size.y, size.z);
  if (bounds.isEmpty() || !Number.isFinite(largest) || largest <= 0) {
    throw new Error("The GLB has no finite, visible geometry to frame.");
  }
  const scale = 2.7 / largest;
  return { centre, scale, size: size.multiplyScalar(scale) };
}

export function modelDistance(size: Vector3, aspect: number, fill: number, yaw: number, fov: number) {
  const sin = Math.abs(Math.sin(yaw));
  const cos = Math.abs(Math.cos(yaw));
  const width = size.x * cos + size.z * sin;
  const depth = size.x * sin + size.z * cos;
  return fitDistance(aspect, width, size.y + depth * 0.21, fov, fill) + depth * 0.55;
}

export function cameraCurve(points: ShotCamera["points"]) {
  return new CatmullRomCurve3(points.map((point) => new Vector3(...point)));
}

export function cameraPose(camera: ShotCamera, curve: CatmullRomCurve3, frame: number, distance: number) {
  const t = easeInOut(ramp(frame, camera.startFrame, camera.endFrame));
  const position = curve.getPointAt(t).multiplyScalar(distance).toArray();
  const target: XYZ = [
    mix(camera.target[0], camera.targetEnd?.[0] ?? camera.target[0], t),
    mix(camera.target[1], camera.targetEnd?.[1] ?? camera.target[1], t),
    mix(camera.target[2], camera.targetEnd?.[2] ?? camera.target[2], t),
  ];
  return { position, target };
}

export function cameraOrientation(
  position: readonly [number, number, number],
  target: readonly [number, number, number],
) {
  const view = new Matrix4().lookAt(new Vector3(...position), new Vector3(...target), new Vector3(0, 1, 0));
  return new Quaternion().setFromRotationMatrix(view).toArray();
}

export const clipTime = (frame: number, action: { startFrame: number; endFrame: number }, seconds: number) =>
  ramp(frame, action.startFrame, action.endFrame) * seconds;

export const assemblyCues = ({ groupCount, durationInFrames }: AssemblyProps) =>
  Array.from({ length: groupCount }, (_, index) => Math.round(durationInFrames * (0.34 + (0.4 * index) / groupCount)));
