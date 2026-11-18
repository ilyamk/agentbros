type Pose = { translation: number[]; rotation: number[]; time?: number };
type Matrix = number[] | number[][];
type CameraFrame = Partial<Pose> & { R?: Matrix; t?: number[]; K?: Matrix; dist?: number[]; image_size?: number[] };
function matrix(value: Matrix | undefined): number[] {
  if (!Array.isArray(value)) throw new Error("A 3x3 camera matrix is required");
  const flat = value.flat();
  if (flat.length !== 9 || !flat.every(Number.isFinite)) throw new Error("A finite 3x3 camera matrix is required");
  return flat;
}
/** Convert the documented OpenCV world-to-camera sidecar to Vork Y-up camera poses. */
export function opencvPose(rotation: Matrix, translation: number[]): Pose {
  const r = matrix(rotation),
    t = translation;
  if (translation.length !== 3 || !translation.every(Number.isFinite)) throw new Error("Invalid OpenCV extrinsics");
  const dot = (a: number, b: number) => [0, 1, 2].reduce((sum, i) => sum + r[a * 3 + i]! * r[b * 3 + i]!, 0);
  const determinant =
    r[0]! * (r[4]! * r[8]! - r[5]! * r[7]!) -
    r[1]! * (r[3]! * r[8]! - r[5]! * r[6]!) +
    r[2]! * (r[3]! * r[7]! - r[4]! * r[6]!);
  if (
    Math.abs(determinant - 1) > 1e-4 ||
    [0, 1, 2].some((a) => [0, 1, 2].some((b) => Math.abs(dot(a, b) - Number(a === b)) > 1e-4))
  )
    throw new Error("Camera rotation must be orthonormal");
  const position = [0, 1, 2].map((i) => -(r[i]! * t[0]! + r[i + 3]! * t[1]! + r[i + 6]! * t[2]!));
  const m = [r[0]!, -r[3]!, -r[6]!, r[1]!, -r[4]!, -r[7]!, r[2]!, -r[5]!, -r[8]!];
  let x: number, y: number, z: number, w: number;
  const trace = m[0]! + m[4]! + m[8]!;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m[7]! - m[5]!) / s;
    y = (m[2]! - m[6]!) / s;
    z = (m[3]! - m[1]!) / s;
  } else if (m[0]! > m[4]! && m[0]! > m[8]!) {
    const s = Math.sqrt(1 + m[0]! - m[4]! - m[8]!) * 2;
    w = (m[7]! - m[5]!) / s;
    x = s / 4;
    y = (m[1]! + m[3]!) / s;
    z = (m[2]! + m[6]!) / s;
  } else if (m[4]! > m[8]!) {
    const s = Math.sqrt(1 + m[4]! - m[0]! - m[8]!) * 2;
    w = (m[2]! - m[6]!) / s;
    x = (m[1]! + m[3]!) / s;
    y = s / 4;
    z = (m[5]! + m[7]!) / s;
  } else {
    const s = Math.sqrt(1 + m[8]! - m[0]! - m[4]!) * 2;
    w = (m[3]! - m[1]!) / s;
    x = (m[2]! + m[6]!) / s;
    y = (m[5]! + m[7]!) / s;
    z = s / 4;
  }
  const q = [x, y, z, w],
    length = Math.hypot(...q);
  if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-4) throw new Error("Camera rotation must be orthonormal");
  return { translation: position, rotation: q.map((n) => n / length) };
}
export function normaliseCamera(input: unknown, fps: number) {
  const raw = input as {
    frames: CameraFrame[];
    K: Matrix;
    R?: Matrix;
    t?: number[];
    image_size: number[];
    dist?: number[];
    fps?: number | string;
    frame_start?: number;
  };
  if (
    !raw ||
    !Array.isArray(raw.frames) ||
    !raw.K ||
    !raw.image_size ||
    raw.image_size.length !== 2 ||
    raw.dist?.some((n) => n !== 0)
  )
    throw new Error("A calibrated undistorted camera sidecar is required");
  const k = matrix(raw.K);
  const parts = typeof raw.fps === "string" ? raw.fps.split("/").map(Number) : undefined;
  const sourceFps = parts ? parts[0]! / (parts[1] ?? 1) : (raw.fps ?? fps);
  if (
    typeof sourceFps !== "number" ||
    !Number.isFinite(sourceFps) ||
    Math.abs(sourceFps - fps) > 1e-5 ||
    (raw.frame_start !== undefined && (!Number.isInteger(raw.frame_start) || raw.frame_start !== 0))
  )
    throw new Error("Camera sidecar clock must match the plate FPS and start at frame zero");
  if (k[0]! <= 0 || Math.abs(k[0]! - k[4]!) > 1e-4 || [1, 3, 6, 7].some((i) => Math.abs(k[i]!) > 1e-6) || k[8] !== 1)
    throw new Error("The pinhole route requires square pixels and zero skew");
  const frames = raw.frames.map((frame, i) => {
    if (
      (frame.K && JSON.stringify(matrix(frame.K)) !== JSON.stringify(k)) ||
      (frame.image_size && JSON.stringify(frame.image_size) !== JSON.stringify(raw.image_size)) ||
      frame.dist?.some((n) => n !== 0)
    )
      throw new Error("Changing camera intrinsics need an explicit authored camera route");
    const pose =
      frame.translation && frame.rotation
        ? (frame as Pose)
        : opencvPose(frame.R ?? raw.R ?? [], frame.t ?? raw.t ?? []);
    if (
      pose.translation.length !== 3 ||
      pose.rotation.length !== 4 ||
      ![...pose.translation, ...pose.rotation].every(Number.isFinite) ||
      Math.abs(Math.hypot(...pose.rotation) - 1) > 1e-4
    )
      throw new Error("Invalid camera pose");
    return { ...pose, time: frame.time ?? i / fps };
  });
  if (frames.some((frame, i) => !Number.isFinite(frame.time) || (i > 0 && frame.time <= frames[i - 1]!.time)))
    throw new Error("Camera times must increase");
  return { K: k, image_size: raw.image_size, frames };
}

/** Project a world point through the same Y-up camera; used only for an authored contact approximation. */
export function projectPoint(point: number[], pose: Pose, k: number[], size: number[]): [number, number] {
  const [x, y, z, w] = pose.rotation as [number, number, number, number];
  const r = [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
  const delta = point.map((value, i) => value - pose.translation[i]!);
  const local = [0, 1, 2].map((i) => [0, 1, 2].reduce((sum, j) => sum + r[j * 3 + i]! * delta[j]!, 0));
  if (local[2]! >= -0.001) throw new Error("Contact plane must be in front of the camera");
  return [
    ((k[0]! * local[0]!) / -local[2]! + k[2]!) / size[0]!,
    ((-k[4]! * local[1]!) / -local[2]! + k[5]!) / size[1]!,
  ];
}
