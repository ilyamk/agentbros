import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { glyphShapePhases, scatterOffset } from "../../text-modes";
import { splitGraphemes } from "../../text-split";
import type { Cue } from "../types";
import { FACE_NAMES, faceRun, faceStyle } from "./faces";
import { useTextWidths } from "./fit";
import { Stage, useSafeArea } from "./Stage";

export const glyphToShapeSchema = z.object({
  /** A short word whose letter becomes the shape it names: "line", "lift", "Iris". */
  text: z.string().min(1),
  /** Index of the glyph that becomes the stroke (best a letter with an upright stem: l, i, I, 1). */
  keep: z.number().int().nonnegative(),
  face: z.enum(FACE_NAMES),
  /** Word width as a share of the safe width (nowakdesign: a small word, about 0.18 of the width). */
  width: z.number().min(0.08).max(0.9),
  /** Gradient across the word and the stroke, left to right (or top to bottom on the stroke); one colour for flat. */
  colours: z.array(z.string()).min(1).max(3),
  /** "transparent" lays it over footage. */
  ground: z.string(),
  /** Frame the word is on whole. */
  at: z.number().int().nonnegative(),
  /** Phases in frames (nowakdesign 3.0-3.9 s): hold 5, scatter 4, fade 3, stand alone and lengthen 6, turn and extend 6 (power2.out). */
  hold: z.number().int().min(0).max(60),
  scatter: z.number().int().min(1).max(20),
  fade: z.number().int().min(1).max(20),
  grow: z.number().int().min(1).max(30),
  turn: z.number().int().min(1).max(30),
  /** Stroke length after the lengthen phase, times the glyph's own height. */
  growTo: z.number().min(1).max(4),
  /** Final length as a share of the frame height (0.46) and angle off vertical in degrees, clockwise (35). */
  length: z.number().min(0.1).max(1.2),
  angle: z.number().min(-90).max(90),
  /** Stroke width as a share of the type size. */
  stroke: z.number().min(0.02).max(0.4),
  /** Frames from the block's start to the cut onto the next shot; defaults to the frame the shape completes. */
  seamFrame: z.number().int().nonnegative().optional(),
  seed: z.string(),
  grain: z.number().min(0).max(0.2),
});

export type GlyphToShapeProps = z.infer<typeof glyphToShapeSchema>;

const timing = (p: GlyphToShapeProps) => ({
  at: p.at,
  hold: p.hold,
  scatter: p.scatter,
  fade: p.fade,
  grow: p.grow,
  turn: p.turn,
});

/** The frame the shape completes: the match cut's seam unless `seamFrame` says otherwise. */
export const glyphToShapeSeam = (p: GlyphToShapeProps): number => p.seamFrame ?? glyphShapePhases(0, timing(p)).seam;

const CAP = 0.72;

/**
 * A word breaks apart and one of its letters becomes the shape it names: the word holds, the other letters scatter and
 * fade, the kept glyph's box is handed to a stroke that stands alone and lengthens, then turns and extends across the
 * frame on a decelerating ease, ready for a match cut onto the shape it now is.
 */
export const GlyphToShape: React.FC<GlyphToShapeProps> = (p) => {
  const frame = useCurrentFrame();
  const { width: W, height: H } = useVideoConfig();
  const safe = useSafeArea();
  const set = faceStyle(p.face);
  const shown = set.textTransform === "uppercase" ? p.text.toUpperCase() : p.text;
  const glyphs = splitGraphemes(shown);
  const keep = Math.min(p.keep, glyphs.length - 1);
  const runs = [
    faceRun(p.face, p.text),
    { ...faceRun(p.face, p.text), text: glyphs.slice(0, keep).join("") || " " },
    { ...faceRun(p.face, p.text), text: glyphs[keep]! },
  ];
  const measured = useTextWidths(runs, 100);
  if (measured === null || frame < p.at)
    return (
      <Stage background={p.ground} grain={p.grain}>
        {null}
      </Stage>
    );

  const [word100, prefix100, glyph100] = measured as [number, number, number];
  const size = Math.min(safe.height * 0.3, (safe.width * p.width * 100) / Math.max(word100, 1));
  const phase = glyphShapePhases(frame, timing(p));
  const handed = phase.grow > 0 || frame >= p.at + p.hold + p.scatter + p.fade;
  const stemGradient = p.colours.length > 1 ? `linear-gradient(180deg, ${p.colours.join(", ")})` : p.colours[0]!;

  // Where the kept glyph's stem stands, in frame px: the word is centred, its baseline about 0.36 em below centre.
  const wordLeft = W / 2 - (word100 * size) / 200;
  const stemX = wordLeft + ((keep === 0 ? 0 : prefix100) + glyph100 / 2) * (size / 100);
  const stemCentreY = H / 2 + size * (0.5 - 0.15 - CAP / 2);
  const glyphH = CAP * size;
  const grownH = glyphH * (1 + (p.growTo - 1) * phase.grow);
  const length = grownH + (p.length * H - grownH) * phase.turn;
  const x = stemX + (W / 2 - stemX) * phase.grow;
  const y = stemCentreY + (H / 2 - stemCentreY) * phase.grow;
  const thick = Math.max(2, p.stroke * size);

  return (
    <Stage background={p.ground} grain={p.grain}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            ...set,
            textTransform: undefined,
            fontSize: size,
            lineHeight: 1,
            whiteSpace: "pre",
            display: "flex",
          }}
        >
          {glyphs.map((glyph, i) => {
            const kept = i === keep;
            const off = kept ? { x: 0, y: 0 } : scatterOffset(i, p.seed);
            const opacity = kept ? (handed ? 0 : 1) : 1 - phase.fade;
            const colour =
              p.colours[
                Math.min(
                  p.colours.length - 1,
                  Math.floor((i / Math.max(1, glyphs.length - 1)) * (p.colours.length - 1) + 0.5),
                )
              ]!;
            return (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  color: colour,
                  opacity,
                  transform: `translate(${off.x * phase.scatter}em, ${off.y * phase.scatter}em)`,
                }}
              >
                {glyph}
              </span>
            );
          })}
        </div>
      </AbsoluteFill>
      {handed ? (
        <div
          style={{
            position: "absolute",
            left: x - thick / 2,
            top: y - length / 2,
            width: thick,
            height: length,
            borderRadius: thick / 2,
            background: stemGradient,
            transform: `rotate(${p.angle * phase.turn}deg)`,
            transformOrigin: "50% 50%",
          }}
        />
      ) : null}
    </Stage>
  );
};

export const glyphToShapeDefaults: GlyphToShapeProps = {
  text: "line",
  keep: 0,
  face: "grotesk",
  width: 0.2,
  colours: ["#F0569A", "#A04BEF"],
  ground: "#050505",
  at: 2,
  hold: 5,
  scatter: 4,
  fade: 3,
  grow: 6,
  turn: 6,
  growTo: 1.6,
  length: 0.46,
  angle: 35,
  stroke: 0.1,
  seed: "glyph-to-shape",
  grain: 0.03,
};

export const glyphToShapeCues = (p: GlyphToShapeProps): Cue[] => [
  { frame: p.at, kind: "cut", sfx: "none", weight: "support", label: "word on" },
  { frame: p.at + p.hold, kind: "hit", sfx: "whoosh", weight: "support", label: "letters scatter" },
  { frame: glyphToShapeSeam(p), kind: "cut", sfx: "impact", weight: "hero", label: "shape complete: match cut" },
];
