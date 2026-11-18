import React from "react";
import { z } from "zod";
import { whipPan, type WhipDirection } from "../../transitions";
import { TransitionDemo } from "./demo";

export { cutTiming, whipPan } from "../../transitions";

/** The scenes swap at the whip's fastest, blurriest point: the middle of the seam. */
export const WHIP_PAN_PEAK = 0.5;

export const whipPanSchema = z.object({
  /** Frames from the block's start to the perceived cut, for `cues` in a film (sfx:cues places the cut there); the preview keeps its centred seam. */
  seamFrame: z.number().int().min(0).optional(),
  direction: z.enum(["left", "right", "up", "down"]),
  transitionFrames: z.number().int().min(6).max(16),
  /** Blur sigma per pixel of per-frame travel; 0.15 is close to a 180 degree shutter. */
  shutter: z.number().min(0).max(0.4),
  /** Peak smear in pixels; craft rules put a full-frame whip at 15–20. */
  maxBlur: z.number().min(0).max(140),
});

export type WhipPanProps = z.infer<typeof whipPanSchema>;

export const WHIP_PAN_FRAMES = 72;

/** Preview of `whipPan`: both scenes travel as one strip with a speed-matched directional blur. */
export const WhipPanPreview: React.FC<WhipPanProps> = ({ direction, transitionFrames, shutter, maxBlur }) => (
  <TransitionDemo
    presentation={whipPan({ direction: direction as WhipDirection, shutter, maxBlur })}
    transitionFrames={transitionFrames}
    totalFrames={WHIP_PAN_FRAMES}
  />
);
