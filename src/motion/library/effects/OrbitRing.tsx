import React from "react";
import { AbsoluteFill, Img, random, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { curves } from "../../timing";
import type { Cue } from "../types";
import { orbitPoints, type OrbitPoint } from "./flash-plan";

/** 3x5 dot-matrix bitmaps, row by row; characters not listed draw as a single dot. Drawn as paths, not text. */
const BITMAPS: Record<string, string> = {
  "0": "111101101101111",
  "1": "010110010010111",
  "+": "000010111010000",
  ":": "000010000010000",
  ".": "000000000000010",
  "#": "101111101111101",
  "*": "000101010101000",
  "%": "101001010100101",
  "-": "000000111000000",
  "/": "001001010100100",
};

/** Path of a glyph's lit pixels as squares in a 3x5 box centred on 0,0, one unit per pixel. */
export const glyphPath = (glyph: string): string => {
  const bits = BITMAPS[glyph] ?? "000000010000000";
  let d = "";
  for (let i = 0; i < 15; i++)
    if (bits[i] === "1") d += `M${(i % 3) - 1.5 + 0.1} ${Math.floor(i / 3) - 2.5 + 0.1}h0.8v0.8h-0.8z`;
  return d;
};

export const orbitRingSchema = z.object({
  /** "glyph": a dot-matrix of characters; "dot": round dots; "card": rounded thumbnails (images from `images`). */
  shape: z.enum(["glyph", "dot", "card"]),
  /** Cells per row and number of concentric rows. */
  count: z.number().int().min(4).max(96),
  rows: z.number().int().min(1).max(6),
  /** Ring radius as a share of the frame's shorter side (0.28 ≈ a ring 0.55 of the height across). */
  radius: z.number().min(0.1).max(0.8),
  /** Space between rows as a share of the radius. */
  rowGap: z.number().min(0).max(0.4),
  /** How far the ring is tipped back, degrees (0 faces the viewer, 75 nearly edge-on). */
  tilt: z.number().min(0).max(85),
  /** Roll of the ring's axis in the frame, degrees. */
  roll: z.number().min(-90).max(90),
  /** Turn speed, degrees a second (negative turns the other way). */
  spin: z.number().min(-360).max(360),
  /** Cell size as a share of the shorter side. */
  cell: z.number().min(0.004).max(0.12),
  /** Characters the glyph cells draw from, seeded per cell, drawn as 3x5 dot-matrix bitmaps: 0 1 + : . # * % - / (others a single dot). */
  glyphs: z.string().min(1),
  /** Frames each glyph's brightness holds before re-rolling (0 holds still). */
  twinkle: z.number().int().min(0).max(30),
  ink: z.string(),
  accent: z.string(),
  /** Share of cells drawn in the accent colour. */
  accentShare: z.number().min(0).max(1),
  /** "transparent" lays the ring over footage. */
  ground: z.string(),
  /** Card images inside public/ (shape "card"); empty draws seeded tones. */
  images: z.array(z.string()),
  /** Entry by contraction from beyond the frame: start frame (-1 none) and length (expo out). */
  enterAt: z.number().int().min(-1),
  enterFrames: z.number().int().min(1).max(60),
  /** Fly-past exit: the ring expands off every edge from `flyAt` (-1 none) over `flyFrames`, accelerating (power2.in). */
  flyAt: z.number().int().min(-1),
  flyFrames: z.number().int().min(1).max(60),
  /** Scale the ring reaches at the end of the fly-past. */
  flyScale: z.number().min(1.5).max(8),
  seed: z.string(),
  /** Preview only: the line held at the centre, and the headline that replaces it one frame after the ring is gone. */
  line: z.string(),
  headline: z.string(),
});

export type OrbitRingProps = z.infer<typeof orbitRingSchema>;

export const ORBIT_RING_FRAMES = 120;

export const orbitRingDefaults: OrbitRingProps = {
  shape: "glyph",
  count: 68,
  rows: 5,
  radius: 0.36,
  rowGap: 0.075,
  tilt: 56,
  roll: -14,
  spin: 34,
  cell: 0.026,
  glyphs: "01+:.#*%",
  twinkle: 3,
  ink: "#141414",
  accent: "#2A45E0",
  accentShare: 0.08,
  ground: "#F2F1EC",
  images: [],
  enterAt: 0,
  enterFrames: 16,
  flyAt: 98,
  flyFrames: 12,
  flyScale: 4.2,
  seed: "orbit",
  line: "Every frame, on purpose.",
  headline: "On purpose.",
};

/** Ring scale on `frame`: contracting in from 2.6× (expo out), 1 while it orbits, expanding past the frame on the fly-past. */
export const orbitScaleAt = (
  frame: number,
  {
    enterAt,
    enterFrames,
    flyAt,
    flyFrames,
    flyScale,
  }: Pick<OrbitRingProps, "enterAt" | "enterFrames" | "flyAt" | "flyFrames" | "flyScale">,
): number => {
  let scale = 1;
  if (enterAt >= 0 && frame < enterAt + enterFrames)
    scale = 2.6 - 1.6 * curves.expoOut(Math.max(0, (frame - enterAt) / enterFrames));
  if (flyAt >= 0 && frame >= flyAt)
    scale = 1 + (flyScale - 1) * curves.quadIn(Math.min(1, (frame - flyAt) / flyFrames));
  return scale;
};

/** Frame the ring is fully gone (fly-past end), or -1. */
export const orbitGoneAt = ({ flyAt, flyFrames }: Pick<OrbitRingProps, "flyAt" | "flyFrames">): number =>
  flyAt >= 0 ? flyAt + flyFrames : -1;

export const orbitRingCues = ({
  enterAt,
  enterFrames,
  flyAt,
  flyFrames,
}: Pick<OrbitRingProps, "enterAt" | "enterFrames" | "flyAt" | "flyFrames">): Cue[] => {
  const cues: Cue[] = [];
  if (enterAt >= 0)
    cues.push(
      { frame: enterAt, kind: "reveal", sfx: "whoosh", weight: "support", label: "ring contracts in" },
      { frame: enterAt + enterFrames, kind: "land", sfx: "none", weight: "support", label: "ring settles" },
    );
  if (flyAt >= 0)
    cues.push(
      { frame: flyAt, kind: "exit", sfx: "whoosh", weight: "support", label: "ring flies past" },
      { frame: flyAt + flyFrames, kind: "cut", sfx: "impact", weight: "hero", label: "headline replaces the line" },
    );
  return cues;
};

const Cell: React.FC<{ p: OrbitPoint; props: OrbitRingProps; size: number; cx: number; cy: number; scale: number }> = ({
  p,
  props,
  size,
  cx,
  cy,
  scale,
}) => {
  const key = `${props.seed}-${p.row}-${p.index}`;
  const accent = random(`${key}-accent`) < props.accentShare;
  const colour = accent ? props.accent : props.ink;
  const s = size * p.scale * Math.sqrt(scale);
  const x = cx + p.x * scale;
  const y = cy + p.y * scale;
  // Cells further back are fainter as well as smaller.
  const depth = 0.55 + 0.45 * Math.max(0, Math.min(1, (p.scale - 0.7) / 0.6));
  if (props.shape === "dot")
    return <circle cx={x} cy={y} r={s * 0.32 * (0.5 + 0.5 * p.glow)} fill={colour} opacity={depth} />;
  if (props.shape === "card") {
    const w = s * 2.2;
    const h = s * 1.5;
    const tone = Math.round(70 + 120 * random(`${key}-tone`));
    const image = props.images.length ? props.images[(p.row * props.count + p.index) % props.images.length] : undefined;
    return (
      <foreignObject x={x - w / 2} y={y - h / 2} width={w} height={h} opacity={depth}>
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: s * 0.25,
            overflow: "hidden",
            backgroundColor: `rgb(${tone}, ${tone + 8}, ${tone + 16})`,
            boxShadow: `0 ${s * 0.08}px ${s * 0.2}px rgba(0,0,0,0.18)`,
          }}
        >
          {image ? <Img src={staticFile(image)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
        </div>
      </foreignObject>
    );
  }
  const glyph = props.glyphs[Math.floor(random(`${key}-glyph`) * props.glyphs.length)]!;
  return (
    <path
      d={glyphPath(glyph)}
      transform={`translate(${x} ${y}) scale(${s / 5.5})`}
      fill={colour}
      opacity={depth * p.glow}
    />
  );
};

/**
 * A ring of cells (a dot matrix of glyphs, dots or thumbnail cards) orbiting a subject on a tipped ellipse with
 * perspective: the back half passes behind the children, the front half in front. It can arrive contracting from beyond
 * the frame and leave by flying past the camera, expanding off every edge in 12 frames and leaving the subject alone.
 */
export const OrbitRing: React.FC<Omit<OrbitRingProps, "line" | "headline"> & { children?: React.ReactNode }> = ({
  children,
  ...props
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const short = Math.min(width, height);
  const scale = orbitScaleAt(frame, props);
  const gone = orbitGoneAt(props);
  const points =
    gone >= 0 && frame >= gone
      ? []
      : orbitPoints(frame, {
          count: props.count,
          rows: props.rows,
          radius: props.radius * short,
          rowGap: props.rowGap,
          tilt: props.tilt,
          roll: props.roll,
          angle: (frame / fps) * props.spin,
          seed: props.seed,
          twinkle: props.twinkle,
        });
  const size = props.cell * short;
  const cx = width / 2;
  // Perspective enlarges the near half; centre the ring's projected extent on the subject instead of its axis.
  const ys = points.map((p) => p.y);
  const cy = height / 2 - (ys.length ? ((Math.min(...ys) + Math.max(...ys)) / 2) * scale : 0);
  const half = (front: boolean) => (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0, overflow: "visible" }} aria-hidden>
      {points
        .filter((p) => p.z >= 0 === front)
        .sort((a, b) => a.z - b.z)
        .map((p) => (
          <Cell
            key={`${p.row}-${p.index}`}
            p={p}
            props={props as OrbitRingProps}
            size={size}
            cx={cx}
            cy={cy}
            scale={scale}
          />
        ))}
    </svg>
  );
  return (
    <AbsoluteFill
      style={{ backgroundColor: props.ground === "transparent" ? undefined : props.ground, overflow: "hidden" }}
    >
      {half(false)}
      {children ? <AbsoluteFill>{children}</AbsoluteFill> : null}
      {half(true)}
    </AbsoluteFill>
  );
};

/** Preview: the ring contracts in around a centred line, orbits, flies past, and the headline replaces the line. */
export const OrbitRingPreview: React.FC<OrbitRingProps> = ({ line, headline, ...props }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const short = Math.min(width, height);
  const gone = orbitGoneAt(props);
  // motionfly t14: the line is alone for one frame after the ring has gone, then the larger headline replaces it.
  const showHeadline = gone >= 0 && frame >= gone + 1;
  return (
    <OrbitRing {...props}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            fontFamily: primaryFont,
            fontWeight: showHeadline ? 700 : 500,
            fontSize: short * (showHeadline ? 0.11 : 0.042),
            letterSpacing: showHeadline ? "-0.04em" : "-0.01em",
            color: props.ink,
            maxWidth: width * 0.8,
            textAlign: "center",
            lineHeight: 1,
          }}
        >
          {showHeadline ? headline : line}
        </div>
      </AbsoluteFill>
    </OrbitRing>
  );
};
