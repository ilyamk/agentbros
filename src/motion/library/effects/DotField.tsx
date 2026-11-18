import { measureText } from "@remotion/layout-utils";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { useFittedFontSize } from "../../text";
import type { Cue } from "../types";
import {
  dotBlobRadius,
  dotConvergeEnd,
  dotFieldStates,
  dotStreamEdge,
  gridDotSources,
  type DotFieldTiming,
  type DotSource,
} from "./effects-plan";

export const dotFieldSchema = z.object({
  /** words: each word of `text` becomes a dot at its centre. grid: a grid of cards becomes discs of seeded sizes. */
  source: z.enum(["words", "grid"]),
  text: z.string(),
  cols: z.number().int().min(1).max(24),
  rows: z.number().int().min(1).max(16),
  /** Disc diameters as shares of a grid cell (three or four sizes, seeded per cell). */
  sizes: z.array(z.number().min(0.05).max(1)).min(1).max(6),
  /** Seeded offset of each disc as a share of its cell. */
  jitter: z.number().min(0).max(1),
  /** index: left to right, `swapStep` frames apart. radial: a ring from the centre, reaching the edge in `swapStep` frames. */
  order: z.enum(["index", "radial"]),
  swapAt: z.number().int().min(0),
  swapStep: z.number().min(0).max(120),
  swapFrames: z.number().int().min(1).max(20),
  /** After the swap: hold the dots, converge to a point, stream off as a band that reveals `line`, or merge into one blob. */
  to: z.enum(["hold", "converge", "stream", "merge"]),
  toAt: z.number().int().min(0),
  convergeFrames: z.number().int().min(2).max(60),
  /** Converge point as shares of the frame. */
  targetX: z.number().min(0).max(1),
  targetY: z.number().min(0).max(1),
  streamFrames: z.number().int().min(4).max(120),
  /** stream: left end of the band, and where `line` starts, as shares of the width. */
  bandFrom: z.number().min(0).max(1),
  /** stream: the line of type revealed behind the band's trailing edge; empty for none. */
  line: z.string(),
  ground: z.string(),
  /** Word colour, card fill and disc colour, line colour. */
  ink: z.string(),
  tile: z.string(),
  dot: z.string(),
  lineInk: z.string(),
  seed: z.string(),
});

export type DotFieldProps = z.infer<typeof dotFieldSchema>;

export const DOT_FIELD_FRAMES = 110;

/** context-dev t11-t12: a card grid turns into cobalt discs from the centre (23 frames, power1.in), converges at frame right (11 frames, power2.in) and streams off as a band that reveals a line. */
export const dotFieldDefaults: DotFieldProps = {
  source: "grid",
  text: "Every tool your team uses",
  cols: 16,
  rows: 8,
  sizes: [0.16, 0.22, 0.3, 0.4],
  jitter: 0.25,
  order: "radial",
  swapAt: 12,
  swapStep: 23,
  swapFrames: 3,
  to: "stream",
  toAt: 38,
  convergeFrames: 11,
  targetX: 0.86,
  targetY: 0.5,
  streamFrames: 30,
  bandFrom: 0.12,
  line: "Every source in one stream",
  ground: "#F2F1EC",
  ink: "#141414",
  tile: "#FFFFFF",
  dot: "#2448E6",
  lineInk: "#141414",
  seed: "dots",
};

/** ace t05: each word of a short line fades as a dot pops in its place, left to right every 2-3 frames, then the row converges and merges into one blob. */
export const dotFieldWordsPreset: Partial<DotFieldProps> = {
  source: "words",
  order: "index",
  swapAt: 6,
  swapStep: 2.5,
  swapFrames: 3,
  to: "merge",
  toAt: 40,
  convergeFrames: 8,
  targetX: 0.5,
  targetY: 0.5,
  ground: "#0D0E12",
  ink: "#F3F3F3",
  dot: "#F3F3F3",
};

const timingOf = (p: DotFieldProps, width: number, height: number): DotFieldTiming => ({
  swapAt: p.swapAt,
  swapStep: p.swapStep,
  order: p.order,
  swapFrames: p.swapFrames,
  to: p.to,
  toAt: p.toAt,
  convergeFrames: p.convergeFrames,
  target: { x: p.targetX * width, y: p.targetY * height },
  streamFrames: p.streamFrames,
  bandFrom: p.bandFrom * width,
  bandHeight: Math.min(width, height) * 0.05,
  width,
  seed: p.seed,
});

/** The grid's box in px: most of the frame, kept clear of the edges. */
const gridBox = (width: number, height: number) => {
  const w = width * 0.84;
  const h = Math.min(height * 0.62, w * 0.62);
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
};

/** Cues: the first swap, the converge's arrival, and the merge or the band leaving. */
export const dotFieldCues = (
  p: Pick<DotFieldProps, "swapAt" | "to" | "toAt" | "convergeFrames" | "streamFrames">,
): Cue[] => {
  const cues: Cue[] = [
    { frame: p.swapAt, kind: "reveal", sfx: "pop", weight: "support", label: "first item becomes a dot" },
  ];
  if (p.to === "hold") return cues;
  const end = dotConvergeEnd(p);
  cues.push({
    frame: end,
    kind: p.to === "merge" ? "land" : "hit",
    sfx: p.to === "merge" ? "pop" : "impact",
    weight: "hero",
    label: p.to === "merge" ? "dots merge into one" : "field converges",
  });
  if (p.to === "stream")
    cues.push({ frame: end + 2, kind: "exit", sfx: "whoosh", weight: "support", label: "band streams off" });
  return cues;
};

/**
 * Things become dots: each word of a line (or each card of a grid) fades as a flat disc pops in its place, left to
 * right or in a ring from the centre; then the discs hold, converge to a point (power2.in), merge into one blob, or
 * flatten into a band that streams off the frame while a line of type appears in its wake.
 */
export const DotField: React.FC<DotFieldProps> = (props) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height);
  const words = props.text.split(/\s+/).filter(Boolean);
  const fontSize = useFittedFontSize({
    text: props.text,
    withinWidth: width * 0.8,
    fontFamily: primaryFont,
    fontWeight: 600,
  });
  const lineSize = useFittedFontSize({
    text: props.line || " ",
    withinWidth: width * (1 - props.bandFrom) * 0.9,
    fontFamily: primaryFont,
    fontWeight: 500,
  });
  const timing = timingOf(props, width, height);
  let sources: DotSource[] = [];
  let wordBoxes: { text: string; x: number; y: number; size: number }[] = [];
  if (props.source === "grid") {
    sources = gridDotSources(gridBox(width, height), props.cols, props.rows, props.sizes, props.jitter, props.seed);
  } else if (fontSize !== null) {
    const size = Math.min(fontSize, unit * 0.1);
    const space = measureText({ text: " ", fontFamily: primaryFont, fontSize: size, fontWeight: "600" }).width;
    const widths = words.map(
      (w) => measureText({ text: w, fontFamily: primaryFont, fontSize: size, fontWeight: "600" }).width,
    );
    const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
    let x = (width - total) / 2;
    wordBoxes = words.map((text, i) => {
      const box = { text, x: x + widths[i]! / 2, y: props.targetY * height, size };
      x += widths[i]! + space;
      return box;
    });
    sources = wordBoxes.map((b) => ({ x: b.x, y: b.y, r: b.size * 0.16 }));
  }
  const states = dotFieldStates(frame, sources, timing);
  const blob = dotBlobRadius(frame, sources, timing);
  const edge = dotStreamEdge(frame, sources, timing);
  const box = gridBox(width, height);
  const cell = Math.min(box.w / props.cols, box.h / props.rows);
  const lineFont = lineSize === null ? 0 : Math.min(lineSize, height * 0.047 * (height > width ? 0.6 : 1));
  return (
    <AbsoluteFill style={{ backgroundColor: props.ground, overflow: "hidden" }}>
      {props.source === "grid"
        ? sources.map((s, i) => {
            const st = states[i]!;
            if (st.item <= 0) return null;
            const col = i % props.cols;
            const row = Math.floor(i / props.cols);
            const cx = box.x + (col + 0.5) * (box.w / props.cols);
            const cy = box.y + (row + 0.5) * (box.h / props.rows);
            const side = cell * 0.82;
            return (
              <div
                key={`t${i}`}
                style={{
                  position: "absolute",
                  left: cx - side / 2,
                  top: cy - side * 0.36,
                  width: side,
                  height: side * 0.72,
                  borderRadius: side * 0.08,
                  backgroundColor: props.tile,
                  border: `${Math.max(1, unit * 0.0012)}px solid rgba(0,0,0,0.12)`,
                  opacity: st.item,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: side * 0.12,
                    top: side * 0.14,
                    width: side * 0.22,
                    height: side * 0.22,
                    borderRadius: "50%",
                    backgroundColor: props.dot,
                    opacity: 0.25,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: side * 0.12,
                    top: side * 0.44,
                    width: side * 0.6,
                    height: side * 0.06,
                    backgroundColor: "rgba(0,0,0,0.2)",
                  }}
                />
              </div>
            );
          })
        : wordBoxes.map((b, i) => (
            <div
              key={`w${i}`}
              style={{
                position: "absolute",
                left: b.x,
                top: b.y,
                transform: "translate(-50%, -50%)",
                fontFamily: primaryFont,
                fontWeight: 600,
                fontSize: b.size,
                lineHeight: 1,
                color: props.ink,
                whiteSpace: "nowrap",
                opacity: states[i]?.item ?? 1,
              }}
            >
              {b.text}
            </div>
          ))}
      {props.line && edge >= 0 && lineFont > 0 ? (
        <AbsoluteFill style={{ clipPath: `inset(0 ${Math.max(0, width - edge)}px 0 0)` }}>
          <div
            style={{
              position: "absolute",
              left: props.bandFrom * width,
              top: props.targetY * height,
              transform: "translateY(-50%)",
              fontFamily: primaryFont,
              fontWeight: 500,
              fontSize: lineFont,
              lineHeight: 1.1,
              color: props.lineInk,
              whiteSpace: "nowrap",
            }}
          >
            {props.line}
          </div>
        </AbsoluteFill>
      ) : null}
      {states.map((st, i) =>
        st.gone || st.dot <= 0 ? null : (
          <div
            key={`d${i}`}
            style={{
              position: "absolute",
              left: st.x - st.r,
              top: st.y - st.r,
              width: st.r * 2,
              height: st.r * 2,
              borderRadius: "50%",
              backgroundColor: props.dot,
              transform: `scale(${st.dot})`,
            }}
          />
        ),
      )}
      {blob > 0 ? (
        <div
          style={{
            position: "absolute",
            left: timing.target.x - blob,
            top: timing.target.y - blob,
            width: blob * 2,
            height: blob * 2,
            borderRadius: "50%",
            backgroundColor: props.dot,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
