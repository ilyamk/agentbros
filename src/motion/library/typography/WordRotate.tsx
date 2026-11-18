import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont, serifFont } from "../../../lib/fonts";
import { splitGraphemes } from "../../text-split";
import { retypeSlotState } from "../../text-modes";
import { progress } from "../../timing";
import { useTextWidths, type TextRun } from "./fit";
import { ARRIVE, EXIT, Stage, useSafeArea } from "./Stage";

export const wordRotateSchema = z.object({
  prefix: z.string(),
  /** Words that take turns in the slot; the last one stays. */
  words: z.array(z.string()).min(1),
  color: z.string(),
  accent: z.string(),
  background: z.string(),
  /** "serif": the slot word in serif italic for contrast. */
  wordFace: z.enum(["sans", "serif"]),
  at: z.number(),
  /** Frames each word holds before the next replaces it. */
  hold: z.number().positive(),
  /**
   * "roll" (default): the word rolls out upward and the next springs in. "retype": the slot word sits in a selection box
   * with a named caret flag for `selectFrames` before its swap, clears on the swap frame and the next word types a letter
   * a frame while the line recentres (postiz 32.9-35.3 s: selection about 0.5 s, 7-8 letters in 7-8 frames, swaps 55
   * frames apart).
   */
  swap: z.enum(["roll", "retype"]).optional(),
  /** Text after the slot on the same line (postiz's slot is the line's first word): " every post". */
  suffix: z.string().optional(),
  selectFrames: z.number().int().min(1).max(60).optional(),
  /** Name on the caret flag; empty for a bare caret. */
  caretName: z.string().optional(),
  selectionColour: z.string().optional(),
  flagColour: z.string().optional(),
});

export type WordRotateProps = z.infer<typeof wordRotateSchema>;

const LINE_HEIGHT = 1.16;
const GAP_EM = 0.26;
const IN_STAGGER = 1.6;
const IN_DELAY = 5;
const OUT_STAGGER = 1.3;
const OUT_FRAMES = 10;
const SPRING = { damping: 20, stiffness: 240, mass: 1 };

type Face = { fontFamily: string; fontWeight: number; letterSpacing: string; fontStyle: "normal" | "italic" };

export const WordRotate: React.FC<WordRotateProps> = (props) => {
  if (props.swap === "retype") return <RetypeLine {...props} />;
  return <RollLine {...props} />;
};

const RollLine: React.FC<WordRotateProps> = ({ prefix, words, color, accent, background, wordFace, at, hold }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const safe = useSafeArea();
  const prefixFace: Face = { fontFamily: primaryFont, fontWeight: 700, letterSpacing: "-0.035em", fontStyle: "normal" };
  const slotFace: Face =
    wordFace === "serif"
      ? { fontFamily: serifFont, fontWeight: 500, letterSpacing: "-0.005em", fontStyle: "italic" }
      : prefixFace;
  const run = (text: string, face: Face): TextRun => ({
    text,
    fontFamily: face.fontFamily,
    fontWeight: face.fontWeight,
    letterSpacing: face.letterSpacing,
    additionalStyles: { fontStyle: face.fontStyle },
  });
  const measured = useTextWidths([run(prefix, prefixFace), ...words.map((word) => run(word, slotFace))], 100);
  if (measured === null) return <Stage background={background}>{null}</Stage>;

  const [prefixWidth = 0, ...wordWidths100] = measured;
  const longest = Math.max(...wordWidths100);
  const hasPrefix = prefix.trim() !== "";
  const span100 = safe.vertical
    ? Math.max(prefixWidth, longest)
    : prefixWidth + (hasPrefix ? GAP_EM * 100 : 0) + longest;
  const cap = safe.vertical ? (safe.height * 0.34) / (2 * LINE_HEIGHT) : (safe.height * 0.42) / LINE_HEIGHT;
  const size = Math.min(cap, (safe.width * (safe.vertical ? 0.9 : 0.86) * 100) / Math.max(span100, 1));
  const wordWidths = wordWidths100.map((w) => (w * size) / 100);
  const margin = size * 0.04;

  const last = words.length - 1;
  const current = frame < at ? 0 : Math.min(last, Math.floor((frame - at) / hold));
  const swapAt = (index: number) => at + index * hold;
  const settle = current > 0 ? progress(frame, swapAt(current), 16, ARRIVE) : 1;
  const slotWidth =
    current > 0
      ? wordWidths[current - 1] + (wordWidths[current] - wordWidths[current - 1]) * settle + margin
      : wordWidths[0] + margin;

  const springAt = (start: number, f: number) => (f < start ? 0 : spring({ frame: f - start, fps, config: SPRING }));

  const incoming = (index: number) => {
    const start = index === 0 ? at : swapAt(index) + IN_DELAY;
    return splitGraphemes(words[index]).map((glyph, g) => {
      const begin = start + g * IN_STAGGER;
      if (frame < begin)
        return (
          <span key={g} style={{ display: "inline-block", opacity: 0 }}>
            {glyph}
          </span>
        );
      const s = springAt(begin, frame);
      const speed = Math.abs(springAt(begin, frame + 1) - s);
      const softness = Math.min(size * 0.09, speed * size * 0.14 + Math.max(0, 1 - s) * size * 0.035);
      return (
        <span
          key={g}
          style={{
            display: "inline-block",
            opacity: Math.min(1, (frame - begin) / 3),
            transform: `translateY(${(1 - s) * 0.72}em)`,
            filter: softness > 0.3 ? `blur(${softness.toFixed(2)}px)` : undefined,
          }}
        >
          {glyph}
        </span>
      );
    });
  };

  const outgoing = (index: number) => {
    const start = swapAt(index + 1);
    return splitGraphemes(words[index]).map((glyph, g) => {
      const p = progress(frame, start + g * OUT_STAGGER, OUT_FRAMES, EXIT);
      return (
        <span
          key={g}
          style={{
            display: "inline-block",
            opacity: 1 - p,
            transform: `translateY(${-p * 0.5}em)`,
            filter: p > 0.02 ? `blur(${(p * size * 0.06).toFixed(2)}px)` : undefined,
          }}
        >
          {glyph}
        </span>
      );
    });
  };

  const outIndex = current - 1;
  const outEnds =
    outIndex >= 0 ? swapAt(current) + (splitGraphemes(words[outIndex]).length - 1) * OUT_STAGGER + OUT_FRAMES : -1;
  const layer: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    whiteSpace: "pre",
    lineHeight: LINE_HEIGHT,
  };

  const slot = (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        width: slotWidth,
        height: size * LINE_HEIGHT,
        lineHeight: LINE_HEIGHT,
        color: accent,
        ...slotFace,
      }}
    >
      <span style={{ visibility: "hidden" }}>{"​"}</span>
      {outIndex >= 0 && frame < outEnds ? <div style={layer}>{outgoing(outIndex)}</div> : null}
      <div style={layer}>{incoming(current)}</div>
    </div>
  );

  const entry = progress(frame, at - 6, 22, ARRIVE);
  const prefixNode = hasPrefix ? (
    <span
      style={{
        ...prefixFace,
        color,
        whiteSpace: "pre",
        lineHeight: LINE_HEIGHT,
        display: "inline-block",
        opacity: entry,
        transform: `translateY(${(1 - entry) * 0.22}em)`,
        filter: entry < 0.98 ? `blur(${((1 - entry) * size * 0.06).toFixed(2)}px)` : undefined,
      }}
    >
      {prefix}
    </span>
  ) : null;

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
          justifyContent: "center",
          fontSize: size,
        }}
      >
        {safe.vertical ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            {prefixNode}
            {slot}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "baseline", columnGap: hasPrefix ? `${GAP_EM}em` : 0 }}>
            {prefixNode}
            {slot}
          </div>
        )}
      </div>
    </Stage>
  );
};

export const wordRotateDefaults: WordRotateProps = {
  prefix: "Made for",
  words: ["founders.", "editors.", "night owls.", "everyone."],
  color: "#17150F",
  accent: "#D9452B",
  background: "#F4F0E7",
  wordFace: "serif",
  at: 8,
  hold: 30,
};

/** The retype swap: prefix, a slot word that is selected, cleared and retyped, and a suffix, centred on one line. */
const RetypeLine: React.FC<WordRotateProps> = (p) => {
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const prefixFace: Face = { fontFamily: primaryFont, fontWeight: 600, letterSpacing: "-0.03em", fontStyle: "normal" };
  const slotFace: Face =
    p.wordFace === "serif"
      ? { fontFamily: serifFont, fontWeight: 500, letterSpacing: "-0.005em", fontStyle: "italic" }
      : prefixFace;
  const run = (text: string, face: Face): TextRun => ({
    text,
    fontFamily: face.fontFamily,
    fontWeight: face.fontWeight,
    letterSpacing: face.letterSpacing,
    additionalStyles: { fontStyle: face.fontStyle },
  });
  const suffix = p.suffix ?? "";
  const measured = useTextWidths(
    [run(p.prefix || " ", prefixFace), run(suffix || " ", prefixFace), ...p.words.map((word) => run(word, slotFace))],
    100,
  );
  if (measured === null) return <Stage background={p.background}>{null}</Stage>;
  const [prefixWidth = 0, suffixWidth = 0, ...wordWidths] = measured;
  const span100 =
    (p.prefix.trim() ? prefixWidth + GAP_EM * 100 : 0) + Math.max(...wordWidths) + (suffix.trim() ? suffixWidth : 0);
  const size = Math.min(
    safe.vertical ? safe.height * 0.08 : safe.height * 0.16,
    (safe.width * 0.9 * 100) / Math.max(span100, 1),
  );
  const state = retypeSlotState(frame, {
    at: p.at,
    hold: p.hold,
    words: p.words,
    selectFrames: p.selectFrames ?? 15,
    lettersPerFrame: 1,
  });
  const flag = p.flagColour ?? "#7B61FF";
  const showCaret = state.selected || state.typing;
  const name = p.caretName ?? "";
  const text: React.CSSProperties = { whiteSpace: "pre", lineHeight: LINE_HEIGHT };
  return (
    <Stage background={p.background}>
      <div
        style={{
          position: "absolute",
          left: safe.side,
          right: safe.side,
          top: safe.top,
          bottom: safe.bottom,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: size,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", flexWrap: "nowrap" }}>
          {p.prefix.trim() ? (
            <span style={{ ...prefixFace, ...text, color: p.color, marginRight: `${GAP_EM}em` }}>{p.prefix}</span>
          ) : null}
          <span
            style={{
              ...slotFace,
              ...text,
              color: p.accent,
              position: "relative",
              display: "inline-block",
              backgroundColor: state.selected ? (p.selectionColour ?? "#CFE0FF") : undefined,
              minWidth: 1,
            }}
          >
            {state.text}
            {showCaret ? (
              <span
                style={{
                  position: "absolute",
                  right: -size * 0.04,
                  top: size * 0.08,
                  width: Math.max(2, size * 0.035),
                  height: size * 1.0,
                  backgroundColor: flag,
                }}
              >
                {name ? (
                  <span
                    style={{
                      position: "absolute",
                      left: 0,
                      bottom: "100%",
                      padding: `${size * 0.04}px ${size * 0.12}px`,
                      borderRadius: `${size * 0.08}px ${size * 0.08}px ${size * 0.08}px 0`,
                      backgroundColor: flag,
                      color: "#FFFFFF",
                      fontFamily: primaryFont,
                      fontWeight: 600,
                      fontStyle: "normal",
                      fontSize: size * 0.3,
                      lineHeight: 1.2,
                      whiteSpace: "pre",
                      letterSpacing: 0,
                    }}
                  >
                    {name}
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
          {suffix ? <span style={{ ...prefixFace, ...text, color: p.color }}>{suffix}</span> : null}
        </div>
      </div>
    </Stage>
  );
};

/** postiz's held claim: the first word selected under a named caret, cleared on the beat and retyped a letter a frame, swaps 55 frames apart. */
export const wordRotateRetypePreset: WordRotateProps = {
  ...wordRotateDefaults,
  prefix: "",
  suffix: " every post from one place",
  words: ["Plan", "Schedule", "Publish"],
  color: "#1E1B16",
  accent: "#1E1B16",
  background: "#F6F1E7",
  wordFace: "serif",
  at: 6,
  hold: 55,
  swap: "retype",
  selectFrames: 15,
  caretName: "Ana",
  selectionColour: "#CFE0FF",
  flagColour: "#7B61FF",
};
