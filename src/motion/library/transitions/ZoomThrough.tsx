import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill, Easing, useVideoConfig } from "remotion";
import { z } from "zod";
import { curves } from "../../timing";

/** Accelerating exit from design-reference/craft-rules.md. */
const EXIT_EASE = Easing.bezier(0.6, 0, 0.9, 0.35);

export type SourceRect = { x: number; y: number; width: number; height: number };
import { TransitionDemo } from "./demo";

type ZoomThroughOptions = {
  /** Point the camera flies into, as a fraction of the frame (0..1). Put it on the element the eye already holds. */
  originX: number;
  originY: number;
  /** Scale the outgoing scene reaches before it is gone. */
  depth: number;
  /** Peak gaussian blur in pixels, at the moment of the swap. */
  maxBlur: number;
  /** Ghost copies trailing the outgoing scene, a cheap radial streak. 0 turns them off; each costs one render. */
  trail: number;
  /** Optional on-screen object in frame pixels that causes the move; its centre overrides `originX`/`originY`. */
  source?: SourceRect;
};

/** Share of the seam spent leaving; the incoming scene replaces it on this frame with no crossfade (`peakAt`). */
export const ZOOM_THROUGH_PEAK = 0.6;
const EXIT_END = ZOOM_THROUGH_PEAK;

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

const ZoomThroughPresentation: React.FC<TransitionPresentationComponentProps<ZoomThroughOptions>> = ({
  children,
  presentationProgress: p,
  presentationDirection,
  passedProps,
}) => {
  const { width, height } = useVideoConfig();
  const { depth, maxBlur, trail, source } = passedProps;
  const originX = source ? (source.x + source.width / 2) / width : passedProps.originX;
  const originY = source ? (source.y + source.height / 2) / height : passedProps.originY;
  const origin = `${originX * 100}% ${originY * 100}%`;
  if (presentationDirection === "exiting") {
    if (p <= 0) return <AbsoluteFill>{children}</AbsoluteFill>;
    if (p >= EXIT_END) return null;
    const t = clamp01(p / EXIT_END);
    const push = EXIT_EASE(t);
    // Exponential scale keeps the apparent speed of the push growing evenly, like a dolly through a doorway.
    const scale = depth ** push;
    const blur = maxBlur * push;
    const ghosts = Array.from({ length: push > 0.05 ? trail : 0 }, (_, i) => i + 1);
    return (
      <AbsoluteFill>
        <AbsoluteFill
          style={{
            transform: `scale(${scale})`,
            transformOrigin: origin,
            filter: blur > 0.3 ? `blur(${blur}px)` : undefined,
          }}
        >
          {children}
        </AbsoluteFill>
        {ghosts.map((i) => (
          <AbsoluteFill
            key={i}
            style={{
              transform: `scale(${scale * (1 + 0.09 * i * push)})`,
              transformOrigin: origin,
              filter: `blur(${blur * (1 + i * 0.5)}px)`,
              opacity: (0.42 / i) * push,
            }}
          >
            {children}
          </AbsoluteFill>
        ))}
      </AbsoluteFill>
    );
  }
  if (p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  if (p < EXIT_END) return null;
  const t = clamp01((p - EXIT_END) / (1 - EXIT_END));
  const land = curves.expoOut(t);
  // Lands from slightly inside the next scene, so the frame is always full and the push reads as one move;
  // its blur is a third of the exit's so the first incoming frame is already legible.
  const scale = 1 + 0.22 * (1 - land);
  const blur = maxBlur * 0.35 * (1 - land);
  return (
    <AbsoluteFill
      style={{
        transform: `scale(${scale})`,
        transformOrigin: origin,
        filter: blur > 0.3 ? `blur(${blur}px)` : undefined,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/** Flies into a point of the outgoing scene and lands the next one out of the same depth. Pair with `cutTiming(14..20)`. */
export const zoomThrough = ({
  originX = 0.5,
  originY = 0.5,
  depth = 7,
  maxBlur = 18,
  trail = 0,
  source,
}: Partial<ZoomThroughOptions> = {}): TransitionPresentation<ZoomThroughOptions> => ({
  component: ZoomThroughPresentation,
  props: { originX, originY, depth, maxBlur, trail, source },
});

export const zoomThroughSchema = z.object({
  /** Frames from the block's start to the perceived cut, for `cues` in a film (sfx:cues places the cut there); the preview keeps its centred seam. */
  seamFrame: z.number().int().min(0).optional(),
  originX: z.number().min(0).max(1),
  originY: z.number().min(0).max(1),
  depth: z.number().min(1.5).max(20),
  maxBlur: z.number().min(0).max(80),
  trail: z.number().int().min(0).max(4),
  transitionFrames: z.number().int().min(8).max(30),
});

export type ZoomThroughProps = z.infer<typeof zoomThroughSchema>;

export const ZOOM_THROUGH_FRAMES = 84;

export const ZoomThroughPreview: React.FC<ZoomThroughProps> = ({ transitionFrames, ...options }) => (
  <TransitionDemo
    presentation={zoomThrough(options)}
    transitionFrames={transitionFrames}
    totalFrames={ZOOM_THROUGH_FRAMES}
  />
);
