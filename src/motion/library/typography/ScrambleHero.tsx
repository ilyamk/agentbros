import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { z } from "zod";
import { ScrambleWord } from "../../kinetic-type";
import { caseFlipCount, otherCase } from "../../text-modes";
import { splitGraphemes } from "../../text-split";
import type { Cue } from "../types";
import { FACE_NAMES, faceRun, faceStyle } from "./faces";
import { useTextWidths } from "./fit";
import { Stage, resolveInk, useSafeArea } from "./Stage";

export const scrambleHeroSchema = z.object({
  word: z.string(),
  face: z.enum(FACE_NAMES),
  ink: z.string(),
  ground: z.string(),
  /** Frame the word cuts in, already resolved. */
  at: z.number().int().nonnegative(),
  /** Frame the letters corrupt from the first and resolve together. */
  scrambleAt: z.number().int().nonnegative(),
  /** Frames the scramble lasts. */
  duration: z.number().int().positive(),
  /** Characters the letters pass through. */
  pool: z.string(),
  /** Colour split in pixels at the peak; 0 keeps it clean, as in the references. */
  chroma: z.number().nonnegative(),
  width: z.number().min(0.3).max(1),
  grain: z.number().min(0).max(0.2),
  /**
   * "case": no random glyphs; from `flipAt` each glyph swaps to its other case, and from slanted to upright, on its own
   * frame in reading order, one every `flipStep` frames (gojiberry 14.1-16.9 s: the word flips in about 0.15 s, a letter
   * about every frame at 30 fps). The word is set as written (no forced capitals) and `scrambleAt` is ignored.
   */
  flip: z.enum(["case"]).optional(),
  flipAt: z.number().int().nonnegative().optional(),
  flipStep: z.number().min(0.5).max(12).optional(),
  /** Slant of glyphs not yet flipped, in degrees; 0 flips case only. */
  flipSlant: z.number().min(0).max(30).optional(),
});

export type ScrambleHeroProps = z.infer<typeof scrambleHeroSchema>;

/**
 * A big word on a flat ground whose letters break into code glyphs from the first letter and resolve together: the word
 * shows what it is made of. For "code", "data", "AI" and other words whose material is the point.
 */
export const ScrambleHero: React.FC<ScrambleHeroProps> = (props) => {
  const { word, face, ink, ground, at, scrambleAt, duration, pool, chroma, width, grain } = props;
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const set = faceStyle(face);
  const glyphs = splitGraphemes(word);
  const flipped = glyphs.map(otherCase).join("");
  const plain = { ...faceRun(face, word), text: word };
  const measured = useTextWidths(
    props.flip === "case" ? [plain, { ...plain, text: flipped }] : [faceRun(face, word)],
    100,
  );
  if (measured === null || frame < at)
    return (
      <Stage background={ground} grain={grain}>
        {null}
      </Stage>
    );
  const size = Math.min(
    safe.vertical ? safe.height * 0.3 : safe.height * 0.8,
    (safe.width * width * 100) / Math.max(...measured, 1),
  );
  const text = set.textTransform === "uppercase" ? word.toUpperCase() : word;
  if (props.flip === "case") {
    const count = caseFlipCount(frame, props.flipAt ?? scrambleAt, props.flipStep ?? 1, glyphs.length);
    const slant = props.flipSlant ?? 12;
    return (
      <Stage background={ground} grain={grain}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              ...set,
              textTransform: undefined,
              fontSize: size,
              lineHeight: 0.9,
              color: resolveInk(ink, ground),
              whiteSpace: "pre",
              display: "flex",
            }}
          >
            {glyphs.map((glyph, i) => (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  transform: i < count || slant === 0 ? undefined : `skewX(${-slant}deg)`,
                }}
              >
                {i < count ? otherCase(glyph) : glyph}
              </span>
            ))}
          </div>
        </AbsoluteFill>
      </Stage>
    );
  }
  return (
    <Stage background={ground} grain={grain}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <ScrambleWord
          text={text}
          at={scrambleAt}
          duration={duration}
          pool={pool}
          seed={`scramble-${word}`}
          chroma={chroma}
          style={{ ...set, textTransform: undefined, fontSize: size, lineHeight: 0.9, color: resolveInk(ink, ground) }}
        />
      </AbsoluteFill>
    </Stage>
  );
};

export const scrambleHeroDefaults: ScrambleHeroProps = {
  word: "Code.",
  face: "wide",
  ink: "#0C0C0C",
  ground: "#EF4A2D",
  at: 0,
  scrambleAt: 30,
  duration: 16,
  pool: "{}[]()<>/;:=+*#",
  chroma: 0,
  width: 0.8,
  grain: 0.04,
};

/** gojiberry's answer word: slanted lower case on black, flipping to upright capitals a letter a frame. */
export const scrambleHeroCaseFlipPreset: ScrambleHeroProps = {
  ...scrambleHeroDefaults,
  word: "simple",
  face: "grotesk",
  ink: "#F5F3EE",
  ground: "#050505",
  flip: "case",
  flipAt: 30,
  flipStep: 1,
  flipSlant: 12,
};

export const scrambleHeroCues = (props: ScrambleHeroProps): Cue[] =>
  props.flip === "case"
    ? [
        { frame: props.at, kind: "cut", sfx: "impact", weight: "support" },
        {
          frame: props.flipAt ?? props.scrambleAt,
          kind: "hit",
          sfx: "tick",
          weight: "hero",
          label: "letters flip case",
        },
        {
          frame: Math.round(
            (props.flipAt ?? props.scrambleAt) + (splitGraphemes(props.word).length - 1) * (props.flipStep ?? 1),
          ),
          kind: "land",
          sfx: "none",
          weight: "support",
          label: "word upright",
        },
      ]
    : [
        { frame: props.at, kind: "cut", sfx: "impact", weight: "support" },
        { frame: props.scrambleAt, kind: "hit", sfx: "tick", weight: "hero", label: "letters corrupt" },
        {
          frame: props.scrambleAt + props.duration,
          kind: "land",
          sfx: "none",
          weight: "support",
          label: "word resolves",
        },
      ];
