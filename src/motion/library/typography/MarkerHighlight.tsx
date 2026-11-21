import React from "react";
import { useCurrentFrame } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { splitWords } from "../../text-split";
import { markedGroups, pillState, wrapCentred } from "../../text-modes";
import { progress } from "../../timing";
import { useTextWidths } from "./fit";
import { ARRIVE, STATE, Stage, useSafeArea } from "./Stage";

export const markerHighlightSchema = z.object({
  /** Key words wrapped in asterisks: `Ship *faster* with *fewer* meetings.` */
  text: z.string(),
  color: z.string(),
  marker: z.string(),
  /** Colour of a key word where the marker is under it. */
  markedColor: z.string(),
  background: z.string(),
  fontWeight: z.number().int().min(400).max(900),
  /** px; 0 sizes the sentence to the frame. */
  fontSize: z.number().min(0),
  align: z.enum(["left", "centre"]),
  at: z.number(),
  /** Frames between words arriving. */
  step: z.number().min(0),
  markAt: z.number(),
  markStep: z.number().min(0),
  /** How far unmarked words fade back while the markers draw, 0 to 1. */
  dimRest: z.number().min(0).max(1),
  /**
   * "marker" (default): a felt marker sweeps under each key word. "pill": a pill in `marker` opens empty at `markAt`
   * (5 frames), the first group of marked words (consecutive `*word*`s) types into it, and every `markStep` frames it
   * jumps to the next group on one frame, no tween (ugc-app 10.2-10.6 s). The words in the pill take `markedColor`.
   */
  mode: z.enum(["marker", "pill"]).optional(),
});

export type MarkerHighlightProps = z.infer<typeof markerHighlightSchema>;

export type MarkerToken = { before: string; key: string; after: string; marked: boolean };

/** One token per word; `*key*` inside a word marks it, with surrounding punctuation kept outside the highlight. */
export const parseMarkerText = (text: string): MarkerToken[] =>
  splitWords(text).map((word) => {
    const match = /^([^*]*)\*([^*]+)\*(.*)$/u.exec(word);
    if (match) return { before: match[1], key: match[2], after: match[3].replaceAll("*", ""), marked: true };
    return { before: "", key: word.replaceAll("*", ""), after: "", marked: false };
  });

const LINE_HEIGHT = 1.1;
const WORD_GAP = 0.26;
const ROW_GAP = 0.06;
const TRACKING = "-0.03em";
const OVERHANG = 0.09;
const BAND_TOP = 0.5;
const BAND_BOTTOM = 0.08;
const MARKER_PATH =
  "M3.2 9.5 C 14 6.8, 38 8.1, 61 5.9 S 88 4.6, 97.4 7.2 C 99.4 8.6, 99.6 24.5, 98.1 28.3 C 84 31.6, 57 29.4, 35 31.8 S 9.6 32.9, 2.3 30.6 C 0.4 27.2, 0.6 12.1, 3.2 9.5 Z";

const linesAt = (widths: readonly number[], gap: number, limit: number): number => {
  let lines = 1;
  let used = 0;
  for (const width of widths) {
    if (used > 0 && used + gap + width > limit) {
      lines += 1;
      used = width;
    } else used += (used > 0 ? gap : 0) + width;
  }
  return lines;
};

const autoSize = (widths100: readonly number[], lineWidth: number, maxHeight: number, cap: number): number => {
  const longest = Math.max(1, ...widths100);
  let size = Math.min(cap, (lineWidth * 100) / longest);
  while (size > 16) {
    const widths = widths100.map((w) => (w * size) / 100);
    const lines = linesAt(widths, WORD_GAP * size, lineWidth);
    if (lines * size * LINE_HEIGHT + (lines - 1) * size * ROW_GAP <= maxHeight) return size;
    size *= 0.97;
  }
  return size;
};

export const MarkerHighlight: React.FC<MarkerHighlightProps> = (props) => {
  const {
    text,
    color,
    marker,
    markedColor,
    background,
    fontWeight,
    fontSize,
    align,
    at,
    step,
    markAt,
    markStep,
    dimRest,
  } = props;
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const tokens = parseMarkerText(text);
  const widths100 = useTextWidths(
    tokens.map((token) => ({
      text: token.before + token.key + token.after,
      fontFamily: primaryFont,
      fontWeight,
      letterSpacing: TRACKING,
    })),
    100,
  );
  if (widths100 === null) return <Stage background={background}>{null}</Stage>;

  const lineWidth = safe.width * (safe.vertical ? 1 : 0.86);
  const size =
    fontSize > 0
      ? fontSize
      : autoSize(widths100, lineWidth, safe.height * (safe.vertical ? 0.5 : 0.62), safe.vertical ? 118 : 150);
  if (props.mode === "pill")
    return (
      <PillSentence
        {...props}
        tokens={tokens}
        widths={widths100.map((w) => (w * size) / 100)}
        size={size}
        lineWidth={lineWidth}
      />
    );
  const dim = progress(frame, markAt, 30, STATE) * dimRest;

  let markIndex = 0;
  const words = tokens.map((token, index) => {
    const arrive = progress(frame, at + index * step, 16, ARRIVE);
    const softness = (1 - arrive) * size * 0.11;
    const box: React.CSSProperties = {
      display: "inline-block",
      whiteSpace: "pre",
      opacity: Math.min(1, arrive * 1.6) * (token.marked ? 1 : 1 - dim),
      transformOrigin: "50% 80%",
      transform: `translateY(${(1 - arrive) * 0.24}em) scale(${1 + (1 - arrive) * 0.07})`,
      filter: softness > 0.3 ? `blur(${softness.toFixed(2)}px)` : undefined,
    };
    if (!token.marked)
      return (
        <span key={index} style={box}>
          {token.key}
        </span>
      );

    const sweep = progress(frame, markAt + markIndex++ * markStep, 13, STATE);
    const right = `calc(${((1 - sweep) * 100).toFixed(3)}% + ${((1 - 2 * sweep) * OVERHANG).toFixed(4)}em)`;
    return (
      <span key={index} style={box}>
        {token.before}
        <span style={{ position: "relative", display: "inline-block" }}>
          <svg
            viewBox="0 0 100 36"
            preserveAspectRatio="none"
            aria-hidden
            style={{
              position: "absolute",
              left: `-${OVERHANG}em`,
              top: `${BAND_TOP}em`,
              height: `${LINE_HEIGHT - BAND_TOP - BAND_BOTTOM + 0.04}em`,
              width: `calc(100% + ${OVERHANG * 2}em)`,
              clipPath: `inset(-10% ${((1 - sweep) * 100).toFixed(3)}% -10% 0)`,
              overflow: "visible",
            }}
          >
            <path d={MARKER_PATH} fill={marker} />
          </svg>
          <span style={{ position: "relative" }}>{token.key}</span>
          {markedColor === color ? null : (
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                color: markedColor,
                clipPath: `inset(${BAND_TOP}em ${right} ${BAND_BOTTOM}em 0)`,
              }}
            >
              {token.key}
            </span>
          )}
        </span>
        {token.after}
      </span>
    );
  });

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
          alignItems: "center",
          justifyContent: align === "centre" ? "center" : "flex-start",
        }}
      >
        <div
          style={{
            maxWidth: lineWidth,
            display: "flex",
            flexWrap: "wrap",
            justifyContent: align === "centre" ? "center" : "flex-start",
            columnGap: `${WORD_GAP}em`,
            rowGap: `${ROW_GAP}em`,
            fontFamily: primaryFont,
            fontWeight,
            fontSize: size,
            lineHeight: LINE_HEIGHT,
            letterSpacing: TRACKING,
            color,
          }}
        >
          {words}
        </div>
      </div>
    </Stage>
  );
};

const PILL_OPEN = 5;

/** The pill mode: words laid out once, the pill opening empty on the first group, then jumping group to group. */
const PillSentence: React.FC<
  MarkerHighlightProps & { tokens: MarkerToken[]; widths: number[]; size: number; lineWidth: number }
> = (p) => {
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const gap = WORD_GAP * p.size;
  const places = wrapCentred(p.widths, gap, p.lineWidth);
  const lines = Math.max(...places.map((place) => place.line)) + 1;
  const rowPitch = p.size * (LINE_HEIGHT + ROW_GAP);
  const blockHeight = lines * p.size * LINE_HEIGHT + (lines - 1) * p.size * ROW_GAP;
  const left0 = safe.side + (safe.width - p.lineWidth) / 2;
  const top0 = safe.top + (safe.height - blockHeight) / 2;
  const groups = markedGroups(p.tokens.map((token) => token.marked));
  const pill = pillState(frame, p.markAt, p.markStep, groups.length, PILL_OPEN);
  const first = groups[0];
  // The first group waits for its pill to open, then types in a word every 2 frames.
  const arriveAt = (index: number) =>
    first && index >= first.from && index <= first.to
      ? Math.max(p.at + index * p.step, p.markAt + PILL_OPEN + (index - first.from) * 2)
      : p.at + index * p.step;
  const held = pill.group >= 0 ? groups[pill.group]! : null;
  const dim = progress(frame, p.markAt, 30, STATE) * p.dimRest;
  let pillBox: React.ReactNode = null;
  if (held) {
    const a = places[held.from]!;
    const sameLine = Array.from({ length: held.to - held.from + 1 }, (_, k) => held.from + k).filter(
      (i) => places[i]!.line === a.line,
    );
    const last = sameLine.at(-1)!;
    const padX = p.size * 0.22;
    const width = places[last]!.x + p.widths[last]! - a.x + padX * 2;
    pillBox = (
      <div
        style={{
          position: "absolute",
          left: left0 + a.x - padX,
          top: top0 + a.line * rowPitch - p.size * 0.02,
          width: width * pill.open,
          height: p.size * LINE_HEIGHT * 1.02,
          borderRadius: p.size * 0.55,
          backgroundColor: p.marker,
        }}
      />
    );
  }
  return (
    <Stage background={p.background}>
      {pillBox}
      {p.tokens.map((token, index) => {
        const place = places[index]!;
        const start = arriveAt(index);
        if (frame < start) return null;
        // The pill covers the part of its group on the group's first line; a word wrapped past it keeps the sentence colour.
        const inPill =
          held !== null && index >= held.from && index <= held.to && place.line === places[held.from]!.line;
        const arrive = progress(frame, start, 6, ARRIVE);
        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: left0 + place.x,
              top: top0 + place.line * rowPitch,
              fontFamily: primaryFont,
              fontWeight: p.fontWeight,
              fontSize: p.size,
              lineHeight: LINE_HEIGHT,
              letterSpacing: TRACKING,
              whiteSpace: "pre",
              color: inPill ? p.markedColor : p.color,
              opacity: Math.min(1, arrive * 1.6) * (inPill || token.marked ? 1 : 1 - dim),
            }}
          >
            {token.before + token.key + token.after}
          </div>
        );
      })}
    </Stage>
  );
};

export const markerHighlightDefaults: MarkerHighlightProps = {
  text: "Turn *messy* notes into *clear* plans, *instantly*.",
  color: "#151412",
  marker: "#FFD84A",
  markedColor: "#151412",
  background: "#F6F2EA",
  fontWeight: 700,
  fontSize: 0,
  align: "centre",
  at: 4,
  step: 3,
  markAt: 40,
  markStep: 11,
  dimRest: 0.35,
};

export const blurTextPreset = {
  ...markerHighlightDefaults,
  text: "Ready to cut.",
  background: "#18261F",
  color: "#F2F4DE",
  dimRest: 0,
  at: 5,
  step: 4,
} satisfies MarkerHighlightProps;

/** ugc-app's travelling pill: a yellow pill opens empty, its words type in, then it jumps to the figure on one frame. */
export const markerHighlightPillPreset: MarkerHighlightProps = {
  ...markerHighlightDefaults,
  text: "*Most* *people* quit *8* *days* in",
  color: "#FFFFFF",
  marker: "#FFD84A",
  markedColor: "#111111",
  background: "#0B0B0C",
  at: 4,
  step: 3,
  markAt: 26,
  markStep: 34,
  dimRest: 0,
  mode: "pill",
};
