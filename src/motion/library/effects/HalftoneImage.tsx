import React, { useId } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { curves } from "../../timing";
import type { Cue } from "../types";
import { ABDULAH_INKS, MIN_INK_HOLD, halftoneInkAt, halftoneScreen } from "./flash-plan";
import { PLATE_KINDS, PlateSource, hexRgb, type PlateKind } from "./plates";

/** SVG filter that maps luminance to two colours: black to `dark`, white to `light`. Use as `filter: url(#id)`. */
export const DuotoneFilter: React.FC<{ id: string; dark: string; light: string }> = ({ id, dark, light }) => {
  const d = hexRgb(dark).map((v) => v / 255);
  const l = hexRgb(light).map((v) => v / 255);
  return (
    <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
      <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feColorMatrix
          type="matrix"
          values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0"
        />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={`${d[0]} ${l[0]}`} />
          <feFuncG type="table" tableValues={`${d[1]} ${l[1]}`} />
          <feFuncB type="table" tableValues={`${d[2]} ${l[2]}`} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
};

export type HalftoneSettings = {
  /** Cell of the dot screen in px at a 1080-px frame. */
  dotSize: number;
  /** Screen angle in degrees (45 classic, 15 for a second ink). */
  angle: number;
  /** Pixels a frame the screen crawls along its angle; 0 holds it. */
  push: number;
  /** Dot colour and paper colour. */
  ink: string;
  ground: string;
  /** "dark": dots where the picture is dark (print). "light": dots where it is bright (a lit subject on a dark ground). */
  dotsOn: "dark" | "light";
  /** Tone contrast of the picture before screening; above 1 opens the range. */
  gain: number;
  /** Frame the halftone starts dissolving into the original picture (-1 never) and the dissolve's length. */
  resolveAt: number;
  resolveFrames: number;
};

/**
 * Re-renders any picture (an image or clip from public/, or children) as a halftone dot screen in two colours, drawn
 * per frame with CSS: the picture, blurred to the cell, is added to a radial ramp per cell and thresholded, so each
 * dot's area follows the picture's darkness. No canvas or pixel reads; deterministic. Renders the source twice while
 * it resolves: keep `<Audio>` outside.
 */
export const Halftone: React.FC<HalftoneSettings & { children: React.ReactNode }> = ({
  children,
  dotSize,
  angle,
  push,
  ink,
  ground,
  dotsOn,
  gain,
  resolveAt,
  resolveFrames,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const id = `halftone-${useId().replaceAll(":", "")}`;
  const unit = Math.min(width, height) / 1080;
  const screen = halftoneScreen(frame, { dotSize, angle, push, unit });
  const reveal =
    resolveAt < 0 ? 0 : curves.drift(Math.max(0, Math.min(1, (frame - resolveAt) / Math.max(1, resolveFrames))));
  const side = Math.hypot(width, height) + screen.cell * 4;
  return (
    <AbsoluteFill>
      <DuotoneFilter id={id} dark={ink} light={ground} />
      {reveal < 1 ? (
        <AbsoluteFill style={{ filter: `url(#${id})` }}>
          <AbsoluteFill style={{ backgroundColor: "#fff", filter: "contrast(24)", overflow: "hidden" }}>
            <AbsoluteFill
              style={{
                filter: `grayscale(1) ${dotsOn === "light" ? "invert(1) " : ""}contrast(${gain}) brightness(0.5) blur(${screen.cell * 0.22}px)`,
              }}
            >
              {children}
            </AbsoluteFill>
            <div
              style={{
                position: "absolute",
                left: (width - side) / 2,
                top: (height - side) / 2,
                width: side,
                height: side,
                backgroundImage: "radial-gradient(circle farthest-corner at center, #000 0%, #808080 100%)",
                backgroundSize: `${screen.cell}px ${screen.cell}px`,
                backgroundPosition: `${screen.x}px ${screen.y}px`,
                transform: `rotate(${screen.angle}deg)`,
                mixBlendMode: "plus-lighter",
              }}
            />
          </AbsoluteFill>
        </AbsoluteFill>
      ) : null}
      {reveal > 0 ? <AbsoluteFill style={{ opacity: reveal }}>{children}</AbsoluteFill> : null}
    </AbsoluteFill>
  );
};

export const halftoneImageSchema = z.object({
  /** Image or clip inside public/; empty draws the procedural `plate`. */
  src: z.string(),
  plate: z.enum(PLATE_KINDS),
  dotSize: z.number().min(3).max(80),
  /** Optional dot-size change over the block: the screen coarsens or refines (equal to dotSize for none). */
  dotSizeTo: z.number().min(3).max(80),
  dotFrames: z.number().int().min(1).max(300),
  angle: z.number().min(-90).max(90),
  push: z.number().min(-8).max(8),
  ink: z.string(),
  ground: z.string(),
  dotsOn: z.enum(["dark", "light"]),
  gain: z.number().min(0.5).max(3),
  resolveAt: z.number().int().min(-1),
  resolveFrames: z.number().int().min(1).max(60),
  /** A slow push-in on the picture under the screen (scale gained over the block), as in a stepped crowd push; 0 none. */
  zoom: z.number().min(0).max(1),
  /** Colour cycle: dot and ground pairs that replace `ink`/`ground`, swapping on a frame (steps(1)); empty for none. */
  inks: z.array(z.object({ ink: z.string(), ground: z.string() })).max(8),
  /** Frames each pair holds; 5 at least, so the cycle stays within six changes a second (abdulah: 10). */
  inkEvery: z.number().int().min(MIN_INK_HOLD).max(120),
});

export type HalftoneImageProps = z.infer<typeof halftoneImageSchema>;

export const HALFTONE_IMAGE_FRAMES = 120;

export const halftoneImageDefaults: HalftoneImageProps = {
  src: "",
  plate: "spheres",
  dotSize: 16,
  dotSizeTo: 11,
  dotFrames: 70,
  angle: 45,
  push: 0.35,
  ink: "#1F3BD6",
  ground: "#F2F0EA",
  dotsOn: "dark",
  gain: 1.15,
  resolveAt: 108,
  resolveFrames: 6,
  zoom: 0.06,
  inks: [],
  inkEvery: 10,
};

/** abdulah t13: the plate as a coarse dot screen on black, the dot colour cycling yellow, magenta, grey every 10 frames. */
export const halftoneInkCyclePreset: Partial<HalftoneImageProps> = {
  inks: ABDULAH_INKS,
  inkEvery: 10,
  dotsOn: "light",
  dotSize: 18,
  dotSizeTo: 18,
  push: 0,
  resolveAt: -1,
  zoom: 0.03,
};

export const halftoneImageCues = ({
  resolveAt,
  resolveFrames,
}: Pick<HalftoneImageProps, "resolveAt" | "resolveFrames">): Cue[] =>
  resolveAt >= 0
    ? [
        {
          frame: resolveAt + resolveFrames,
          kind: "reveal",
          sfx: "glass",
          weight: "support",
          label: "dots resolve to the photo",
        },
      ]
    : [];

/** Dot size on `frame`: dotSize easing to dotSizeTo over dotFrames (expo out), so the screen settles. */
export const halftoneDotSizeAt = (
  frame: number,
  { dotSize, dotSizeTo, dotFrames }: Pick<HalftoneImageProps, "dotSize" | "dotSizeTo" | "dotFrames">,
): number => dotSize + (dotSizeTo - dotSize) * curves.expoOut(Math.max(0, Math.min(1, frame / dotFrames)));

/**
 * The block: a picture (src, or the neutral procedural plate) as a two-colour dot screen, optionally resolving to the
 * photo; with `inks` the dot and ground colours cycle on a frame cadence.
 */
export const HalftoneImage: React.FC<
  Omit<HalftoneImageProps, "inks" | "inkEvery"> &
    Partial<Pick<HalftoneImageProps, "inks" | "inkEvery">> & { children?: React.ReactNode }
> = ({ src, plate, dotSize, dotSizeTo, dotFrames, zoom, inks = [], inkEvery = 10, children, ...settings }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const scale = 1 + zoom * curves.expoOut(Math.min(1, frame / Math.max(1, durationInFrames)));
  const cycle = halftoneInkAt(frame, inks, inkEvery);
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Halftone
        {...settings}
        ink={cycle?.ink ?? settings.ink}
        ground={cycle?.ground ?? settings.ground}
        dotSize={halftoneDotSizeAt(frame, { dotSize, dotSizeTo, dotFrames })}
      >
        <AbsoluteFill style={{ transform: `scale(${scale})` }}>
          <PlateSource src={src} kind={plate as PlateKind} seed="halftone">
            {children}
          </PlateSource>
        </AbsoluteFill>
      </Halftone>
    </AbsoluteFill>
  );
};
