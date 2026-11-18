import { interpolate, spring, Easing } from "remotion";

/** Fade in from 0 to 1 over given frames */
export function fadeIn(frame: number, durationFrames: number): number {
  return interpolate(frame, [0, durationFrames], [0, 1], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.out(Easing.quad),
  });
}

/** Fade out from 1 to 0 starting at `startFrame` */
export function fadeOut(frame: number, startFrame: number, durationFrames: number): number {
  return interpolate(frame, [startFrame, startFrame + durationFrames], [1, 0], {
    extrapolateRight: "clamp",
    extrapolateLeft: "clamp",
    easing: Easing.in(Easing.quad),
  });
}

/** Slide up entrance with spring physics */
export function slideUp(frame: number, fps: number, delay = 0): number {
  const progress = spring({ frame, fps, delay, config: { damping: 200 } });
  return interpolate(progress, [0, 1], [60, 0]);
}

/** Scale entrance with spring bounce */
export function scaleIn(frame: number, fps: number, delay = 0, bouncy = false): number {
  return spring({
    frame,
    fps,
    delay,
    config: bouncy ? { damping: 8 } : { damping: 200 },
  });
}

/** Staggered delay for list items */
export function stagger(index: number, fps: number, intervalSec = 0.1): number {
  return Math.round(index * intervalSec * fps);
}
