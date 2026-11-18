import type { PointKeyframe } from "../../timing";

/** Stage of the capture in CSS pixels; the recording is 2x. Page, cursor and capture script share these numbers. */
export const ORDER_STAGE = { width: 1600, height: 900 };
export const ORDER_CAPTURE_FRAMES = 220;

export const PLUS_BUTTON = { x: 1282, y: 262 };
export const BUY_BUTTON = { x: 1208, y: 430 };

export const PLUS_CLICKS = [66, 84] as const;
export const BUY_CLICK = 122;

/** The pointer's hot spot, frame by frame. The capture moves the real mouse here; the film draws its cursor here. */
export const ORDER_CURSOR_KEYS: readonly PointKeyframe[] = [
  { at: 18, x: 760, y: 760 },
  { at: 60, x: PLUS_BUTTON.x, y: PLUS_BUTTON.y, curve: "drift" },
  { at: 92, x: PLUS_BUTTON.x, y: PLUS_BUTTON.y },
  { at: 114, x: BUY_BUTTON.x, y: BUY_BUTTON.y, curve: "drift" },
  { at: 124, x: BUY_BUTTON.x, y: BUY_BUTTON.y },
  { at: 150, x: 1460, y: 650, curve: "drift" },
];
