import { noise2D } from "@remotion/noise";
import { track, type CurveRef } from "./timing";

/** `dolly` moves towards positive depth; `focus` is the depth held sharp. */
export type CameraPose = { x: number; y: number; dolly: number; roll: number; focus: number };

export const STILL_POSE: CameraPose = { x: 0, y: 0, dolly: 0, roll: 0, focus: 0 };

export type Lens = { focal: number; aperture: number; rackScale: number };

export const DEFAULT_LENS: Lens = { focal: 1400, aperture: 0, rackScale: 0 };

/** Screen transform of a layer at `depth` (positive is further away). Pure, so parallax can be tested. */
export const projectLayer = (
  pose: CameraPose,
  depth: number,
  lens: Lens = DEFAULT_LENS,
): { x: number; y: number; scale: number; blur: number } => {
  const distance = Math.max(lens.focal + depth - pose.dolly, 1);
  const perspective = lens.focal / distance;
  const defocus = Math.abs(depth - pose.focus);
  return {
    x: -pose.x * perspective,
    y: -pose.y * perspective,
    scale: perspective * (1 - Math.min(defocus * lens.rackScale, 0.5)),
    blur: defocus * lens.aperture,
  };
};

export type ShakeOptions = { seed: string; amplitude: number; frequency?: number; rollAmplitude?: number };

/** Seeded handheld offset. Smooth in the frame, so it is safe under motion blur's fractional frames. */
export const shake = (
  frame: number,
  { seed, amplitude, frequency = 0.08, rollAmplitude = 0 }: ShakeOptions,
): { x: number; y: number; roll: number } => ({
  x: noise2D(`${seed}-x`, frame * frequency, 0) * amplitude,
  y: noise2D(`${seed}-y`, frame * frequency, 0) * amplitude,
  roll: noise2D(`${seed}-r`, frame * frequency, 0) * rollAmplitude,
});

export type Region = { x: number; y: number; width: number };
export type RegionKeyframe = Region & { at: number; curve?: CurveRef };

/** Frames a region of a stage. Width is tracked in log space, so a zoom reads at constant speed. */
export const regionTransform = (
  frame: number,
  keys: readonly RegionKeyframe[],
  stage: { width: number; height: number },
): { scale: number; x: number; y: number } => {
  const width = Math.exp(
    track(
      frame,
      keys.map(({ at, width: w, curve }) => ({ at, value: Math.log(w), curve })),
    ),
  );
  const scale = stage.width / width;
  const height = stage.height / scale;
  const centreX = track(
    frame,
    keys.map(({ at, x, width: w, curve }) => ({ at, value: x + w / 2, curve })),
  );
  const centreY = track(
    frame,
    keys.map(({ at, y, width: w, curve }) => ({ at, value: y + (w * stage.height) / stage.width / 2, curve })),
  );
  return { scale, x: -(centreX - width / 2) * scale, y: -(centreY - height / 2) * scale };
};
