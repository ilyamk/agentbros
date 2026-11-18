import React, { useId, useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { FLAME_TILE, mazeSegments, mixHex, specularBand, tileGrow } from "./background-plan";

/**
 * A real material instead of a gradient. `brushed`: seeded anisotropic noise streaks over a grey gradient with specular
 * bands sweeping across, as brushed metal under a fixed softbox. `emboss`: a white relief, a seeded maze drawn as a light
 * stroke and a shadow stroke either side of each wall. Fills the whole ground, or a rounded tile that grows from a dot
 * (flame: 6% to 20% of the width in ~10 frames).
 */
export const materialFillSchema = z.object({
  material: z.enum(["brushed", "emboss"]),
  /** `ground` fills the frame; `tile` is a rounded square that grows at the centre over `ground`. */
  fill: z.enum(["ground", "tile"]),
  /** The material's base colour: mid grey for metal, white for the relief. */
  base: z.string(),
  /** What surrounds a tile, or "transparent". Ignored for `ground`. */
  ground: z.string(),
  seed: z.number().int().min(0),
  /** Direction of the brushing, degrees (0 = horizontal streaks). */
  angle: z.number().min(-90).max(90),
  /** Frames for one specular pass. */
  period: z.number().int().min(10).max(600),
  /** Maze cell size as a share of the frame width (emboss). */
  cell: z.number().min(0.01).max(0.2),
  /** Relief depth in pixels at 1080p (emboss). */
  depth: z.number().min(0.5).max(8),
  /** First frame: the tile starts growing, or the ground fades in over `fadeFrames`. */
  at: z.number().int().min(0),
  fadeFrames: z.number().int().min(0).max(60),
  /** Tile size: share of the frame width from `from` to `to` over `frames` (power2.out). */
  tile: z.object({
    from: z.number().min(0).max(1),
    to: z.number().min(0.01).max(1),
    frames: z.number().int().min(0),
    radius: z.number().min(0).max(0.5),
  }),
});

export type MaterialFillProps = z.infer<typeof materialFillSchema>;

const Brushed: React.FC<{
  w: number;
  h: number;
  base: string;
  seed: number;
  angle: number;
  period: number;
  frame: number;
}> = ({ w, h, base, seed, angle, period, frame }) => {
  const id = useId().replaceAll(":", "");
  const band = specularBand(frame, { period });
  const band2 = specularBand(frame, { period, offset: period * 0.42 });
  const light = mixHex(base, "#ffffff", 0.55);
  const dark = mixHex(base, "#000000", 0.55);
  const stretch = Math.hypot(w, h);
  const stripe = (pos: number, width: number, strength: number) =>
    `linear-gradient(${115 + angle}deg, transparent ${(pos - width) * 100}%, rgba(255,255,255,${strength}) ${pos * 100}%, transparent ${(pos + width) * 100}%)`;
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${160 + angle}deg, ${light} 0%, ${base} 45%, ${dark} 100%)`,
        overflow: "hidden",
      }}
    >
      <svg
        width={stretch}
        height={stretch}
        style={{
          position: "absolute",
          left: (w - stretch) / 2,
          top: (h - stretch) / 2,
          transform: `rotate(${angle}deg)`,
          mixBlendMode: "overlay",
        }}
        aria-hidden
      >
        <filter id={`brush-${id}`} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
          <feTurbulence
            type="fractalNoise"
            baseFrequency={`${(0.9 / stretch).toFixed(5)} ${(220 / stretch).toFixed(4)}`}
            numOctaves={3}
            seed={seed}
          />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="linear" slope={2.2} intercept={-0.6} />
            <feFuncG type="linear" slope={2.2} intercept={-0.6} />
            <feFuncB type="linear" slope={2.2} intercept={-0.6} />
          </feComponentTransfer>
        </filter>
        <rect width={stretch} height={stretch} filter={`url(#brush-${id})`} />
      </svg>
      <AbsoluteFill
        style={{ background: [stripe(band, 0.12, 0.55), stripe(band2, 0.06, 0.35)].join(", "), mixBlendMode: "screen" }}
      />
      <AbsoluteFill style={{ boxShadow: `inset 0 0 ${Math.min(w, h) * 0.08}px rgba(0,0,0,0.25)` }} />
    </AbsoluteFill>
  );
};

const Emboss: React.FC<{
  w: number;
  h: number;
  width: number;
  base: string;
  seed: number;
  cell: number;
  depth: number;
  frame: number;
  period: number;
}> = ({ w, h, width, base, seed, cell, depth, frame, period }) => {
  const size = Math.max(8, width * cell);
  const columns = Math.ceil(w / size) + 1;
  const rows = Math.ceil(h / size) + 1;
  const segments = useMemo(() => mazeSegments(`emboss-${seed}`, columns, rows), [seed, columns, rows]);
  const d = (depth * width) / 1920;
  const path = segments.map((s) => `M${s.x1 * size} ${s.y1 * size}L${s.x2 * size} ${s.y2 * size}`).join("");
  const lineW = Math.max(1, size * 0.16);
  const sheen = specularBand(frame, { period: period * 2 });
  return (
    <AbsoluteFill style={{ backgroundColor: base, overflow: "hidden" }}>
      <svg width={w} height={h} style={{ position: "absolute", inset: 0 }} aria-hidden>
        <g
          transform={`translate(${(w - columns * size) / 2} ${(h - rows * size) / 2})`}
          fill="none"
          strokeLinecap="round"
        >
          <path d={path} stroke="rgba(0,0,0,0.13)" strokeWidth={lineW} transform={`translate(${d} ${d})`} />
          <path d={path} stroke="#ffffff" strokeWidth={lineW} transform={`translate(${-d} ${-d})`} />
          <path d={path} stroke={base} strokeWidth={lineW} />
        </g>
      </svg>
      <AbsoluteFill
        style={{
          background: `linear-gradient(125deg, transparent ${(sheen - 0.3) * 100}%, rgba(255,255,255,0.35) ${sheen * 100}%, transparent ${(sheen + 0.3) * 100}%), radial-gradient(120% 90% at 30% 20%, transparent 40%, rgba(0,0,0,0.07) 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};

export const MaterialFill: React.FC<MaterialFillProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const isTile = p.fill === "tile";
  const side = isTile
    ? width * tileGrow(frame, { at: p.at, frames: p.tile.frames, from: p.tile.from, to: p.tile.to })
    : 0;
  const w = isTile ? side : width;
  const h = isTile ? side : height;
  const fade = isTile || p.fadeFrames === 0 ? 1 : Math.min(1, Math.max(0, (frame - p.at) / p.fadeFrames));
  const material =
    p.material === "brushed" ? (
      <Brushed w={w} h={h} base={p.base} seed={p.seed} angle={p.angle} period={p.period} frame={frame} />
    ) : (
      <Emboss
        w={w}
        h={h}
        width={width}
        base={p.base}
        seed={p.seed}
        cell={p.cell}
        depth={p.depth}
        frame={frame}
        period={p.period}
      />
    );
  if (!isTile) return <AbsoluteFill style={{ opacity: fade }}>{material}</AbsoluteFill>;
  const visible = frame >= p.at && side > 0;
  return (
    <AbsoluteFill style={{ background: p.ground === "transparent" ? undefined : p.ground }}>
      {visible ? (
        <div
          style={{
            position: "absolute",
            left: (width - side) / 2,
            top: (height - side) / 2,
            width: side,
            height: side,
            borderRadius: side * p.tile.radius,
            overflow: "hidden",
            boxShadow: `0 ${side * 0.04}px ${side * 0.12}px rgba(0,0,0,0.18)`,
          }}
        >
          {material}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

export const materialFillDefaults: MaterialFillProps = {
  material: "brushed",
  fill: "tile",
  base: "#8d9095",
  ground: "#f7f7f5",
  seed: 7,
  angle: -20,
  period: 75,
  cell: 0.045,
  depth: 2,
  at: 4,
  fadeFrames: 8,
  tile: { from: FLAME_TILE.from, to: FLAME_TILE.to, frames: FLAME_TILE.frames, radius: 0.12 },
};

/** Sound: a tile lands when it reaches size; a ground has no hit of its own. */
export const materialFillCues = (p: MaterialFillProps) =>
  p.fill === "tile"
    ? [
        {
          frame: p.at + p.tile.frames,
          kind: "land" as const,
          sfx: "glass" as const,
          weight: "support" as const,
          label: "tile at size",
        },
      ]
    : [];
