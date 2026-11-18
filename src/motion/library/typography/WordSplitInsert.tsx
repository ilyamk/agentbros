import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { splitGraphemes } from "../../text-split";
import { progress } from "../../timing";
import { splitCurves, splitState } from "../../type-track";
import type { Cue } from "../types";
import { FACE_NAMES, faceRun, faceStyle } from "./faces";
import { useTextWidths } from "./fit";
import { Stage, resolveInk } from "./Stage";

export const wordSplitInsertSchema = z.object({
  /** One word ("Move") or a short line ("Just ask"). */
  text: z.string().min(2),
  /** Grapheme index the text splits at; -1 splits at the space nearest the middle, or mid-word when there is none. */
  splitAt: z.number().int(),
  /** "part": the halves frame the insert and hold. "fling": the halves scale up and are thrown off both edges while the insert holds centre. */
  mode: z.enum(["part", "fling"]),
  /** Frame the text is on (a cut: no ramp). */
  at: z.number().int().nonnegative(),
  /** Frame the halves start to part, and frames to open the first gap (accelerating). */
  openAt: z.number().int().nonnegative(),
  openFrames: z.number().int().min(1).max(20),
  /** First gap as a share of the frame width (0.08 measured). */
  gap: z.number().min(0).max(0.3),
  /** Frame the insert appears in the gap, and frames it takes to settle. */
  insertAt: z.number().int().nonnegative(),
  settleFrames: z.number().int().min(1).max(20),
  /** Frames of the fling (mode "fling"); it starts when the insert is full, jumping most of the way on its first frame. */
  flingFrames: z.number().int().min(4).max(40),
  /** Scale the halves reach as they are thrown. */
  flingScale: z.number().min(1).max(3),
  /** The inserted element: a disc (portrait or mark), a card (screenshot), a pill (label or connector) or a bare image. Pass `children` for anything else. */
  insert: z.enum(["disc", "card", "pill", "image"]),
  /** "grow": from a dot in the gap. "rise": up from below, tilted back in depth, settling flat. */
  insertEntry: z.enum(["grow", "rise"]),
  /** Insert width as a share of the frame width once settled. */
  insertWidth: z.number().min(0.03).max(0.8),
  /** Image under public/ (staticFile path) shown in the disc, card or image; empty for none. */
  src: z.string(),
  /** Short label drawn in the insert when there is no image; empty for none. */
  label: z.string(),
  insertFill: z.string(),
  insertInk: z.string(),
  face: z.enum(FACE_NAMES),
  /** Width of the closed text as a share of the frame width. */
  width: z.number().min(0.15).max(0.95),
  /** Centre of the closed text, share of the width (0.5 centred). */
  x: z.number().min(0.1).max(0.9),
  ground: z.string(),
  /** "auto" picks paper-white or near-black for the ground. */
  ink: z.string(),
  grain: z.number().min(0).max(0.2),
});

export type WordSplitInsertProps = z.infer<typeof wordSplitInsertSchema> & { children?: React.ReactNode };

/** Where the text splits: the given index, else the space nearest the middle, else mid-word. */
export const splitIndex = (text: string, splitAt: number): number => {
  const graphemes = splitGraphemes(text);
  if (splitAt > 0 && splitAt < graphemes.length) return splitAt;
  const middle = graphemes.length / 2;
  let best = -1;
  graphemes.forEach((g, i) => {
    if (g === " " && (best < 0 || Math.abs(i - middle) < Math.abs(best - middle))) best = i;
  });
  return best > 0 ? best : Math.max(1, Math.round(middle));
};

const halves = (text: string, splitAt: number): [string, string] => {
  const graphemes = splitGraphemes(text);
  const index = splitIndex(text, splitAt);
  return [graphemes.slice(0, index).join("").replace(/\s+$/, ""), graphemes.slice(index).join("").replace(/^\s+/, "")];
};

const INSERT_RATIO = { disc: 1, card: 0.64, pill: 0.34, image: 0.66 } as const;

/**
 * A word or line splits open and an element settles into the gap: the gap opens accelerating, the insert grows from a
 * dot (or rises from below, tilted, and settles flat) in about 5 frames, then the halves either frame it or are thrown
 * off both edges. The eye already rests in the gap of a centred line, so the insert needs no travel.
 */
export const WordSplitInsert: React.FC<WordSplitInsertProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const set = faceStyle(p.face);
  const [left, right] = halves(p.text, p.splitAt);
  const measured = useTextWidths([faceRun(p.face, left), faceRun(p.face, right), faceRun(p.face, p.text)], 100);
  const ink = resolveInk(p.ink, p.ground);
  if (measured === null || frame < p.at)
    return (
      <Stage background={p.ground} grain={p.grain}>
        {null}
      </Stage>
    );

  const [leftW100, rightW100, fullW100] = measured as [number, number, number];
  const fontSize = Math.min((width * p.width * 100) / Math.max(fullW100, 1), height * 0.42);
  const leftW = (leftW100 * fontSize) / 100;
  const fullW = (fullW100 * fontSize) / 100;
  const join = Math.max(0, fullW - leftW - (rightW100 * fontSize) / 100);
  const lineX = width * p.x - fullW / 2;
  const gapX = lineX + leftW + join / 2;
  const cy = height / 2;

  const insertW = width * p.insertWidth;
  const insertH = insertW * INSERT_RATIO[p.insert];
  const options = {
    openAt: p.openAt,
    openFrames: p.openFrames,
    gap: width * p.gap,
    insertAt: p.insertAt,
    settleFrames: p.settleFrames,
    insertWidth: insertW,
    margin: fontSize * 0.14,
    mode: p.mode,
    flingFrames: p.flingFrames,
    // Each half ends with its inner edge on its frame edge: the jump puts it near the edge, the drift takes it out.
    flingDistance: [gapX, width - gapX] as const,
    flingScale: p.flingScale,
  };
  const state = splitState(frame, options);
  const caps = p.face === "condensed" || p.face === "wide";
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
    color: ink,
    whiteSpace: "pre",
  };
  const shown = (text: string) => (caps ? text.toUpperCase() : text);

  // The insert: a dot growing to full size, or a rise from below with a depth tilt that is gone (2D) once settled.
  const t = state.insert;
  const visible = frame >= p.insertAt;
  const rising = p.insertEntry === "rise";
  const dot = Math.min(insertW, insertH, width * 0.012);
  const w = rising ? insertW * (0.7 + 0.3 * t) : dot + (insertW - dot) * t;
  const h = rising ? insertH * (0.7 + 0.3 * t) : dot + (insertH - dot) * t;
  const lift = rising ? (1 - t) * height * 0.35 : 0;
  const tilt = rising && t < 1 ? (1 - t) * 24 : 0;
  const motionBlur = rising && t < 1 ? (1 - t) * 10 : 0;
  const radius = p.insert === "disc" ? h / 2 : p.insert === "pill" ? h / 2 : Math.min(w, h) * 0.07;
  // Directional blur from this frame's travel, outside any scale so it reads at its true size.
  const travel =
    p.mode === "fling" && frame >= p.insertAt + p.settleFrames
      ? Math.abs(state.right - splitState(frame - 1, options).right)
      : 0;
  const blurFling = Math.min(16, travel * 0.05);

  const content =
    p.children ??
    (p.src ? (
      <Img src={staticFile(p.src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    ) : p.label ? (
      <div
        style={{
          fontFamily: set.fontFamily,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          fontSize: Math.min(h * 0.44, (w * 0.8) / Math.max(p.label.length * 0.55, 1)),
          color: p.insertInk,
          opacity: progress(frame, p.insertAt + Math.max(1, p.settleFrames - 2), 4, "expoOut"),
          whiteSpace: "pre",
        }}
      >
        {p.label}
      </div>
    ) : null);

  return (
    <Stage background={p.ground} grain={p.grain}>
      <AbsoluteFill>
        <div
          style={{
            ...type,
            left: lineX + state.left,
            transform: `scale(${state.scale})`,
            transformOrigin: `${leftW}px 50%`,
            filter: blurFling > 0.2 ? `blur(${blurFling}px)` : undefined,
          }}
        >
          {shown(left)}
        </div>
        <div
          style={{
            ...type,
            left: lineX + leftW + join + state.right,
            transform: `scale(${state.scale})`,
            transformOrigin: "0px 50%",
            filter: blurFling > 0.2 ? `blur(${blurFling}px)` : undefined,
          }}
        >
          {shown(right)}
        </div>
        {visible ? (
          <div
            style={{
              position: "absolute",
              left: gapX - w / 2,
              top: cy - h / 2 + lift,
              width: w,
              height: h,
              borderRadius: radius,
              overflow: "hidden",
              backgroundColor: p.insert === "image" ? "transparent" : p.insertFill,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transform: tilt > 0 ? `perspective(${width * 1.2}px) rotateX(${tilt}deg)` : undefined,
              filter: motionBlur > 0.3 ? `blur(${motionBlur}px)` : undefined,
              boxShadow: p.insert === "card" ? `0 ${h * 0.04}px ${h * 0.12}px rgba(0,0,0,0.18)` : undefined,
            }}
          >
            {t > 0.25 ? content : null}
          </div>
        ) : null}
      </AbsoluteFill>
    </Stage>
  );
};

export const wordSplitInsertDefaults: z.infer<typeof wordSplitInsertSchema> = {
  text: "Move",
  splitAt: 2,
  mode: "part",
  at: 0,
  openAt: 20,
  openFrames: 5,
  gap: 0.08,
  insertAt: 25,
  settleFrames: 5,
  flingFrames: 13,
  flingScale: 1.6,
  insert: "pill",
  insertEntry: "grow",
  insertWidth: 0.24,
  src: "",
  label: "USD / EUR",
  insertFill: "#1E1A16",
  insertInk: "#F2F4E9",
  face: "grotesk",
  width: 0.42,
  x: 0.5,
  ground: "#F2F4E9",
  ink: "#1E1A16",
  grain: 0.03,
};

/** Muse's version: two words, a disc pops in the gap and the words are thrown off both edges. */
export const wordSplitInsertFlingPreset: z.infer<typeof wordSplitInsertSchema> = {
  ...wordSplitInsertDefaults,
  text: "Just ask",
  splitAt: -1,
  mode: "fling",
  openAt: 19,
  openFrames: 2,
  gap: 0.02,
  insertAt: 21,
  settleFrames: 3,
  flingScale: 2.2,
  insert: "disc",
  insertWidth: 0.3,
  label: "Ada",
  insertFill: "#2E6BF0",
  insertInk: "#F7F7F2",
  width: 0.5,
  ground: "#EEF2F6",
  ink: "#17181A",
};

export const wordSplitInsertCues = (p: z.infer<typeof wordSplitInsertSchema>): Cue[] => [
  { frame: p.at, kind: "cut", sfx: "none", weight: "support", label: "text on" },
  ...(p.gap > 0
    ? [
        {
          frame: p.openAt,
          kind: "reveal" as const,
          sfx: "whoosh" as const,
          weight: "support" as const,
          label: "gap opens",
        },
      ]
    : []),
  { frame: p.insertAt, kind: "hit", sfx: "pop", weight: "hero", label: "insert in the gap" },
  p.mode === "fling"
    ? { frame: p.insertAt + p.settleFrames, kind: "exit", sfx: "whoosh", weight: "support", label: "halves thrown off" }
    : { frame: p.insertAt + p.settleFrames, kind: "land", sfx: "none", weight: "support", label: "insert settles" },
];
