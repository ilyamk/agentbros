import { fitText } from "@remotion/layout-utils";
import React, { useLayoutEffect, useState } from "react";
import { continueRender, delayRender, useCurrentFrame } from "remotion";
import { DEFAULT_MASK_BLEED, maskTravelEm, splitGraphemes, type MaskBleed } from "./text-split";
import { progress, stagger, type CurveRef, type Stagger } from "./timing";

type MaskedLineProps = {
  /** 0 hidden, 1 in place. */
  reveal: number;
  lineHeight: number;
  bleed?: MaskBleed;
  children: React.ReactNode;
  style?: React.CSSProperties;
};

/**
 * One line rising from behind its own mask. The mask is a clip-path with negative insets, so it adds no layout
 * and cannot cut Й Ё above or у р щ д below, however tight the line-height.
 */
export const MaskedLine: React.FC<MaskedLineProps> = ({
  reveal,
  lineHeight,
  bleed = DEFAULT_MASK_BLEED,
  children,
  style,
}) => (
  <div
    style={{
      lineHeight,
      clipPath: `inset(-${bleed.top}em -${bleed.side}em -${bleed.bottom}em -${bleed.side}em)`,
      ...style,
    }}
  >
    <div style={{ transform: `translateY(${(1 - reveal) * maskTravelEm(lineHeight, bleed)}em)`, whiteSpace: "pre" }}>
      {children}
    </div>
  </div>
);

type MaskedLinesProps = {
  lines: readonly string[];
  lineHeight?: number;
  from?: number;
  duration?: number;
  /** Frames between lines. */
  step?: number;
  curve?: CurveRef;
  bleed?: MaskBleed;
  style?: React.CSSProperties;
  lineStyle?: (index: number) => React.CSSProperties;
};

export const MaskedLines: React.FC<MaskedLinesProps> = ({
  lines,
  lineHeight = 0.92,
  from = 0,
  duration = 20,
  step = 4,
  curve = "expoOut",
  bleed,
  style,
  lineStyle,
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={style}>
      {lines.map((line, i) => (
        <MaskedLine
          key={`${i}-${line}`}
          reveal={progress(frame, from + i * step, duration, curve)}
          lineHeight={lineHeight}
          bleed={bleed}
          style={lineStyle?.(i)}
        >
          {line}
        </MaskedLine>
      ))}
    </div>
  );
};

type GlyphsProps = {
  text: string;
  locale?: string;
  /** Style of one glyph; `delay` comes from the stagger map. */
  glyph: (state: { index: number; count: number; delay: number; grapheme: string }) => React.CSSProperties;
  stagger?: Stagger;
  style?: React.CSSProperties;
};

/** Per-glyph control. Inline blocks lose kerning: check the settled frame on large mixed-case words. */
export const Glyphs: React.FC<GlyphsProps> = ({
  text,
  locale,
  glyph,
  stagger: map = { kind: "index", step: 0 },
  style,
}) => {
  const graphemes = splitGraphemes(text, locale);
  const delays = stagger(graphemes.length, map);
  return (
    <span aria-label={text} style={{ display: "inline-block", whiteSpace: "pre", ...style }}>
      {graphemes.map((grapheme, index) => (
        <span
          key={`${index}-${grapheme}`}
          aria-hidden
          style={{
            display: "inline-block",
            whiteSpace: "pre",
            ...glyph({ index, count: graphemes.length, delay: delays[index]!, grapheme }),
          }}
        >
          {grapheme}
        </span>
      ))}
    </span>
  );
};

type FitOptions = {
  text: string;
  withinWidth: number;
  fontFamily: string;
  fontWeight?: number;
  letterSpacing?: string;
};

/**
 * Font size that fits one line to a width, or null until its font is ready. Rendering waits meanwhile, and measuring
 * only after the load keeps layout-utils from caching a fallback font's width. Pass the text as displayed (cased).
 */
export const useFittedFontSize = ({ text, ...fit }: FitOptions): number | null =>
  useFittedLinesFontSize({ lines: [text], ...fit });

/** The largest size at which every line fits the width: the smallest of their fitted sizes. Null until the font is ready. */
export const useFittedLinesFontSize = ({
  lines,
  withinWidth,
  fontFamily,
  fontWeight = 400,
  letterSpacing,
}: Omit<FitOptions, "text"> & { lines: readonly string[] }): number | null => {
  const key = lines.join("\n");
  // Keyed, so a new text never renders for a frame at the previous text's size.
  const [fitted, setFitted] = useState<{ key: string; size: number } | null>(null);
  useLayoutEffect(() => {
    const handle = delayRender(`Fitting "${key}"`);
    let live = true;
    const texts = key.split("\n").filter(Boolean);
    void document.fonts
      .load(`${fontWeight} 100px ${fontFamily}`, key)
      .then(() => {
        if (live)
          setFitted({
            key,
            size: Math.min(
              ...texts.map((text) => fitText({ text, withinWidth, fontFamily, fontWeight, letterSpacing }).fontSize),
            ),
          });
      })
      .finally(() => continueRender(handle));
    return () => {
      live = false;
      continueRender(handle);
    };
  }, [key, withinWidth, fontFamily, fontWeight, letterSpacing]);
  return fitted?.key === key ? fitted.size : null;
};

type FittedLineProps = FitOptions & {
  maxFontSize?: number;
  children?: (fontSize: number) => React.ReactNode;
};

/** Renders nothing until fitted; pass a child function to animate the line at its fitted size. */
export const FittedLine: React.FC<FittedLineProps> = ({ maxFontSize = Infinity, children, ...fit }) => {
  const size = useFittedFontSize(fit);
  if (size === null) return null;
  const fontSize = Math.min(size, maxFontSize);
  return children ? (
    <>{children(fontSize)}</>
  ) : (
    <div
      style={{
        fontFamily: fit.fontFamily,
        fontWeight: fit.fontWeight,
        letterSpacing: fit.letterSpacing,
        fontSize,
        whiteSpace: "pre",
      }}
    >
      {fit.text}
    </div>
  );
};
