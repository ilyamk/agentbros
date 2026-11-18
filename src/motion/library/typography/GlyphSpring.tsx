import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { MaskedLine } from "../../text";
import { splitGraphemes } from "../../text-split";
import { progress } from "../../timing";
import { useSharedFit } from "./fit";
import { ARRIVE, Stage, useSafeArea } from "./Stage";

export const glyphSpringSchema = z.object({
  lines: z.array(z.string()).min(1),
  /** Used instead of `lines` in vertical format when non-empty. */
  verticalLines: z.array(z.string()),
  /** Empty string: no subline. */
  subline: z.string(),
  color: z.string(),
  muted: z.string(),
  /** The last glyph leans towards this colour; equal to `color` gives flat ink. */
  tint: z.string(),
  background: z.string(),
  fontWeight: z.number().int().min(400).max(900),
  at: z.number(),
  /** Frames between neighbouring glyphs. */
  step: z.number().min(0),
  damping: z.number().positive(),
  stiffness: z.number().positive(),
  /** Upper bound of a glyph's speed blur, in px. */
  blur: z.number().min(0),
});

export type GlyphSpringProps = z.infer<typeof glyphSpringSchema>;

const REST_TRACKING = -0.034;
const OPEN_TRACKING = 0.05;
const LINE_HEIGHT = 0.98;
const TINT_REACH = 0.82;

/** Graphemes that animate, in reading order across every line; spaces do not count. */
export const glyphSpringCount = (lines: readonly string[]): number =>
  lines.reduce((sum, line) => sum + splitGraphemes(line).filter((g) => g.trim() !== "").length, 0);

export const GlyphSpring: React.FC<GlyphSpringProps> = ({
  lines,
  verticalLines,
  subline,
  color,
  muted,
  tint,
  background,
  fontWeight,
  at,
  step,
  damping,
  stiffness,
  blur,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const safe = useSafeArea();
  const rows = safe.vertical && verticalLines.length > 0 ? verticalLines : lines;
  const total = glyphSpringCount(rows);

  const widthShare = safe.vertical ? 0.94 : 0.9;
  const cap = (safe.height * (safe.vertical ? 0.42 : 0.56)) / (rows.length * LINE_HEIGHT);
  const size = useSharedFit(
    rows.map((text) => ({
      text,
      fontFamily: primaryFont,
      fontWeight,
      letterSpacing: `${REST_TRACKING + OPEN_TRACKING}em`,
    })),
    safe.width * widthShare,
    cap,
  );
  const subSize = Math.max(28, (size ?? 0) * 0.2);
  const subFit = useSharedFit([{ text: subline, fontFamily: primaryFont, fontWeight: 500 }], safe.width * 0.9, subSize);

  if (size === null || subFit === null) return <Stage background={background}>{null}</Stage>;

  const lastStart = at + Math.max(total - 1, 0) * step;
  const tracking = REST_TRACKING + OPEN_TRACKING * (1 - progress(frame, at, lastStart - at + 22, ARRIVE));
  const config = { damping, stiffness, mass: 1 };
  const springAt = (start: number, f: number) => (f < start ? 0 : spring({ frame: f - start, fps, config }));

  let index = 0;
  const renderLine = (line: string, row: number) => (
    <div key={row} style={{ whiteSpace: "pre", letterSpacing: `${tracking}em`, lineHeight: LINE_HEIGHT }}>
      {splitGraphemes(line).map((glyph, key) => {
        if (glyph.trim() === "") return <span key={key}>{glyph}</span>;
        const order = index++;
        const start = at + order * step;
        if (frame < start)
          return (
            <span key={key} style={{ display: "inline-block", opacity: 0 }}>
              {glyph}
            </span>
          );
        const s = springAt(start, frame);
        const speed = Math.abs(springAt(start, frame + 1) - s);
        const away = Math.max(0, 1 - s);
        const softness = Math.min(blur, speed * blur * 2.6 + away * blur * 0.35);
        const share = total > 1 ? (order / (total - 1)) * TINT_REACH : 0;
        const ink =
          tint === color ? color : `color-mix(in oklab, ${color} ${((1 - share) * 100).toFixed(1)}%, ${tint})`;
        return (
          <span
            key={key}
            style={{
              display: "inline-block",
              color: ink,
              opacity: Math.min(1, (frame - start) / 4),
              transformOrigin: "50% 88%",
              transform: `translateY(${(1 - s) * 0.36}em) scale(${1 + (1 - s) * 0.16})`,
              filter: softness > 0.3 ? `blur(${softness.toFixed(2)}px)` : undefined,
            }}
          >
            {glyph}
          </span>
        );
      })}
    </div>
  );

  return (
    <Stage background={background}>
      <div
        style={{
          position: "absolute",
          left: safe.side,
          right: safe.side,
          top: safe.top,
          bottom: safe.bottom,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          fontFamily: primaryFont,
        }}
      >
        <div style={{ fontSize: size, fontWeight, color }}>{rows.map(renderLine)}</div>
        {subline.trim() !== "" ? (
          <MaskedLine
            reveal={progress(frame, at + (lastStart - at) * 0.55 + 6, 26, ARRIVE)}
            lineHeight={1.2}
            style={{
              marginTop: size * 0.24,
              fontSize: subFit,
              fontWeight: 500,
              color: muted,
              letterSpacing: "-0.01em",
            }}
          >
            {subline}
          </MaskedLine>
        ) : null}
      </div>
    </Stage>
  );
};

export const glyphSpringDefaults: GlyphSpringProps = {
  lines: ["Light that listens."],
  verticalLines: ["Light that", "listens."],
  subline: "",
  color: "#F3F4F7",
  muted: "rgba(243, 244, 247, 0.58)",
  tint: "#C8D3F5",
  background: "#08090D",
  fontWeight: 700,
  at: 6,
  step: 1.4,
  damping: 16,
  stiffness: 180,
  blur: 12,
};
