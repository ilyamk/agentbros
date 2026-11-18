import React from "react";
import { AbsoluteFill, interpolateColors, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { intentCurves, progress } from "../../timing";
import { pullOutCurve, pullOutScale } from "../../type-track";
import { intendedOverflow } from "../overflow";
import type { Cue } from "../types";
import { FACE_NAMES, faceRun, faceStyle } from "./faces";
import { useTextWidths } from "./fit";
import { Stage, resolveInk } from "./Stage";

export const giantWordPullOutSchema = z.object({
  /** The word that starts too big to read and pulls back to reading size. */
  word: z.string().min(1),
  /** Optional rest of the line, set after the word once it has settled; empty for the word alone. */
  rest: z.string(),
  /** Frame the pull-out starts (the word already fills the frame on this frame). */
  at: z.number().int().nonnegative(),
  /** Frames to settle at 30 fps (14 at 24 fps measured, so 17). */
  frames: z.number().int().min(4).max(60),
  /** Start size as a multiple of the settled size (2.5 measured: the word overflows both edges). */
  from: z.number().min(1.2).max(8),
  /** Settled width of the word as a share of the frame width (0.43 measured; 0.4-0.6 reads). */
  width: z.number().min(0.15).max(0.9),
  /** Horizontal start offset as a share of the width: 0 pulls straight back; -0.5 sweeps in from the left while shrinking. */
  fromX: z.number().min(-1).max(1),
  /** Centre of the settled line, share of width and height. */
  x: z.number().min(0.2).max(0.8),
  y: z.number().min(0.2).max(0.8),
  /** Frame the first word of `rest` arrives (-1: right after the settle), and frames between its words. */
  restAt: z.number().int(),
  restStep: z.number().int().min(1).max(12),
  /** Ink the word starts in, recolouring to `ink` over `recolourFrames` from the settle; same as ink for none. */
  inkFrom: z.string(),
  recolourFrames: z.number().int().min(1).max(40),
  face: z.enum(FACE_NAMES),
  ground: z.string(),
  /** "auto" picks paper-white or near-black for the ground. */
  ink: z.string(),
  /** Motion blur along the shrink, 0 for none. */
  blur: z.number().min(0).max(1),
  grain: z.number().min(0).max(0.2),
});

export type GiantWordPullOutProps = z.infer<typeof giantWordPullOutSchema>;

const restWords = (rest: string) => rest.split(/\s+/).filter(Boolean);
const restStart = (p: GiantWordPullOutProps) => (p.restAt >= 0 ? p.restAt : p.at + p.frames - 2);

/**
 * A word fills and overflows the frame, then pulls back to a calm reading size on a fast-out ease: most of the travel in
 * the first third, still for the rest, so it reads at once. Optionally the rest of the line follows word by word in its
 * final place, and the word recolours from an accent to ink.
 */
export const GiantWordPullOut: React.FC<GiantWordPullOutProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const set = faceStyle(p.face);
  const caps = p.face === "condensed" || p.face === "wide";
  const cased = (text: string) => (caps ? text.toUpperCase() : text);
  const words = restWords(p.rest);
  const prefixes = words.map((_, i) => [p.word, ...words.slice(0, i + 1)].join(" "));
  const runs = [p.word, ...words, ...prefixes].map((text) => faceRun(p.face, text));
  const measured = useTextWidths(runs, 100);
  const ink = resolveInk(p.ink, p.ground);
  if (measured === null || frame < p.at)
    return (
      <Stage background={p.ground} grain={p.grain}>
        {null}
      </Stage>
    );

  const wordW100 = measured[0]!;
  const restW100 = measured.slice(1, 1 + words.length);
  const prefixW100 = measured.slice(1 + words.length);
  const lineW100 = prefixW100.at(-1) ?? wordW100;
  // The word's size comes from `width`; a line that would not fit 0.9 of the frame shrinks it.
  let fontSize = (width * p.width * 100) / Math.max(wordW100, 1);
  fontSize = Math.min(fontSize, (width * 0.9 * 100) / Math.max(lineW100, 1), height * 0.5);
  const px = (w100: number) => (w100 * fontSize) / 100;
  const lineLeft = width * p.x - px(lineW100) / 2;
  const cy = height * p.y;

  const scale = pullOutScale(frame, { at: p.at, frames: p.frames, from: p.from });
  const t = progress(frame, p.at, p.frames, pullOutCurve);
  const shiftX = p.fromX * width * (1 - t);
  const speed = Math.abs(scale - pullOutScale(frame - 1, { at: p.at, frames: p.frames, from: p.from }));
  const blurPx = p.blur * Math.min(18, speed * fontSize * 0.06);
  const settleAt = p.at + p.frames;
  const recolour = progress(frame, settleAt - Math.round(p.frames / 3), p.recolourFrames, intentCurves.glide);
  const wordInk = p.inkFrom === p.ink ? ink : interpolateColors(recolour, [0, 1], [p.inkFrom, ink]);

  const type: React.CSSProperties = {
    position: "absolute",
    top: cy - fontSize * 0.6,
    height: fontSize * 1.2,
    display: "flex",
    alignItems: "center",
    fontFamily: set.fontFamily,
    fontWeight: set.fontWeight,
    letterSpacing: set.letterSpacing,
    fontVariationSettings: set.fontVariationSettings,
    fontSize,
    lineHeight: 1,
    whiteSpace: "pre",
  };
  const wordW = px(wordW100);
  // The word starts centred on the line's centre at full size and travels to its slot as it shrinks, on the same ease.
  const toCentre = (width * p.x - (lineLeft + wordW / 2)) * (1 - t);
  const first = restStart(p);

  return (
    <Stage background={p.ground} grain={p.grain}>
      <AbsoluteFill style={{ filter: blurPx > 0.3 ? `blur(${blurPx}px)` : undefined }}>
        <div
          {...intendedOverflow(
            frame < settleAt,
            "giant-word-pull-out: the word starts wider than the frame and pulls back to reading size",
          )}
          style={{
            ...type,
            left: lineLeft,
            width: wordW,
            color: wordInk,
            transform: `translateX(${shiftX + toCentre}px) scale(${scale})`,
            transformOrigin: "50% 50%",
          }}
        >
          {cased(p.word)}
        </div>
      </AbsoluteFill>
      {words.map((w, i) => {
        const arrive = progress(frame, first + i * p.restStep, 5, intentCurves.brake);
        if (arrive <= 0) return null;
        const left = lineLeft + px(prefixW100[i]!) - px(restW100[i]!);
        return (
          <div
            key={`${w}-${i}`}
            style={{
              ...type,
              left,
              color: ink,
              opacity: arrive,
              transform: `translateY(${(1 - arrive) * height * 0.02}px)`,
            }}
          >
            {cased(w)}
          </div>
        );
      })}
    </Stage>
  );
};

export const giantWordPullOutDefaults: GiantWordPullOutProps = {
  word: "Meet",
  rest: "your analyst",
  at: 0,
  frames: 17,
  from: 4.5,
  width: 0.24,
  fromX: 0,
  x: 0.5,
  y: 0.5,
  restAt: -1,
  restStep: 3,
  inkFrom: "#2F5BEA",
  recolourFrames: 18,
  face: "grotesk",
  ground: "#F4F5F7",
  ink: "#0F1218",
  blur: 1,
  grain: 0.03,
};

export const giantWordPullOutCues = (p: GiantWordPullOutProps): Cue[] => [
  { frame: p.at, kind: "reveal", sfx: "whoosh", weight: "hero", label: "giant word pulls back" },
  { frame: p.at + p.frames, kind: "land", sfx: "none", weight: "support", label: "word settles" },
  ...restWords(p.rest).map((word, i) => ({
    frame: restStart(p) + i * p.restStep,
    kind: "type" as const,
    sfx: "none" as const,
    weight: "support" as const,
    label: word,
  })),
];
