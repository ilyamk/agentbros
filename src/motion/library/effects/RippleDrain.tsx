import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { displayFont } from "../../../lib/fonts";
import { DEMO, DemoSceneB } from "../transitions/demo";
import type { Cue } from "../types";
import { ripple } from "./contact-math";

export type RippleDrainOptions = {
  /** Frame (relative to the wrapper) at which the first ring leaves the origin. */
  drainAt: number;
  /** The flood that covers the frame until it drains. */
  flood: string;
  /** Two tints alternated between the rings, lightest first reads best. */
  tints: [string, string];
  /** Origin as shares of the frame: put it on the element that caused the flood. */
  originX: number;
  originY: number;
  rings: number;
  /** Frames between rings and frames for one ring to cross the frame. */
  staggerFrames: number;
  ringFrames: number;
};

const annulusMask = (cx: number, cy: number, inner: number, outer: number): React.CSSProperties => {
  const mask = `radial-gradient(circle at ${cx}px ${cy}px, transparent ${inner}px, #000 ${inner + 0.5}px, #000 ${outer}px, transparent ${outer + 0.5}px)`;
  return { maskImage: mask, WebkitMaskImage: mask };
};

/** Frame at which the last ring has crossed the frame and the next scene is whole. */
export const rippleDrainDone = ({
  drainAt,
  rings,
  staggerFrames,
  ringFrames,
}: Pick<RippleDrainOptions, "drainAt" | "rings" | "staggerFrames" | "ringFrames">): number =>
  drainAt + (rings - 1) * staggerFrames + ringFrames;

/**
 * A flood that ends on the next scene without a wipe: rings leave one point, the flood stays outside
 * the first, the tints alternate between them, and `children` (the next scene) shows inside the last.
 */
export const RippleDrain: React.FC<
  RippleDrainOptions & { children: React.ReactNode; floodContent?: React.ReactNode }
> = ({ children, floodContent, drainAt, flood, tints, originX, originY, rings, staggerFrames, ringFrames }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const cx = originX * width;
  const cy = originY * height;
  const rMax =
    Math.max(
      Math.hypot(cx, cy),
      Math.hypot(width - cx, cy),
      Math.hypot(cx, height - cy),
      Math.hypot(width - cx, height - cy),
    ) + 2;
  const { r, done } = ripple(frame / fps, drainAt / fps, {
    n: rings,
    stagger: staggerFrames / fps,
    dur: ringFrames / fps,
    rMax,
  });
  return (
    <AbsoluteFill>
      {children}
      {done ? null : (
        <>
          {r.slice(0, -1).map((outer, k) => (
            <AbsoluteFill key={k} style={{ backgroundColor: tints[k % 2], ...annulusMask(cx, cy, r[k + 1], outer) }} />
          ))}
          <AbsoluteFill style={{ backgroundColor: flood, ...annulusMask(cx, cy, r[0], rMax * 2) }}>
            {floodContent}
          </AbsoluteFill>
        </>
      )}
    </AbsoluteFill>
  );
};

export const rippleDrainSchema = z.object({
  drainAt: z.number().int().min(0),
  flood: z.string(),
  tints: z.tuple([z.string(), z.string()]),
  originX: z.number().min(0).max(1),
  originY: z.number().min(0).max(1),
  rings: z.number().int().min(2).max(6),
  staggerFrames: z.number().int().min(1).max(15),
  ringFrames: z.number().int().min(12).max(60),
  word: z.string(),
});

export type RippleDrainProps = z.infer<typeof rippleDrainSchema>;

export const RIPPLE_DRAIN_FRAMES = 96;

export const rippleDrainCues = (
  p: Pick<RippleDrainOptions, "drainAt" | "rings" | "staggerFrames" | "ringFrames">,
): Cue[] => [
  { frame: p.drainAt, kind: "reveal", sfx: "whoosh", weight: "hero", label: "flood starts to drain" },
  { frame: rippleDrainDone(p), kind: "land", sfx: "none", weight: "support", label: "next scene whole" },
];

export const RippleDrainPreview: React.FC<RippleDrainProps> = ({ word, ...options }) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  return (
    <RippleDrain
      {...options}
      floodContent={
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <div
            style={{
              fontFamily: displayFont,
              fontWeight: 700,
              fontSize: 200 * u,
              letterSpacing: -6 * u,
              color: DEMO.chalk,
            }}
          >
            {word}
          </div>
        </AbsoluteFill>
      }
    >
      <DemoSceneB ground={DEMO.paper} ink={DEMO.ink} />
    </RippleDrain>
  );
};
