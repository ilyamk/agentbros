import { layoutSeries } from "../series";

export const WHIP_FRAMES = 9;
export const WHIP_HOLD = 26;
export const CIRCLE_FRAMES = 14;
export const PLAY_HOLD = 46;
export const PLAY_WIPE = 16;
export const PLAY_AFTER = 40;

export const WHIP_LAYOUT = layoutSeries([
  { id: "smaz", frames: WHIP_HOLD },
  { transition: WHIP_FRAMES },
  { id: "schitaetsya", frames: WHIP_HOLD + 2 },
  { transition: WHIP_FRAMES },
  { id: "skorost", frames: WHIP_HOLD + 20 },
]);

export const PLAY_FRAMES = layoutSeries([
  { id: "question", frames: PLAY_HOLD + PLAY_WIPE },
  { transition: PLAY_WIPE },
  { id: "answer", frames: PLAY_WIPE + PLAY_AFTER },
]).totalFrames;

export const REEL_LAYOUT = layoutSeries([
  { id: "poster", frames: 84 },
  { transition: WHIP_FRAMES },
  { id: "whip", frames: WHIP_LAYOUT.totalFrames },
  { id: "beat", frames: 90 },
  { id: "glyph", frames: 66 },
  { id: "weight", frames: 72 },
  { id: "shutter", frames: 56 },
  { id: "camera", frames: 112 },
  { id: "play", frames: PLAY_FRAMES },
  { id: "studio", frames: 130 },
  { transition: CIRCLE_FRAMES },
  { id: "sunrise", frames: 114 },
]);

export const reelFrames = (id: string): number => {
  const scene = REEL_LAYOUT.scenes.find((candidate) => candidate.id === id);
  if (!scene) throw new Error(`No reel scene "${id}".`);
  return scene.frames;
};
