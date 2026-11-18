import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { z } from "zod";
import { FilmFinish } from "../finish/FilmFinish";
import { axesFor, faceFor } from "../typography/faces";
import { getStyle, styles } from "../styles";
import type { LibraryStyle } from "../types";

export const styleIds = styles.map((style) => style.id) as [string, ...string[]];

export const sceneBaseSchema = z.object({
  /** A look from the styles category; palette and fonts come from it. */
  styleId: z.enum(styleIds),
  /** Wrap the scene in FilmFinish. Turn off when the scene sits inside a film that is finished once. */
  finish: z.boolean(),
});

export const fontFor = (name: string): string => faceFor(name);

export const useLook = (
  styleId: string,
): LibraryStyle & {
  displayFamily: string;
  displayAxes?: string;
  bodyFamily: string;
  bodyAxes?: string;
  dark: boolean;
} => {
  const style = getStyle(styleId);
  const displayFamily = fontFor(style.fonts.display);
  const bodyFamily = fontFor(style.fonts.body);
  return {
    ...style,
    displayFamily,
    displayAxes: axesFor(displayFamily),
    bodyFamily,
    bodyAxes: axesFor(bodyFamily),
    dark: luminance(style.palette.background) < 0.4,
  };
};

const luminance = (hex: string): number => {
  const value = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

export const ARRIVE = Easing.bezier(0.16, 1, 0.3, 1);
export const EXIT = Easing.bezier(0.6, 0, 0.9, 0.35);

/** FilmFinish with only the style's grain (at most 0.05) and no vignette, or nothing when `on` is false. */
export const MaybeFinish: React.FC<{ on: boolean; styleId: string; seed: string; children: React.ReactNode }> = ({
  on,
  styleId,
  seed,
  children,
}) => {
  if (!on) return <AbsoluteFill>{children}</AbsoluteFill>;
  const { finish } = getStyle(styleId);
  return (
    <FilmFinish grain={Math.min(finish.grain, 0.05)} vignette={0} aberration={0} seed={seed}>
      {children}
    </FilmFinish>
  );
};

/** One line whose words arrive out of a blur, 3 f apart, no translate (craft-rules entrance). */
export const BlurWords: React.FC<{
  text: string;
  at: number;
  gap?: number;
  style: React.CSSProperties;
  accentWord?: number;
  accent?: string;
}> = ({ text, at, gap = 3, style, accentWord = -1, accent }) => {
  const frame = useCurrentFrame();
  return (
    <div style={style}>
      {text.split(" ").map((word, index, words) => {
        const p = interpolate(frame, [at + index * gap, at + index * gap + 6], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ARRIVE,
        });
        return (
          <span
            key={`${index}-${word}`}
            style={{
              display: "inline-block",
              whiteSpace: "pre",
              opacity: p,
              filter: p < 0.99 ? `blur(${(1 - p) * 8}px)` : undefined,
              color: index === accentWord ? accent : undefined,
            }}
          >
            {word}
            {index < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </div>
  );
};

export type SceneGround = { ground: string; ink: string; accent: string };

/**
 * The style's grounds to swap on hard cuts (`grounds`, else background, accent and text), each with the ink that
 * reads on it: the darker of text and background on a light ground, the lighter on a dark one.
 */
export const groundsFor = (styleId: string): SceneGround[] => {
  const style = getStyle(styleId);
  const { background, text, accent } = style.palette;
  const [dark, light] = luminance(text) < luminance(background) ? [text, background] : [background, text];
  const list = style.grounds && style.grounds.length > 1 ? style.grounds : [background, accent, text];
  return list.map((ground) => {
    const lightGround = luminance(ground) > 0.6;
    const ink = lightGround ? dark : light;
    // The accent marks numbers and key words only where it reads; on its own ground it falls back to the ink.
    return { ground, ink, accent: ground.toLowerCase() === accent.toLowerCase() ? ink : accent };
  });
};

/** A ground by role: the light one (first), the accent one (the palette accent, else the second) or the ink one (darkest). */
export const groundRole = (styleId: string, role: "light" | "accent" | "ink"): SceneGround => {
  const grounds = groundsFor(styleId);
  if (role === "light") return grounds[0]!;
  if (role === "accent") {
    const accent = getStyle(styleId).palette.accent.toLowerCase();
    return grounds.find((g) => g.ground.toLowerCase() === accent) ?? grounds[1] ?? grounds[0]!;
  }
  return [...grounds].sort((a, b) => luminance(a.ground) - luminance(b.ground))[0]!;
};

/** Hero type share of frame width: the style's `typeScale.hero`, else 0.78 (0.86 on a vertical frame). */
export const heroShare = (styleId: string, vertical: boolean): number =>
  getStyle(styleId).typeScale?.hero ?? (vertical ? 0.86 : 0.78);

/**
 * A sentence that builds word by word, 2 f apart, each word out of a short blur with no translate. `[bracketed]`
 * words are set in the accent: numbers and the key word, as the references do.
 */
export const BuildLine: React.FC<{
  text: string;
  at: number;
  gap?: number;
  ink: string;
  accent: string;
  style: React.CSSProperties;
}> = ({ text, at, gap = 2, ink, accent, style }) => {
  const frame = useCurrentFrame();
  const words = text.match(/\[[^\]]+\]|\S+/g) ?? [];
  return (
    <div style={{ color: ink, ...style }}>
      {words.map((word, index) => {
        const accented = word.startsWith("[");
        const p = interpolate(frame, [at + index * gap, at + index * gap + 5], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: ARRIVE,
        });
        return (
          <span
            key={`${index}-${word}`}
            style={{
              display: "inline-block",
              whiteSpace: "pre",
              opacity: p,
              filter: p < 0.99 ? `blur(${(1 - p) * 6}px)` : undefined,
              color: accented ? accent : undefined,
            }}
          >
            {accented ? word.slice(1, -1) : word}
            {index < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </div>
  );
};

/** Words of a BuildLine, for timing: the line has landed `5 + (count - 1) * gap` frames after `at`. */
export const buildLineFrames = (text: string, gap = 2): number =>
  5 + Math.max((text.match(/\[[^\]]+\]|\S+/g) ?? []).length - 1, 0) * gap;

/** Shrink-and-blur exit of a hero (firecrawl's 80%): 0 before `exitAt`, 1 when gone. -1 never exits. */
export const exitProgress = (frame: number, exitAt: number, frames = 8): number =>
  exitAt < 0
    ? 0
    : interpolate(frame, [exitAt, exitAt + frames], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: EXIT,
      });
