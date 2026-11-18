import React, { useId } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { FilmGrain } from "../../fx";

export const gridFloorSchema = z.object({
  sky: z.string(),
  floor: z.string(),
  line: z.string(),
  glow: z.string(),
  /** Horizon height as a share of the frame height. */
  horizon: z.number().min(0.2).max(0.8),
  /** Grid cells travelled per second towards the camera. */
  speed: z.number().min(0).max(6),
  lineOpacity: z.number().min(0).max(1),
  glowStrength: z.number().min(0).max(1.5),
  seed: z.string(),
});

export type GridFloorProps = z.infer<typeof gridFloorSchema>;

const mix = (colour: string, share: number, other: string): string =>
  `color-mix(in srgb, ${colour} ${(Math.max(0, Math.min(1, share)) * 100).toFixed(1)}%, ${other})`;

/** Cells across the bottom edge of the frame; sets the camera height. */
const CELLS_ACROSS = { wide: 11, tall: 6.5 };
const FAR = 34;

export const GridFloor: React.FC<GridFloorProps> = ({
  sky,
  floor,
  line,
  glow,
  horizon,
  speed,
  lineOpacity,
  glowStrength,
  seed,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const unit = Math.min(width, height) / 1080;
  const hy = horizon * height;
  const focal = height - hy;
  const camera = ((width > height ? CELLS_ACROSS.wide : CELLS_ACROSS.tall) * focal) / width;
  const phase = ((((frame / fps) * speed) % 1) + 1) % 1;

  const rows: { y: number; weight: number }[] = [];
  for (let k = Math.max(1, Math.floor(camera)); k <= Math.ceil(camera * FAR); k++) {
    const z = k - phase;
    if (z <= 0) continue;
    const y = hy + (focal * camera) / z;
    if (y > height + 4 * unit) continue;
    rows.push({ y, weight: Math.min(1, camera / z) });
  }

  const halfCells = Math.ceil((width / 2 / focal) * camera * 12);
  const columns = Array.from({ length: halfCells * 2 + 1 }, (_, i) => i - halfCells).map((x) => ({
    x,
    bottom: width / 2 + (focal * x) / camera,
  }));
  const depthReach = height + (height - hy);
  const toBottom = (bx: number) => width / 2 + ((bx - width / 2) * (depthReach - hy)) / (height - hy);

  const lines = (stroke: number) => (
    <>
      {columns.map((c) => (
        <line
          key={`c${c.x}`}
          x1={width / 2}
          y1={hy}
          x2={toBottom(c.bottom)}
          y2={depthReach}
          stroke={line}
          strokeWidth={stroke * 1.1 * unit}
          strokeOpacity={0.75}
        />
      ))}
      {rows.map((r) => (
        <line
          key={`r${r.y.toFixed(2)}`}
          x1={0}
          y1={r.y}
          x2={width}
          y2={r.y}
          stroke={line}
          strokeWidth={stroke * (0.6 + 1.8 * r.weight) * unit}
          strokeOpacity={0.35 + 0.65 * r.weight}
        />
      ))}
    </>
  );

  const g = glowStrength;
  return (
    <AbsoluteFill style={{ backgroundColor: floor, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: hy,
          background: `linear-gradient(180deg, ${sky} 0%, ${sky} 35%, ${mix(glow, 0.16 * Math.min(1, g), sky)} 100%)`,
        }}
      />
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden>
        <defs>
          <linearGradient id={`fade-${id}`} x1="0" y1={hy} x2="0" y2={height} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#fff" stopOpacity={0} />
            <stop offset="0.06" stopColor="#fff" stopOpacity={0.18} />
            <stop offset="0.4" stopColor="#fff" stopOpacity={1} />
            <stop offset="1" stopColor="#fff" stopOpacity={1} />
          </linearGradient>
          <mask id={`mask-${id}`} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
            <rect x={0} y={hy} width={width} height={height - hy} fill={`url(#fade-${id})`} />
          </mask>
          <filter id={`soft-${id}`} x="-5%" y="-5%" width="110%" height="110%">
            <feGaussianBlur stdDeviation={4 * unit} />
          </filter>
        </defs>
        <g mask={`url(#mask-${id})`} opacity={lineOpacity}>
          <g filter={`url(#soft-${id})`} opacity={0.7}>
            {lines(2.6)}
          </g>
          {lines(1)}
        </g>
      </svg>
      <AbsoluteFill style={{ mixBlendMode: "screen", pointerEvents: "none" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse ${(width * 0.75).toFixed(0)}px ${(height * 0.2).toFixed(0)}px at 50% ${hy}px, ${mix(glow, 0.22 * g, "transparent")} 0%, transparent 100%)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(ellipse ${(width * 0.45).toFixed(0)}px ${(28 * unit).toFixed(0)}px at 50% ${hy}px, ${mix(glow, 0.6 * g, "transparent")} 0%, transparent 100%)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: hy - unit,
            height: 2 * unit,
            background: `linear-gradient(90deg, transparent 0%, ${mix(mix(glow, 0.25, "#ffffff"), 0.95 * Math.min(1, g), "transparent")} 50%, transparent 100%)`,
          }}
        />
      </AbsoluteFill>
      <AbsoluteFill
        style={{ background: "radial-gradient(ellipse 75% 70% at 50% 50%, transparent 55%, rgba(0,0,0,0.5) 100%)" }}
      />
      <FilmGrain seed={seed} opacity={0.05} />
    </AbsoluteFill>
  );
};
