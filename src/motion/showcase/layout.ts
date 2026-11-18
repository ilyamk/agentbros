import { layoutSeries } from "../series";

/** No licensed track exists, so the grid is chosen: 100 BPM makes every beat a whole 18 frames at 30 fps. */
export const BPM = 100;
export const BEAT = 18;
export const WHIP = 9;
export const WIPE = 18;

const beats = (n: number): number => n * BEAT;

/** A scene with a transition out runs on underneath it, so its still hold is `frames` minus both transitions. */
export const SHOWCASE_LAYOUT = layoutSeries([
  { id: "shelf", frames: beats(19) },
  { transition: WHIP },
  { id: "monday", frames: beats(1) + WHIP },
  { id: "tuesday", frames: beats(1) },
  { id: "wednesday", frames: beats(1) },
  { id: "thursday", frames: beats(7) },
  { id: "order", frames: beats(12) },
  { transition: WIPE },
  { id: "roast", frames: 90 },
  { id: "pour", frames: beats(7) },
  { transition: WHIP },
  { id: "ending", frames: beats(7) + WHIP },
]);

export const sceneFrames = (id: string): number => {
  const scene = SHOWCASE_LAYOUT.scenes.find((candidate) => candidate.id === id);
  if (!scene) throw new Error(`No showcase scene "${id}".`);
  return scene.frames;
};
