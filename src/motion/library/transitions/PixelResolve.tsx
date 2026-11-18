import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import React, { useId } from "react";
import { AbsoluteFill, random, useVideoConfig } from "remotion";
import { z } from "zod";
import { displayFont } from "../../../lib/fonts";
import { easeFamily } from "../../ease-family";
import { stagger, type Point2 } from "../../timing";
import { DEMO, DemoSceneA, TransitionDemo } from "./demo";

/**
 * Pixel resolve: the next scene arrives as coarse square pixels. `mosaic` (cashfree): a few overexposed frames replace the
 * old scene, then the new one resolves from coarse blocks to full detail, stepping down by halves. `ring` (gojiberry): a
 * ring of grid-snapped squares grows from a point on sine.out, the new scene showing inside it and the ring's cells
 * fading into it behind the front. Both are TransitionSeries presentations; pair with `cutTiming`.
 */

const clamp01 = (t: number) => Math.min(Math.max(t, 0), 1);

/** GSAP's power2.out (a cubic), which easeFamily does not carry. */
const power2Out = (t: number) => 1 - (1 - clamp01(t)) ** 3;

export type PixelMosaicPhases = { flashEnd: number };

/** Share of the seam taken by the overexposed frames. Pure. */
export const pixelMosaicPhases = (flashFrames: number, transitionFrames: number): PixelMosaicPhases => ({
  flashEnd: clamp01(flashFrames / Math.max(transitionFrames, 1)),
});

/**
 * Block size in pixels at resolve progress t (0..1): `from` pixels halved on each of `levels` steps reached on power2.out,
 * so the picture sharpens fast and settles, by whole pixel steps as in the reference; 1 means full detail. Pure.
 */
export const pixelBlock = (t: number, from: number, levels: number): number => {
  if (t >= 1) return 1;
  const n = Math.max(1, Math.round(levels));
  const step = Math.min(n, Math.floor(power2Out(t) * (n + 1)));
  return Math.max(1, Math.round(from / 2 ** step));
};

export type RingCell = { x: number; y: number; rank: number; gap: boolean };

/**
 * The ring mode's grid: square cells of `cell` pixels covering the frame, each with its ring rank from `stagger` kind
 * radial (cells in the same band of one cell's width from the origin share a rank) and a seeded `gap` flag for cells the
 * ring skips. Pure.
 */
export const ringCells = (
  width: number,
  height: number,
  cell: number,
  origin: Point2,
  gaps: number,
  seed: number,
): RingCell[] => {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  // Snap the origin to the middle of its cell so the rings stay grid-symmetric around it.
  const o = { x: (Math.floor(origin.x / cell) + 0.5) * cell, y: (Math.floor(origin.y / cell) + 0.5) * cell };
  const points: Point2[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) points.push({ x: (c + 0.5) * cell, y: (r + 0.5) * cell });
  const ranks = stagger(points.length, { kind: "radial", step: 1, points, origin: o, ring: cell });
  return points.map((p, i) => ({
    x: p.x - cell / 2,
    y: p.y - cell / 2,
    rank: ranks[i]!,
    gap: random(`pixel-ring-${seed}-${i}`) < gaps,
  }));
};

export type RingState = "outside" | "ring" | "fading" | "inside";

/**
 * A cell's state when the front is at rank `front`: outside (the old scene), on the ring (solid, `ringWidth` ranks deep),
 * fading (the ring colour thinning into the new scene over `fade` ranks) or inside. Returns the ring colour's opacity. Pure.
 */
export const ringCellState = (
  rank: number,
  front: number,
  ringWidth: number,
  fade: number,
): { state: RingState; cover: number } => {
  if (rank >= front) return { state: "outside", cover: 0 };
  const depth = front - rank;
  if (depth <= ringWidth) return { state: "ring", cover: 1 };
  if (depth <= ringWidth + fade) return { state: "fading", cover: 1 - (depth - ringWidth) / Math.max(fade, 1e-6) };
  return { state: "inside", cover: 0 };
};

/** The ring's front in ranks at seam progress t: sine.out from 0 past the farthest cell, so every cell is inside at t = 1. Pure. */
export const ringFront = (t: number, maxRank: number, ringWidth: number, fade: number): number =>
  easeFamily["sine.out"](clamp01(t)) * (maxRank + 1 + ringWidth + fade);

type PixelResolveOptions = {
  mode: "mosaic" | "ring";
  /** mosaic: overexposed frames before the resolve (cashfree: 3); 0 for none. */
  flashFrames: number;
  /** mosaic: the flash colour (cashfree's is mint-white). */
  flash: string;
  /** mosaic: largest block, as a share of the frame's short side. */
  fromBlock: number;
  /** mosaic: halvings from the largest block to full detail. */
  levels: number;
  /** ring: cell size as a share of the frame's short side. */
  cell: number;
  /** ring: where the ring starts, as shares of the frame. */
  originX: number;
  originY: number;
  ringColour: string;
  /** ring: depth of the solid ring and of the fade behind it, in cells. */
  ringWidth: number;
  fade: number;
  /** ring: share of ring cells left out, for a hand-made, broken ring. */
  gaps: number;
  seed: number;
};

const Pixelate: React.FC<{ block: number; children: React.ReactNode }> = ({ block, children }) => {
  const id = `px${useId().replaceAll(":", "")}`;
  const { width, height } = useVideoConfig();
  if (block <= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  // Sample one pixel in the middle of every block, then grow each sample into its block.
  return (
    <AbsoluteFill>
      <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
        <defs>
          <filter
            id={id}
            filterUnits="userSpaceOnUse"
            primitiveUnits="userSpaceOnUse"
            x={0}
            y={0}
            width={width}
            height={height}
            colorInterpolationFilters="sRGB"
          >
            <feFlood x={Math.floor(block / 2)} y={Math.floor(block / 2)} width={1} height={1} floodColor="#000" />
            <feComposite x={0} y={0} width={block} height={block} />
            <feTile result="dots" />
            <feComposite in="SourceGraphic" in2="dots" operator="in" />
            <feMorphology operator="dilate" radius={block / 2} />
          </filter>
        </defs>
      </svg>
      <AbsoluteFill style={{ filter: `url(#${id})` }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

const PixelResolvePresentation: React.FC<TransitionPresentationComponentProps<PixelResolveOptions>> = ({
  children,
  presentationProgress: p,
  presentationDirection,
  presentationDurationInFrames,
  passedProps,
}) => {
  const { width, height } = useVideoConfig();
  const o = passedProps;
  if (o.mode === "mosaic") {
    const { flashEnd } = pixelMosaicPhases(o.flashFrames, presentationDurationInFrames);
    if (presentationDirection === "exiting") return p < flashEnd ? <AbsoluteFill>{children}</AbsoluteFill> : null;
    if (p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
    if (p < flashEnd) return <AbsoluteFill style={{ backgroundColor: o.flash, opacity: 0.94 }} />;
    const t = (p - flashEnd) / Math.max(1 - flashEnd, 1e-6);
    return <Pixelate block={pixelBlock(t, o.fromBlock * Math.min(width, height), o.levels)}>{children}</Pixelate>;
  }
  if (presentationDirection === "exiting" || p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  const size = Math.max(4, Math.round(o.cell * Math.min(width, height)));
  const cells = ringCells(width, height, size, { x: o.originX * width, y: o.originY * height }, o.gaps, o.seed);
  const maxRank = Math.max(...cells.map((c) => c.rank));
  const front = ringFront(p, maxRank, o.ringWidth, o.fade);
  let clip = "";
  const overlay: React.ReactNode[] = [];
  cells.forEach((c, i) => {
    const { state, cover } = ringCellState(c.rank, front, o.ringWidth, o.fade);
    if (state === "outside") return;
    // A gap cell skips the solid ring and shows the new scene at once.
    if (state === "ring" && c.gap) {
      clip += `M${c.x} ${c.y}h${size}v${size}h${-size}Z`;
      return;
    }
    if (state !== "ring") clip += `M${c.x} ${c.y}h${size}v${size}h${-size}Z`;
    if (cover > 0)
      overlay.push(
        <rect key={i} x={c.x} y={c.y} width={size + 0.5} height={size + 0.5} fill={o.ringColour} opacity={cover} />,
      );
  });
  return (
    <AbsoluteFill>
      {clip ? <AbsoluteFill style={{ clipPath: `path("${clip}")` }}>{children}</AbsoluteFill> : null}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden>
        {overlay}
      </svg>
    </AbsoluteFill>
  );
};

/** Next scene from coarse pixels: `mosaic` with `cutTiming(10..14)` (3 flash frames, then 8-10 to resolve), `ring` with `cutTiming(18..24)`. */
export const pixelResolve = ({
  mode = "mosaic",
  flashFrames = 3,
  flash = "#EFFFF6",
  fromBlock = 0.1,
  levels = 6,
  cell = 0.05,
  originX = 0.5,
  originY = 0.5,
  ringColour = "#F2A28A",
  ringWidth = 1,
  fade = 3,
  gaps = 0.15,
  seed = 3,
}: Partial<PixelResolveOptions> = {}): TransitionPresentation<PixelResolveOptions> => ({
  component: PixelResolvePresentation,
  props: {
    mode,
    flashFrames,
    flash,
    fromBlock,
    levels,
    cell,
    originX,
    originY,
    ringColour,
    ringWidth,
    fade,
    gaps,
    seed,
  },
});

export const pixelResolveSchema = z.object({
  /** Frames from the block's start to the perceived cut, for `cues` in a film (sfx:cues places the cut there); the preview keeps its centred seam. */
  seamFrame: z.number().int().min(0).optional(),
  mode: z.enum(["mosaic", "ring"]),
  flashFrames: z.number().int().min(0).max(6),
  flash: z.string(),
  fromBlock: z.number().min(0.01).max(0.25),
  levels: z.number().int().min(1).max(8),
  cell: z.number().min(0.015).max(0.15),
  originX: z.number().min(0).max(1),
  originY: z.number().min(0).max(1),
  ringColour: z.string(),
  ringWidth: z.number().min(0.5).max(4),
  fade: z.number().min(0).max(12),
  gaps: z.number().min(0).max(0.6),
  seed: z.number().int().min(0),
  transitionFrames: z.number().int().min(6).max(40),
});

export type PixelResolveProps = z.infer<typeof pixelResolveSchema>;

export const PIXEL_RESOLVE_FRAMES = 84;

export const pixelResolveDefaults: PixelResolveProps = {
  mode: "mosaic",
  flashFrames: 3,
  flash: "#EFFFF6",
  fromBlock: 0.1,
  levels: 6,
  cell: 0.05,
  originX: 0.5,
  originY: 0.5,
  ringColour: "#F2A28A",
  ringWidth: 1,
  fade: 3,
  gaps: 0.15,
  seed: 3,
  transitionFrames: 13,
};

/** The incoming scene of the preview: a warm gradient with one mark, like gojiberry's end card. */
const WarmMark: React.FC = () => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  return (
    <AbsoluteFill
      style={{
        background: "radial-gradient(circle at 50% 50%, #FFE3D6 0%, #FBD2C2 45%, #FFF6F1 100%)",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{ fontFamily: displayFont, fontWeight: 700, fontSize: 150 * u, letterSpacing: -5 * u, color: DEMO.ink }}
      >
        Resolved.
      </div>
    </AbsoluteFill>
  );
};

/** Library preview: mosaic flashes off the product card into the warm card; ring grows from the middle of a white frame. */
export const PixelResolvePreview: React.FC<PixelResolveProps> = ({
  transitionFrames,
  seamFrame: _seam,
  ...options
}) => (
  <TransitionDemo
    presentation={pixelResolve(options)}
    transitionFrames={transitionFrames}
    totalFrames={PIXEL_RESOLVE_FRAMES}
    before={options.mode === "ring" ? <AbsoluteFill style={{ backgroundColor: "#FFFFFF" }} /> : <DemoSceneA />}
    after={<WarmMark />}
  />
);
