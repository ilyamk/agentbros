import type { TransitionPresentation, TransitionPresentationComponentProps } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill, Easing, useVideoConfig } from "remotion";
import { z } from "zod";
import { DEMO, DemoSceneA, DemoSceneB } from "./demo";
import { TransitionDemo } from "./demo";

const FLOOD_EASE = Easing.bezier(0.65, 0, 0.35, 1);

type ColourFloodOptions = {
  /** The accent element the colour floods out of, in frame pixels. */
  source: { x: number; y: number; width: number; height: number };
  /** Exactly the next scene's ground, so the flood becomes it. */
  colour: string;
  /** Share of the seam at which the flood is cut to the next scene, before it fills (0.5..0.95). Also `peakAt`. */
  floodShare: number;
};

/** The flood never reaches a flat frame: it is cut while this share of the frame diagonal is still uncovered. */
const UNFILLED = 0.18;

const ColourFloodPresentation: React.FC<TransitionPresentationComponentProps<ColourFloodOptions>> = ({
  children,
  presentationProgress: p,
  presentationDirection,
  passedProps,
}) => {
  const { width, height } = useVideoConfig();
  const { source, colour, floodShare } = passedProps;
  // A hard cut at `floodShare`: the outgoing scene vanishes and the incoming one is whole, on the flood's colour.
  if (presentationDirection === "exiting") return p < floodShare ? <AbsoluteFill>{children}</AbsoluteFill> : null;
  if (p >= floodShare) return <AbsoluteFill>{children}</AbsoluteFill>;
  const cx = source.x + source.width / 2;
  const cy = source.y + source.height / 2;
  const start = Math.min(source.width, source.height) / 2;
  const end = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy)) * (1 - UNFILLED);
  const flood = FLOOD_EASE(p / floodShare);
  // Radius grows exponentially, so the edge keeps an even apparent speed from a small element towards the frame.
  const radius = start * (end / start) ** flood;
  return <AbsoluteFill style={{ backgroundColor: colour, clipPath: `circle(${radius}px at ${cx}px ${cy}px)` }} />;
};

/** Share of the seam where the perceived cut sits for the default options. */
export const COLOUR_FLOOD_PEAK = 0.8;

/** The accent colour floods out of an element and is cut to the next scene (on that colour) before it fills: no flat frame. Pair with `cutTiming(14..20)`. */
export const colourFlood = ({
  source,
  colour,
  floodShare = COLOUR_FLOOD_PEAK,
}: Partial<ColourFloodOptions> &
  Pick<ColourFloodOptions, "source" | "colour">): TransitionPresentation<ColourFloodOptions> => ({
  component: ColourFloodPresentation,
  props: { source, colour, floodShare },
});

export const colourFloodSchema = z.object({
  /** Frames from the block's start to the perceived cut, for `cues` in a film (sfx:cues places the cut there); the preview keeps its centred seam. */
  seamFrame: z.number().int().min(0).optional(),
  colour: z.string(),
  floodShare: z.number().min(0.5).max(0.95),
  transitionFrames: z.number().int().min(10).max(30),
});

export type ColourFloodProps = z.infer<typeof colourFloodSchema>;

export const COLOUR_FLOOD_FRAMES = 90;

export const ColourFloodPreview: React.FC<ColourFloodProps> = ({ colour, floodShare, transitionFrames }) => {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const vertical = height > width;
  // The last chart bar of DemoSceneA: the accent the flood comes out of.
  const cardW = (vertical ? 820 : 760) * u;
  const cardH = cardW * 0.62;
  const cardLeft = vertical ? (width - cardW) / 2 : width * 0.52;
  const cardTop = vertical ? height * 0.5 : (height - cardH) / 2;
  const barW = (cardW - 88 * u - 7 * 18 * u) / 8;
  const barH = cardH * 0.58 * 0.96;
  const source = { x: cardLeft + cardW - 44 * u - barW, y: cardTop + cardH - 44 * u - barH, width: barW, height: barH };
  return (
    <TransitionDemo
      presentation={colourFlood({ source, colour, floodShare })}
      transitionFrames={transitionFrames}
      totalFrames={COLOUR_FLOOD_FRAMES}
      before={<DemoSceneA />}
      after={<DemoSceneB ground={colour} ink={DEMO.chalk} />}
    />
  );
};
