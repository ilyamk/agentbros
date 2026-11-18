import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { displayFont, primaryFont } from "../../../lib/fonts";
import { intentCurves, progress } from "../../timing";
import type { Cue } from "../types";

const anchorSchema = z.object({
  /** Centre of the subject, as a share of the frame width. */
  x: z.number().min(0).max(1),
  /** Centre of the subject, as a share of the frame height. */
  y: z.number().min(0).max(1),
  /** Diameter of the subject, as a share of the shorter frame side. */
  size: z.number().min(0.01).max(1.5),
});

export type MatchAnchor = z.infer<typeof anchorSchema>;

export type MatchCutTiming = {
  /** Frame, relative to the block's start, where the cut lands: the last frame of the old shot is seamFrame - 1. */
  seamFrame: number;
  /** Outgoing subject: where it sits in the old shot before the move. */
  from: MatchAnchor;
  /** Incoming subject: where the same shape sits in the new shot once settled. */
  to: MatchAnchor;
  /** Frames before the seam over which the old shot pushes in on its subject, accelerating into the cut; its last frame (seamFrame - 1) is at `push`. */
  approach: number;
  /** Frames after the seam over which the new shot pulls back from the matched framing to its own. */
  settle: number;
  /** How far the old shot pushes in on its subject by the seam (2.6 = 2.6 times bigger). */
  push: number;
};

export type MatchPose = { side: "before" | "after"; scale: number; x: number; y: number };

/** Scale and subject centre (pixels) of a shot whose subject `anchor` is shown at `scale` with its centre at (cx, cy). */
const placed = (anchor: MatchAnchor, scale: number, cx: number, cy: number, width: number, height: number) => ({
  scale,
  x: cx - anchor.x * width * scale,
  y: cy - anchor.y * height * scale,
});

/**
 * Transform of the visible shot at a frame (origin top-left, translate, then scale). Before the seam the old shot
 * pushes in on its subject (`from`) on `expoIn`. On the seam the new shot appears framed so its subject (`to`) has the
 * same place and size as the old subject had; it then pulls back to its own framing on `brake`. Both shots stay at a
 * scale of 1 or more, so no edge ever shows. Pure.
 */
export const matchCutPose = (frame: number, timing: MatchCutTiming, width: number, height: number): MatchPose => {
  const { seamFrame, from, to, approach, settle, push } = timing;
  const fx = from.x * width;
  const fy = from.y * height;
  if (frame < seamFrame) {
    const k = push ** progress(frame, seamFrame - approach, approach - 1, "expoIn");
    return { side: "before", ...placed(from, k, fx, fy, width, height) };
  }
  // Matched framing: the new subject as big as the old one at the seam, never below the shot's own size.
  const start = Math.max(1, (from.size * push) / to.size);
  const q = progress(frame, seamFrame, settle, intentCurves.brake);
  const k = start ** (1 - q);
  const cx = fx + (to.x * width - fx) * q;
  const cy = fy + (to.y * height - fy) * q;
  return { side: "after", ...placed(to, k, cx, cy, width, height) };
};

/**
 * A 0-frame cut where one shape becomes another: the old shot pushes its subject onto the place and size of the new
 * shot's subject, the cut lands on `seamFrame`, and the new shot pulls back from that framing to its own. Author both shots so
 * the subjects really share silhouette and colour; nothing is cross-faded. 2D transforms only.
 */
export const MatchCutMove: React.FC<MatchCutTiming & { before: React.ReactNode; after: React.ReactNode }> = ({
  before,
  after,
  ...timing
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const pose = matchCutPose(frame, timing, width, height);
  const transform = `translate(${pose.x}px, ${pose.y}px) scale(${pose.scale})`;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Sequence durationInFrames={timing.seamFrame} layout="none" name="Before match">
        <AbsoluteFill style={{ transform, transformOrigin: "0 0" }}>{before}</AbsoluteFill>
      </Sequence>
      <Sequence from={timing.seamFrame} layout="none" name="After match">
        <AbsoluteFill style={{ transform, transformOrigin: "0 0" }}>{after}</AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};

/** The cut on `seamFrame` (relative to the block's start), and the settle a little after it. */
export const matchCutCues = ({ seamFrame, settle }: Pick<MatchCutTiming, "seamFrame" | "settle">): Cue[] => [
  { frame: seamFrame, kind: "cut", sfx: "whoosh", weight: "hero", label: "match cut" },
  { frame: seamFrame + Math.round(settle * 0.6), kind: "land", weight: "support", label: "new shot settles" },
];

export const matchCutSchema = z.object({
  seamFrame: z.number().int().min(1),
  from: anchorSchema,
  to: anchorSchema,
  approach: z.number().int().min(2).max(40),
  settle: z.number().int().min(2).max(40),
  push: z.number().min(1).max(8),
  /** Preview only: the clock caption of the first shot and the word the dot ends in the second. */
  caption: z.string(),
  word: z.string(),
  accent: z.string(),
});

export type MatchCutProps = z.infer<typeof matchCutSchema>;

export const MATCH_CUT_FRAMES = 90;

export const matchCutDefaults: MatchCutProps = {
  seamFrame: 48,
  from: { x: 0.64, y: 0.5, size: 0.2 },
  to: { x: 0.8, y: 0.6, size: 0.075 },
  approach: 16,
  settle: 18,
  push: 2.6,
  caption: "REC  00:07:59",
  word: "Rolling",
  accent: "#FF5A2C",
};

const NIGHT = "#0B0D12";
const CHALK = "#F2F0EA";
const PAPER = "#F3F2EE";
const INK = "#121212";

/** Shot one: a lens at night, its red record light in the middle, a timecode in the corner. */
const LensShot: React.FC<{ anchor: MatchAnchor; caption: string; accent: string }> = ({ anchor, caption, accent }) => {
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height);
  const u = unit / 1080;
  const d = anchor.size * unit;
  const cx = anchor.x * width;
  const cy = anchor.y * height;
  const ring = (scale: number, stroke: string, w: number) => (
    <div
      style={{
        position: "absolute",
        left: cx - (d * scale) / 2,
        top: cy - (d * scale) / 2,
        width: d * scale,
        height: d * scale,
        borderRadius: "50%",
        border: `${w * u}px solid ${stroke}`,
        boxSizing: "border-box",
      }}
    />
  );
  return (
    <AbsoluteFill style={{ backgroundColor: NIGHT }}>
      {ring(4.2, "rgba(242,240,234,0.06)", 2)}
      {ring(3.3, "rgba(242,240,234,0.12)", 22)}
      {ring(2.4, "#1B1F2A", 40)}
      {ring(1.55, "rgba(242,240,234,0.18)", 3)}
      <div
        style={{
          position: "absolute",
          left: cx - d / 2,
          top: cy - d / 2,
          width: d,
          height: d,
          borderRadius: "50%",
          backgroundColor: accent,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 80 * u,
          top: 80 * u,
          fontFamily: primaryFont,
          fontWeight: 600,
          fontSize: 30 * u,
          letterSpacing: "0.14em",
          color: CHALK,
          whiteSpace: "pre",
          display: "flex",
          alignItems: "center",
          gap: 16 * u,
        }}
      >
        <span style={{ width: 16 * u, height: 16 * u, borderRadius: "50%", backgroundColor: accent }} />
        {caption}
      </div>
    </AbsoluteFill>
  );
};

/** Shot two: the record light is now the full stop of a word on paper. */
const WordShot: React.FC<{ anchor: MatchAnchor; word: string; accent: string }> = ({ anchor, word, accent }) => {
  const { width, height } = useVideoConfig();
  const unit = Math.min(width, height);
  const d = anchor.size * unit;
  const cx = anchor.x * width;
  const cy = anchor.y * height;
  const fontSize = d * 3.1;
  return (
    <AbsoluteFill style={{ backgroundColor: PAPER }}>
      {/* The word ends just left of the dot; its baseline sits on the dot's bottom edge. */}
      <div
        style={{
          position: "absolute",
          right: width - (cx - d * 0.62),
          bottom: height - (cy + d / 2) - fontSize * 0.2,
          fontFamily: displayFont,
          fontWeight: 700,
          fontSize,
          lineHeight: 1,
          letterSpacing: "-0.05em",
          color: INK,
          whiteSpace: "nowrap",
        }}
      >
        {word}
      </div>
      <div
        style={{
          position: "absolute",
          left: cx - d / 2,
          top: cy - d / 2,
          width: d,
          height: d,
          borderRadius: "50%",
          backgroundColor: accent,
        }}
      />
    </AbsoluteFill>
  );
};

/** Library preview: a camera's record light pushes in and cuts to the full stop of a word on paper. */
export const MatchCutPreview: React.FC<MatchCutProps> = ({ caption, word, accent, ...timing }) => (
  <MatchCutMove
    {...timing}
    before={<LensShot anchor={timing.from} caption={caption} accent={accent} />}
    after={<WordShot anchor={timing.to} word={word} accent={accent} />}
  />
);
