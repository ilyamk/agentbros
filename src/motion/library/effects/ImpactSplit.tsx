import { measureText } from "@remotion/layout-utils";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { displayFont } from "../../../lib/fonts";
import { FittedLine } from "../../text";
import type { Cue } from "../types";
import { hop, impact, impactSplit, spring } from "./contact-math";

export const impactSplitSchema = z.object({
  text: z.string().min(1),
  /** Frame the subject lands on the headline. */
  hitFrame: z.number().int().min(4),
  /** Frames the subject spends on its arc before the hit. */
  hopFrames: z.number().int().min(6).max(40),
  ground: z.string(),
  ink: z.string(),
  accent: z.string(),
  /** Share of the frame width the headline fills. */
  widthShare: z.number().min(0.3).max(0.95),
  /** Where along the headline the subject lands, 0..1. */
  hitAt: z.number().min(0).max(1),
  fontWeight: z.number().int().min(300).max(900),
});

export type ImpactSplitProps = z.infer<typeof impactSplitSchema>;

export const IMPACT_SPLIT_FRAMES = 96;

export const impactSplitCues = ({ hitFrame, hopFrames }: Pick<ImpactSplitProps, "hitFrame" | "hopFrames">): Cue[] => [
  {
    frame: Math.max(0, hitFrame - hopFrames),
    kind: "reveal",
    sfx: "whoosh",
    weight: "support",
    label: "subject leaves for the headline",
  },
  { frame: hitFrame, kind: "hit", sfx: "impact", weight: "hero", label: "subject lands, glyphs split" },
  { frame: hitFrame + 27, kind: "land", sfx: "tick", weight: "support", label: "glyphs rejoin" },
];

/**
 * A subject (the accent dot) hops onto a headline; the glyphs are pushed apart from the hit, bounce by
 * their distance from it and rejoin while the subject squashes and settles on top. Contact as the event.
 */
export const ImpactSplit: React.FC<ImpactSplitProps> = ({
  text,
  hitFrame,
  hopFrames,
  ground,
  ink,
  accent,
  widthShare,
  hitAt,
  fontWeight,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  const tHit = hitFrame / fps;
  const lineWidth = width * widthShare;
  return (
    <AbsoluteFill style={{ backgroundColor: ground, overflow: "hidden" }}>
      <FittedLine
        text={text}
        withinWidth={lineWidth}
        fontFamily={displayFont}
        fontWeight={fontWeight}
        maxFontSize={height * 0.32}
      >
        {(fontSize) => {
          const measure = (s: string) => measureText({ text: s, fontFamily: displayFont, fontSize, fontWeight }).width;
          const glyphs = [...text];
          const total = measure(text);
          const left = (width - total) / 2;
          const baseline = height / 2;
          const centres = glyphs.map((_, i) => measure(text.slice(0, i)) + measure(glyphs[i]) / 2);
          const cx = total * hitAt;
          const fall = { width: total * 0.55, spread: fontSize * 0.28, bounce: fontSize * 0.3 };
          const appear = Math.min(1, spring(t - 0.05, 0.75, 16));
          const r = fontSize * 0.12;
          const top = baseline - fontSize * 0.42 - r;
          const p = hop(
            t,
            tHit - hopFrames / fps,
            tHit,
            { x: -r * 3 - left, y: top - height * 0.3 },
            { x: cx, y: top },
            fontSize * 0.6,
          );
          const hit = impact(t, tHit, { sqx: 0.3, sqy: 0.36 });
          const before = t < tHit - hopFrames / fps;
          return (
            <>
              {glyphs.map((g, i) => {
                const s = impactSplit(t, tHit, centres[i], cx, fall);
                return (
                  <div
                    key={i}
                    style={{
                      position: "absolute",
                      left: left + measure(text.slice(0, i)),
                      top: baseline - fontSize * 0.5,
                      fontFamily: displayFont,
                      fontWeight,
                      fontSize,
                      lineHeight: 1,
                      color: ink,
                      whiteSpace: "pre",
                      opacity: appear,
                      transform: `translate(${s.dx}px, ${s.dy + (1 - appear) * fontSize * 0.2}px) rotate(${s.rot}rad)`,
                      transformOrigin: "50% 100%",
                    }}
                  >
                    {g}
                  </div>
                );
              })}
              {before ? null : (
                <div
                  style={{
                    position: "absolute",
                    left: left + p.x - r,
                    top: p.y - r,
                    width: r * 2,
                    height: r * 2,
                    borderRadius: "50%",
                    background: accent,
                    transform: `scale(${hit.sx}, ${hit.sy})`,
                    transformOrigin: "50% 100%",
                  }}
                />
              )}
            </>
          );
        }}
      </FittedLine>
    </AbsoluteFill>
  );
};
