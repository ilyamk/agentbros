import React, { useId } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { z } from "zod";
import { hitsDecay } from "../../kinetic-math";
import { DemoSceneB } from "../transitions/demo";
import type { Cue } from "../types";

export type ChromaEdgeSettings = {
  /** Frames where the split flares; it decays over `decay` frames. */
  hits?: readonly number[];
  /** Split at the corners on a hit, in pixels. 4 to 8 is felt; past 12 it reads as a glitch effect. */
  peak?: number;
  /** Split that is always there, in pixels; 0 keeps rest frames clean. */
  idle?: number;
  decay?: number;
  /** Speed of the move it answers (pixels per frame, e.g. `velocity()` of a whip); adds `velocityGain` px per px/frame. */
  velocity?: number;
  velocityGain?: number;
  /** Direction of the split, degrees; 0 pulls red left and blue right. */
  angle?: number;
  /** Share of the radius from the centre that stays clean, 0.3 to 0.8. */
  clean?: number;
};

/** Pixel offset of the red and blue channels at a frame: idle + decaying hit + speed, never below 0. */
export const chromaOffset = (
  frame: number,
  { hits = [], peak = 6, idle = 0, decay = 8, velocity = 0, velocityGain = 0.08 }: ChromaEdgeSettings,
): number => Math.max(0, idle + peak * hitsDecay(frame, hits, decay) + velocityGain * Math.abs(velocity));

const SplitFilter: React.FC<{ id: string; dx: number; dy: number }> = ({ id, dx, dy }) => (
  <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
    <filter id={id} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
      <feOffset in="r" dx={-dx} dy={-dy} result="rs" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
      <feOffset in="b" dx={dx} dy={dy} result="bs" />
      <feBlend in="rs" in2="g" mode="screen" result="rg" />
      <feBlend in="rg" in2="bs" mode="screen" />
    </filter>
  </svg>
);

/**
 * A subtle RGB split on the frame's edges that flares on hits or with the speed of a move and is gone at rest. The
 * centre stays clean behind a radial mask. Renders the children twice: keep `<Audio>` and `<Video>` outside it.
 */
export const ChromaEdge: React.FC<ChromaEdgeSettings & { children: React.ReactNode }> = ({
  children,
  angle = 0,
  clean = 0.5,
  ...settings
}) => {
  const frame = useCurrentFrame();
  const id = `chroma-${useId().replaceAll(":", "")}`;
  const offset = chromaOffset(frame, settings);
  const radians = (angle * Math.PI) / 180;
  const dx = offset * Math.cos(radians);
  const dy = offset * Math.sin(radians);
  const mask = `radial-gradient(ellipse 75% 75% at 50% 50%, transparent ${clean * 100}%, black 100%)`;
  return (
    <AbsoluteFill>
      <AbsoluteFill>{children}</AbsoluteFill>
      {offset > 0.25 ? (
        <>
          <SplitFilter id={id} dx={dx} dy={dy} />
          <AbsoluteFill style={{ filter: `url(#${id})`, maskImage: mask, WebkitMaskImage: mask }}>
            {children}
          </AbsoluteFill>
        </>
      ) : null}
    </AbsoluteFill>
  );
};

export const chromaEdgeSchema = z.object({
  hits: z.array(z.number().int().min(0)),
  peak: z.number().min(0).max(24),
  idle: z.number().min(0).max(6),
  decay: z.number().int().min(1).max(30),
  velocity: z.number(),
  velocityGain: z.number().min(0).max(1),
  angle: z.number().min(-180).max(180),
  clean: z.number().min(0).max(0.95),
});

export type ChromaEdgeProps = z.infer<typeof chromaEdgeSchema>;

export const CHROMA_EDGE_FRAMES = 90;

export const chromaEdgeDefaults: ChromaEdgeProps = {
  hits: [10, 44],
  peak: 9,
  idle: 0,
  decay: 10,
  velocity: 0,
  velocityGain: 0.08,
  angle: 0,
  clean: 0.42,
};

export const chromaEdgeCues = ({ hits }: Pick<ChromaEdgeProps, "hits">): Cue[] =>
  hits.map((frame, i) => ({
    frame,
    kind: "hit",
    sfx: "impact",
    weight: i === hits.length - 1 ? "hero" : "support",
    label: "edge split flares",
  }));

/** Library preview: the split over a white-on-ink statement, flaring on each hit. */
export const ChromaEdgePreview: React.FC<ChromaEdgeProps> = (props) => (
  <ChromaEdge {...props}>
    <DemoSceneB title="Signal lost" />
  </ChromaEdge>
);
