import { interpolate, spring } from "remotion";
import type { PanelEntrance } from "./types";

export type EntranceStyle = {
  opacity: number;
  transform?: string;
  clipPath?: string;
};

/**
 * Returns inline style values for the three entrance modes.
 *
 * fade  — opacity 0→1 over 12 frames
 * scale — spring scale 0.85→1.0 + opacity 0→1 over 6 frames
 * clip  — opacity fade over 6 frames + clip-path reveals left-to-right
 *         (inset right edge: 100%→0%)
 */
export function useEntranceStyle(frame: number, fps: number, entrance: PanelEntrance = "fade"): EntranceStyle {
  switch (entrance) {
    case "fade": {
      const opacity = interpolate(frame, [0, 12], [0, 1], {
        extrapolateRight: "clamp",
        extrapolateLeft: "clamp",
      });
      return { opacity };
    }

    case "scale": {
      const sc = spring({
        frame,
        fps,
        config: { damping: 200, stiffness: 100 },
        durationInFrames: 20,
      });
      const opacity = interpolate(frame, [0, 6], [0, 1], {
        extrapolateRight: "clamp",
        extrapolateLeft: "clamp",
      });
      const scale = interpolate(sc, [0, 1], [0.85, 1.0]);
      return { opacity, transform: `scale(${scale})` };
    }

    case "clip": {
      const opacity = interpolate(frame, [0, 6], [0, 1], {
        extrapolateRight: "clamp",
        extrapolateLeft: "clamp",
      });
      // Right edge shrinks from 100% to 0%, revealing content left-to-right
      const rightInset = interpolate(frame, [0, 20], [100, 0], {
        extrapolateRight: "clamp",
        extrapolateLeft: "clamp",
      });
      return {
        opacity,
        clipPath: `inset(0 ${rightInset}% 0 0)`,
      };
    }
  }
}
