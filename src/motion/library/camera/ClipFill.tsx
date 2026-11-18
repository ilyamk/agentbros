import React from "react";
import { Video } from "@remotion/media";
import { AbsoluteFill, staticFile } from "remotion";
import { z } from "zod";

export const clipFillSchema = z.object({
  /** The clip: a `staticFile` name or a URL. */
  src: z.string(),
  /** Source frames skipped at the start (at the composition's fps). */
  trimBefore: z.number().int().min(0),
  playbackRate: z.number().positive(),
  /** Volume of the sharp copy; the blurred copy is always muted. */
  volume: z.number().min(0).max(1),
  /** Size of the sharp copy relative to fitting the frame whole (1 = contain). */
  scale: z.number().positive().max(1),
  blur: z.number().min(0),
  /** How much the blurred fill is darkened, 0..1. */
  dim: z.number().min(0).max(1),
});

export type ClipFillProps = z.infer<typeof clipFillSchema>;
export const CLIP_FILL_FRAMES = 60;

export const clipFillDefaults: ClipFillProps = {
  src: "shared/3d/plates/hero-turntable.mp4",
  trimBefore: 0,
  playbackRate: 1,
  volume: 1,
  scale: 1,
  blur: 48,
  dim: 0.45,
};

const resolve = (src: string) => (/^(https?:|data:|\/)/.test(src) ? src : staticFile(src));

/**
 * A clip whose orientation differs from the frame (a phone's portrait clip in a landscape film, a landscape clip in a
 * vertical one) shown whole over a blurred, darkened copy of itself instead of black bars. Both copies share trim
 * and rate, so they stay in step.
 */
export const ClipFill: React.FC<ClipFillProps> = (props) => {
  const src = resolve(props.src);
  const shared = { src, trimBefore: props.trimBefore || undefined, playbackRate: props.playbackRate };
  return (
    <AbsoluteFill style={{ background: "#0b0b0d", overflow: "hidden" }}>
      <AbsoluteFill style={{ filter: `blur(${props.blur}px) brightness(${1 - props.dim})`, transform: "scale(1.15)" }}>
        <Video {...shared} muted objectFit="cover" style={{ width: "100%", height: "100%" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: `${props.scale * 100}%`, height: `${props.scale * 100}%` }}>
          <Video {...shared} volume={props.volume} objectFit="contain" style={{ width: "100%", height: "100%" }} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
