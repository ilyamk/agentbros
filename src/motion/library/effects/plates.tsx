import { Video } from "@remotion/media";
import React from "react";
import { AbsoluteFill, Img, random, staticFile, useVideoConfig } from "remotion";

/**
 * Neutral procedural plates that stand in for footage in previews and defaults: no binary assets, drawn per frame in
 * SVG. A film passes its own pictures (`src`, a path inside public/) or children instead.
 */
export const PLATE_KINDS = ["crescent", "desk", "disc", "horizon", "spheres", "figure"] as const;
export type PlateKind = (typeof PLATE_KINDS)[number];

/** Rough gamma luma of a #rrggbb colour, 0..1. */
export const hexLuma = (hex: string): number => {
  const [r, g, b] = hexRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** #rgb or #rrggbb to 0..255 channels; anything else reads as mid grey. */
export const hexRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [128, 128, 128];
  const h =
    m[1]!.length === 3
      ? m[1]!
          .split("")
          .map((c) => c + c)
          .join("")
      : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

const VIDEO = /\.(mp4|webm|mov|m4v)$/i;

/** A picture from public/: `<Video>` (muted) for a clip, `<Img>` otherwise, cover-fitted. */
export const MediaPlate: React.FC<{ src: string; fit?: "cover" | "contain" }> = ({ src, fit = "cover" }) =>
  VIDEO.test(src) ? (
    <Video src={staticFile(src)} muted objectFit={fit} style={{ width: "100%", height: "100%" }} />
  ) : (
    <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: fit }} />
  );

/** `src` when given, else children, else the procedural plate. */
export const PlateSource: React.FC<{
  src?: string;
  kind?: PlateKind;
  seed?: string;
  palette?: [string, string, string];
  children?: React.ReactNode;
}> = ({ src, kind = "spheres", seed = "plate", palette, children }) => {
  if (src) return <MediaPlate src={src} />;
  if (children) return <>{children}</>;
  return <ProcPlate kind={kind} seed={seed} palette={palette} />;
};

const DEFAULT_PALETTE: Record<PlateKind, [string, string, string]> = {
  // ground, mid, light
  crescent: ["#060B10", "#1D5C6E", "#E8FBFF"],
  desk: ["#2B2C26", "#9A9C8C", "#D9DACB"],
  disc: ["#F1EEE6", "#8A8578", "#141414"],
  horizon: ["#2C3440", "#7C8A96", "#D7DEE4"],
  spheres: ["#E9E5DC", "#8C8678", "#1C1B19"],
  figure: ["#D9D4C8", "#6F6A60", "#23211E"],
};

/**
 * A plate with tone, edges and a subject, so grades, dots and cuts have something to act on: a glowing crescent on
 * black (macro), a lit desk with pencil shadows, a disc on paper, a horizon, two shaded spheres, a seated figure.
 */
export const ProcPlate: React.FC<{ kind: PlateKind; seed?: string; palette?: [string, string, string] }> = ({
  kind,
  seed = "plate",
  palette,
}) => {
  const { width, height } = useVideoConfig();
  const [g, m, l] = palette ?? DEFAULT_PALETTE[kind];
  const s = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const r = (k: string) => random(`${seed}-${k}`);
  const [bright, dark] = hexLuma(g) > hexLuma(l) ? [g, l] : [l, g];
  const id = `${kind}-${seed}`.replace(/[^a-z0-9-]/gi, "");
  return (
    <AbsoluteFill style={{ backgroundColor: g }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0 }}
        aria-hidden
      >
        <defs>
          <radialGradient id={`glow-${id}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={l} />
            <stop offset="35%" stopColor={m} />
            <stop offset="100%" stopColor={g} stopOpacity={0} />
          </radialGradient>
          <radialGradient id={`ball-${id}`} cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor={bright} />
            <stop offset="45%" stopColor={m} />
            <stop offset="100%" stopColor={dark} />
          </radialGradient>
          <radialGradient id={`vig-${id}`} cx="50%" cy="50%" r="72%">
            <stop offset="55%" stopColor="#000" stopOpacity={0} />
            <stop offset="100%" stopColor="#000" stopOpacity={0.55} />
          </radialGradient>
          <linearGradient id={`sky-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={g} />
            <stop offset="100%" stopColor={l} />
          </linearGradient>
        </defs>
        {kind === "crescent" ? (
          <>
            <ellipse cx={cx} cy={cy} rx={s * 0.42} ry={s * 0.3} fill={`url(#glow-${id})`} opacity={0.55} />
            <path
              d={`M ${cx - s * 0.16} ${cy + s * 0.05} Q ${cx + s * 0.02} ${cy - s * 0.02} ${cx + s * 0.08} ${cy - s * 0.2} Q ${cx + s * 0.02} ${cy + s * 0.02} ${cx + s * 0.2} ${cy + s * 0.1} Q ${cx} ${cy + s * 0.02} ${cx - s * 0.16} ${cy + s * 0.05} Z`}
              fill={l}
              opacity={0.92}
            />
            <ellipse cx={cx - s * 0.02} cy={cy + s * 0.02} rx={s * 0.08} ry={s * 0.05} fill={l} opacity={0.6} />
          </>
        ) : null}
        {kind === "desk" ? (
          <>
            <rect width={width} height={height} fill={l} />
            <ellipse cx={cx} cy={cy} rx={width * 0.6} ry={height * 0.6} fill={m} opacity={0.25} />
            <path
              d={`M ${width * (0.38 + r("a") * 0.1)} 0 L ${width * 0.5} ${height * 0.62} L ${width * 0.56} ${height * 0.6} L ${width * 0.6} 0 Z`}
              fill={g}
              opacity={0.55}
            />
            <path
              d={`M 0 ${height * 0.7} Q ${cx} ${height * 0.55} ${width} ${height * 0.68}`}
              stroke={g}
              strokeWidth={s * 0.006}
              fill="none"
            />
            <path
              d={`M 0 ${height * 0.82} Q ${cx} ${height * 0.62} ${width} ${height * 0.86}`}
              stroke={g}
              strokeWidth={s * 0.004}
              fill="none"
              opacity={0.8}
            />
          </>
        ) : null}
        {kind === "disc" ? (
          <>
            <circle
              cx={width * (0.58 + r("x") * 0.1)}
              cy={height * (0.5 + (r("y") - 0.5) * 0.1)}
              r={s * 0.3}
              fill={l}
            />
            <rect x={width * 0.08} y={height * 0.12} width={width * 0.32} height={s * 0.018} fill={l} />
            <rect x={width * 0.08} y={height * 0.12 + s * 0.04} width={width * 0.2} height={s * 0.018} fill={m} />
          </>
        ) : null}
        {kind === "horizon" ? (
          <>
            <rect width={width} height={height} fill={`url(#sky-${id})`} />
            <circle
              cx={width * (0.25 + r("sun") * 0.5)}
              cy={height * (0.16 + r("sy") * 0.12)}
              r={s * (0.06 + r("sr") * 0.05)}
              fill={l}
            />
            <path
              d={`M 0 ${height * 0.62} ${Array.from({ length: 9 }, (_, i) => `L ${(width * (i + 1)) / 8} ${height * (0.56 + r(`h${i}`) * 0.12)}`).join(" ")} L ${width} ${height} L 0 ${height} Z`}
              fill={g}
            />
            <path
              d={`M 0 ${height * 0.8} Q ${cx} ${height * (0.72 + r("q") * 0.06)} ${width} ${height * 0.8} L ${width} ${height} L 0 ${height} Z`}
              fill={m}
              opacity={0.5}
            />
          </>
        ) : null}
        {kind === "spheres" ? (
          <>
            <ellipse cx={cx + s * 0.05} cy={cy + s * 0.33} rx={s * 0.42} ry={s * 0.05} fill={l} opacity={0.25} />
            <circle cx={cx - s * 0.06} cy={cy + s * 0.02} r={s * 0.3} fill={`url(#ball-${id})`} />
            <circle cx={cx + s * 0.3} cy={cy + s * 0.2} r={s * 0.13} fill={`url(#ball-${id})`} />
          </>
        ) : null}
        {kind === "figure" ? (
          <>
            {/* A seated person behind a desk, framed the same every time: head, neck, shoulders, the desk edge in front. */}
            <rect x={cx - s * 0.035} y={cy - s * 0.06} width={s * 0.07} height={s * 0.08} fill={m} />
            <ellipse cx={cx} cy={cy - s * 0.13} rx={s * 0.075} ry={s * 0.095} fill={m} />
            <path
              d={`M ${cx - s * 0.21} ${cy + s * 0.3} L ${cx - s * 0.2} ${cy + s * 0.08} Q ${cx - s * 0.19} ${cy - s * 0.0} ${cx - s * 0.08} ${cy - s * 0.01} L ${cx + s * 0.08} ${cy - s * 0.01} Q ${cx + s * 0.19} ${cy - s * 0.0} ${cx + s * 0.2} ${cy + s * 0.08} L ${cx + s * 0.21} ${cy + s * 0.3} Z`}
              fill={l}
            />
            <rect x={0} y={cy + s * 0.28} width={width} height={height} fill={g} />
            <rect x={0} y={cy + s * 0.28} width={width} height={height} fill="#000" opacity={0.07} />
            <rect x={0} y={cy + s * 0.28} width={width} height={s * 0.006} fill="#000" opacity={0.25} />
          </>
        ) : null}
        {kind === "figure" ? null : <rect width={width} height={height} fill={`url(#vig-${id})`} />}
      </svg>
    </AbsoluteFill>
  );
};
