import { getBoundingBox, scalePath, translatePath } from "@remotion/paths";
import { makeCircle, makeStar, makeTriangle } from "@remotion/shapes";
import { linearTiming } from "@remotion/transitions";
import type {
  TransitionPresentation,
  TransitionPresentationComponentProps,
  TransitionTiming,
} from "@remotion/transitions";
import React, { useId } from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { resolveCurve, type CurveRef } from "./timing";

/** Whips and wipes shape their own progress inside the presentation, so their timing must stay linear. */
export const cutTiming = (durationInFrames: number): TransitionTiming => linearTiming({ durationInFrames });

export type WhipDirection = "left" | "right" | "up" | "down";

type WhipProps = {
  direction: WhipDirection;
  curve: CurveRef;
  /** Blur sigma per pixel of per-frame travel. 0.15 is close to a 180 degree shutter. */
  shutter: number;
  maxBlur: number;
};

const WhipPresentation: React.FC<TransitionPresentationComponentProps<WhipProps>> = ({
  children,
  presentationProgress: p,
  presentationDirection,
  presentationDurationInFrames,
  passedProps,
}) => {
  const { width, height } = useVideoConfig();
  const id = useId().replaceAll(":", "");
  const { direction, curve, shutter, maxBlur } = passedProps;
  const horizontal = direction === "left" || direction === "right";
  const span = horizontal ? width : height;
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const eased = resolveCurve(curve);
  const at = (t: number) => eased(Math.min(Math.max(t, 0), 1));
  const step = 1 / Math.max(presentationDurationInFrames, 1);
  const travelled = at(p);
  const speed = Math.abs(at(p + step / 2) - at(p - step / 2)) * span;
  const sigma = Math.min(speed * shutter, maxBlur);
  const offset = (presentationDirection === "exiting" ? travelled : travelled - 1) * span * sign;
  const blurred = sigma > 0.5;
  return (
    <AbsoluteFill
      style={{
        transform: horizontal ? `translateX(${offset}px)` : `translateY(${offset}px)`,
        filter: blurred ? `url(#${id})` : undefined,
      }}
    >
      {blurred ? (
        <svg width={0} height={0} style={{ position: "absolute" }}>
          <defs>
            <filter id={id} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
              <feGaussianBlur stdDeviation={horizontal ? `${sigma} 0` : `0 ${sigma}`} />
            </filter>
          </defs>
        </svg>
      ) : null}
      {children}
    </AbsoluteFill>
  );
};

/** Both scenes travel as one strip; blur comes from the curve's speed on each frame. Pair with `cutTiming(8..10)`. */
export const whipPan = ({
  direction = "left",
  curve = "inOut",
  shutter = 0.15,
  maxBlur = 140,
}: Partial<WhipProps> = {}): TransitionPresentation<WhipProps> => ({
  component: WhipPresentation,
  props: { direction, curve, shutter, maxBlur },
});

export type WipeShape = "circle" | "play" | "star";

type WipeGeometry = { path: string; centreX: number; centreY: number; inradius: number };

const UNIT = 100;

/** The centre sits where the shape's inscribed circle does, so the shape grows out of its visual middle. */
const wipeGeometry = (shape: WipeShape): WipeGeometry => {
  if (shape === "circle")
    return { path: makeCircle({ radius: UNIT / 2 }).path, centreX: UNIT / 2, centreY: UNIT / 2, inradius: UNIT / 2 };
  if (shape === "star") {
    const { path, width, height } = makeStar({ points: 5, innerRadius: UNIT * 0.28, outerRadius: UNIT / 2 });
    return { path, centreX: width / 2, centreY: height / 2, inradius: UNIT * 0.2 };
  }
  const { path } = makeTriangle({ length: UNIT, direction: "right" });
  const box = getBoundingBox(path);
  const breadth = box.x2 - box.x1;
  return { path, centreX: box.x1 + breadth / 3, centreY: (box.y1 + box.y2) / 2, inradius: UNIT / (2 * Math.sqrt(3)) };
};

/** Scale at which the inscribed circle, centred on the origin, covers the whole frame. Exported for tests. */
export const coverScale = (originX: number, originY: number, width: number, height: number, inradius: number): number =>
  Math.hypot(Math.max(originX, width - originX), Math.max(originY, height - originY)) / inradius;

type ShapeWipeProps = {
  shape: WipeShape;
  /** Where the shape starts, in frame pixels: the place the eye already is. */
  originX: number;
  originY: number;
  /** Height of the shape on the first frame, so it can begin as a real icon or button. */
  fromSize: number;
  curve: CurveRef;
  edgeColor?: string;
  edgeWidth: number;
  /** Width of a soft edge in pixels (motionfly: about 3% of the frame width); 0 keeps the hard clip. */
  feather: number;
  /** A layer drawn above the wipe for the whole seam, such as a mark that stays put while the shape passes under it. */
  above?: React.ReactNode;
};

/**
 * End scale of a shape wipe: the inscribed circle covers the frame, plus the soft edge's width so no feathered pixel is
 * left on the last frame. Pure.
 */
export const shapeWipeEndScale = (
  originX: number,
  originY: number,
  width: number,
  height: number,
  inradius: number,
  feather: number,
): number => coverScale(originX, originY, width, height, inradius) + Math.max(feather, 0) / inradius;

const ShapeWipePresentation: React.FC<TransitionPresentationComponentProps<ShapeWipeProps>> = ({
  children,
  presentationProgress: p,
  presentationDirection,
  passedProps,
}) => {
  const { width, height } = useVideoConfig();
  const id = `sw${useId().replaceAll(":", "")}`;
  if (presentationDirection === "exiting" || p >= 1) return <AbsoluteFill>{children}</AbsoluteFill>;
  const { shape, originX, originY, fromSize, curve, edgeColor, edgeWidth, feather, above } = passedProps;
  const geometry = wipeGeometry(shape);
  const start = fromSize / UNIT;
  const end = shapeWipeEndScale(originX, originY, width, height, geometry.inradius, feather);
  // Scale is exponential in time, so the edge keeps a constant apparent speed as it grows.
  const scale = start * (end / start) ** Math.max(resolveCurve(curve)(p), 0);
  const path = translatePath(
    scalePath(geometry.path, scale, scale),
    originX - geometry.centreX * scale,
    originY - geometry.centreY * scale,
  );
  const soft = feather > 0;
  return (
    <AbsoluteFill>
      {soft ? (
        // The shape blurred by half the feather inside an inline mask: the edge is soft by about `feather` pixels.
        <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
          <defs>
            <filter id={`${id}-f`} filterUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
              <feGaussianBlur stdDeviation={feather / 2} />
            </filter>
            <mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
              <path d={path} fill="#fff" filter={`url(#${id}-f)`} />
            </mask>
          </defs>
        </svg>
      ) : null}
      <AbsoluteFill
        style={soft ? { maskImage: `url(#${id})`, WebkitMaskImage: `url(#${id})` } : { clipPath: `path("${path}")` }}
      >
        {children}
      </AbsoluteFill>
      {edgeColor ? (
        <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
          <path d={path} fill="none" stroke={edgeColor} strokeWidth={edgeWidth} />
        </svg>
      ) : null}
      {above ? <AbsoluteFill>{above}</AbsoluteFill> : null}
    </AbsoluteFill>
  );
};

/**
 * Opens the next scene through a shape that grows from `originX`, `originY`. Pair with `cutTiming(12..18)`. `feather`
 * softens the edge (motionfly's iris: a dark disc from the lower-left corner past the frame in 10 frames, sine.inOut,
 * soft by about 3% of the width); `above` keeps a layer on top of the wipe for the seam (draw the same mark in both
 * scenes at the same place, each in its own colours, so it changes colour as the shape passes and stays after the seam).
 */
export const shapeWipe = ({
  shape = "circle",
  originX,
  originY,
  fromSize = 0,
  curve = "drift",
  edgeColor,
  edgeWidth = 3,
  feather = 0,
  above,
}: Partial<ShapeWipeProps> & { originX: number; originY: number }): TransitionPresentation<ShapeWipeProps> => ({
  component: ShapeWipePresentation,
  props: {
    shape,
    originX,
    originY,
    fromSize: Math.max(fromSize, 1),
    curve,
    edgeColor,
    edgeWidth,
    feather: Math.max(feather, 0),
    above,
  },
});

type MatchCutProps = {
  /** Frame of the 0-frame cut, in this component's time. */
  cutAt: number;
  before: React.ReactNode;
  after: React.ReactNode;
  /** The persisting element, above both scenes and driven by this component's frames. */
  carry: React.ReactNode;
};

/**
 * A hard cut with an element that does not cut. Author the element's track to keep moving through `cutAt`; the two
 * scenes must agree on where it sits when they take it over. No frames are overlapped, so the timeline simply adds up.
 */
export const MatchCut: React.FC<MatchCutProps> = ({ cutAt, before, after, carry }) => (
  <AbsoluteFill>
    <Sequence durationInFrames={cutAt} layout="none" name="Before cut">
      {before}
    </Sequence>
    <Sequence from={cutAt} layout="none" name="After cut">
      {after}
    </Sequence>
    {carry}
  </AbsoluteFill>
);
