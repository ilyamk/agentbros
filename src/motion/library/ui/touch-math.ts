export type TouchKind = "tap" | "long" | "swipe";

/** One touch in the captured screen's CSS pixels; the block multiplies by the capture scale. */
export type Touch = {
  /** Frame of contact. */
  at: number;
  kind: TouchKind;
  x: number;
  y: number;
  /** Frames the finger stays down: a tap's press, a long press's hold, a swipe's travel. */
  hold: number;
  /** Swipe end point, CSS pixels. */
  toX?: number;
  toY?: number;
};

/** Frames the dot takes to appear before contact and to leave after release. */
export const TOUCH_APPEAR = 3;
export const TOUCH_RELEASE = 8;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Point of a touch at a frame, in CSS pixels: a swipe travels on an ease-in-out, everything else stays put. */
export const touchPoint = (frame: number, touch: Touch): { x: number; y: number } => {
  if (touch.kind !== "swipe" || touch.toX === undefined || touch.toY === undefined) return { x: touch.x, y: touch.y };
  const t = easeInOut(clamp01((frame - touch.at) / Math.max(1, touch.hold)));
  return { x: touch.x + (touch.toX - touch.x) * t, y: touch.y + (touch.toY - touch.y) * t };
};

export type TouchState = {
  x: number;
  y: number;
  opacity: number;
  scale: number;
  tail: { x: number; y: number } | null;
};

/**
 * The dot at a frame, or null when it is not on screen. It fades in over the last frames before contact, is pressed
 * (scale 0.9) while the finger is down, and fades out with a slight lift on release. No ring: craft rules.
 */
export const touchState = (frame: number, touch: Touch): TouchState | null => {
  const release = touch.at + Math.max(1, touch.hold);
  if (frame < touch.at - TOUCH_APPEAR || frame >= release + TOUCH_RELEASE) return null;
  const point = touchPoint(frame, touch);
  const appear = easeOut(clamp01((frame - (touch.at - TOUCH_APPEAR)) / TOUCH_APPEAR));
  const press = easeOut(clamp01((frame - touch.at) / 3));
  const leave = easeOut(clamp01((frame - release) / TOUCH_RELEASE));
  const opacity = appear * (1 - leave);
  const scale = 1.08 - 0.08 * appear - 0.1 * press * (1 - leave) + 0.12 * leave;
  const moving = touch.kind === "swipe" && frame > touch.at && frame <= release;
  const tail = moving ? touchPoint(Math.max(touch.at, frame - 5), touch) : null;
  return { ...point, opacity, scale, tail };
};

export const touchCues = (touches: readonly Touch[]) =>
  touches.map((touch, i) => ({
    frame: touch.at,
    kind: "click" as const,
    sfx: touch.kind === "swipe" ? ("whoosh" as const) : ("click" as const),
    weight: "support" as const,
    label: `${touch.kind} ${i + 1}`,
  }));

/** The part of a `capture:app` manifest this needs: click events carry CSS-pixel coordinates. */
export type CaptureLog = {
  fps: number;
  scale: number;
  events: readonly { frame: number; action: string; x?: number; y?: number }[];
};

/**
 * Taps from a capture's click log, at the film's frame rate and shifted by `offset` frames. Coordinates stay in CSS
 * pixels: pass `scale={capture.scale}` to the block. The log has no long presses or swipes: key those by hand.
 */
export const tapsFromCapture = (
  capture: CaptureLog,
  options: { fps?: number; offset?: number; hold?: number } = {},
): Touch[] => {
  const fps = options.fps ?? 30;
  return capture.events
    .filter((event) => event.action === "click" && event.x !== undefined && event.y !== undefined)
    .map((event) => ({
      at: Math.round((event.frame * fps) / capture.fps) + (options.offset ?? 0),
      kind: "tap" as const,
      x: event.x!,
      y: event.y!,
      hold: options.hold ?? 5,
    }));
};
