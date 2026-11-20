/**
 * Turn a solved camera sidecar (OpenCV world-to-camera K/R/t per plate frame, written by `camera:solve`)
 * into a Vork camera node and its per-frame animation tracks, so 3D elements render through the plate's camera.
 *
 * Frames the solve left unsolved (listed in the solve report) are extrapolated at constant velocity from the
 * two nearest solved frames, instead of holding a frozen pose that would make inserts slide.
 */
import { normaliseCamera } from "../vork/camera";

export type SolvedSidecar = {
  K: number[][];
  image_size: [number, number];
  fps: number;
  frame_start?: number;
  dist?: number[];
  frames: { R: number[][]; t: number[] }[];
};

export type Pose = { translation: number[]; rotation: number[]; time: number };

export type VorkCameraOptions = {
  /** Plate frames without a solved pose (from solve-report.json `missingFrames`). */
  missing?: number[];
  /** Sensor width in millimetres used to express the focal length as a lens; default 36. */
  sensorWidthMm?: number;
  /** Camera node name; default "camera". */
  name?: string;
  /** Depth of field: per-frame focus distance in metres (one per plate frame) and an f-stop. */
  dof?: { focus: number[]; fstop: number; blades?: number };
  clipStart?: number;
  clipEnd?: number;
};

function normalise(q: number[]): number[] {
  const length = Math.hypot(...q);
  return q.map((value) => value / length);
}

/** Constant-velocity extrapolation of a pose from two solved neighbours a (nearer) and b. */
function extrapolate(a: Pose, b: Pose, steps: number, time: number): Pose {
  const translation = a.translation.map((value, i) => value + (value - b.translation[i]!) * steps);
  // keep the quaternions in one hemisphere before differencing
  const sign = a.rotation.reduce((sum, value, i) => sum + value * b.rotation[i]!, 0) < 0 ? -1 : 1;
  const rotation = normalise(a.rotation.map((value, i) => value + (value - sign * b.rotation[i]!) * steps));
  return { translation, rotation, time };
}

/** Per-frame Vork poses (Y-up, camera looking down -Z) with unsolved frames extrapolated. */
export function solvedPoses(sidecar: SolvedSidecar, missing: number[] = []): Pose[] {
  const camera = normaliseCamera(sidecar, sidecar.fps);
  const poses = camera.frames.map((frame) => ({ ...frame }) as Pose);
  const lost = new Set(missing);
  const solved = poses.map((_, i) => i).filter((i) => !lost.has(i));
  if (solved.length < 2) throw new Error("A camera needs at least two solved frames");
  for (const index of missing) {
    const before = solved.filter((i) => i < index);
    const after = solved.filter((i) => i > index);
    const [a, b] =
      before.length >= 2 && (after.length < 2 || index - before.at(-1)! <= after[0]! - index)
        ? [before.at(-1)!, before.at(-2)!]
        : [after[0]!, after[1]!];
    poses[index] = extrapolate(poses[a]!, poses[b]!, Math.abs(index - a), poses[index]!.time);
  }
  return poses;
}

/** A Vork camera node, its named optics material (add `materials` to `scene.materials`) and animation tracks that reproduce the solved plate camera frame for frame. */
export function vorkCamera(sidecar: SolvedSidecar, options: VorkCameraOptions = {}) {
  const name = options.name ?? "camera";
  const sensor = options.sensorWidthMm ?? 36;
  const [width, height] = sidecar.image_size;
  const fx = sidecar.K[0]![0]!;
  const lens = (fx * sensor) / width;
  const poses = solvedPoses(sidecar, options.missing ?? []);
  const inputs: Record<string, unknown> = {
    lens,
    sensor_width: sensor,
    sensor_height: (sensor * height) / width,
    fit: "horizontal",
    clip_start: options.clipStart ?? 0.01,
    clip_end: options.clipEnd ?? 1000,
  };
  if (options.dof) {
    inputs.use_dof = true;
    inputs.aperture_fstop = options.dof.fstop;
    inputs.focus_distance = options.dof.focus[0];
    if (options.dof.blades) inputs.aperture_blades = options.dof.blades;
  }
  // Camera optics are material inputs; Vork keys them only on a named scene material (["materials", name, ...]).
  const optics = `${name}-optics`;
  const materials = { [optics]: { program: "std/camera", inputs } };
  const node = {
    type: "camera",
    name,
    translation: poses[0]!.translation,
    rotation: poses[0]!.rotation,
    material: optics,
  };
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const tracks: Record<string, unknown>[] = [
    {
      path: ["nodes", name, "translation"],
      interpolation: "LINEAR",
      keys: poses.map((pose) => [round(pose.time), pose.translation.map(round)]),
    },
    {
      path: ["nodes", name, "rotation"],
      interpolation: "LINEAR",
      keys: poses.map((pose) => [round(pose.time), pose.rotation.map((value) => Math.round(value * 1e9) / 1e9)]),
    },
  ];
  if (options.dof) {
    tracks.push({
      path: ["materials", optics, "inputs", "focus_distance"],
      interpolation: "LINEAR",
      keys: options.dof.focus.map((focus, i) => [round(poses[i]!.time), round(focus)]),
    });
  }
  return { node, materials, tracks, lens, poses, fx, size: [width, height] as [number, number] };
}
