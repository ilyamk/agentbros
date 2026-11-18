import React from "react";
import { useCurrentFrame } from "remotion";
import {
  collageCells,
  growRect,
  morphRect,
  type GridCell,
  type GridStep,
  type GrowOptions,
  type LayoutKeyframe,
  type LayoutRect,
} from "./kinetic-math";
import type { CurveRef } from "./timing";

type LayoutMorphProps = {
  keys: readonly LayoutKeyframe[];
  curve?: CurveRef;
  fill?: string;
  /** Hairline instead of a fill. */
  stroke?: string;
  strokeWidth?: number;
  children?: (rect: Required<LayoutRect>) => React.ReactNode;
  style?: React.CSSProperties;
};

/**
 * One container that carries through layouts: a line becomes a panel, a panel a column. What is inside can change; the
 * box never cuts. Rectangles sit in the parent's coordinates, and a child function reads the current one.
 */
export const LayoutMorph: React.FC<LayoutMorphProps> = ({
  keys,
  curve,
  fill,
  stroke,
  strokeWidth = 2,
  children,
  style,
}) => {
  const frame = useCurrentFrame();
  const rect = morphRect(frame, keys, curve);
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        borderRadius: rect.radius,
        backgroundColor: fill,
        border: stroke ? `${strokeWidth}px solid ${stroke}` : undefined,
        overflow: "hidden",
        ...style,
      }}
    >
      {children?.(rect)}
    </div>
  );
};

type GrowToSceneProps = GrowOptions & {
  from: Required<LayoutRect>;
  stage: { width: number; height: number };
  /** The element's own surface before it flattens, usually a gradient. */
  surface: string;
  /** Exactly the next scene's ground, so nothing has to cut. */
  ground: string;
  /** The label, which shrinks and leaves before the surge. */
  children?: React.ReactNode;
  /** The interface the element is leaving behind: pushed towards the camera with it. */
  behind?: React.ReactNode;
};

/** A button eats the interface and becomes the next ground. Mount the next scene from the frame after `at + frames`. */
export const GrowToScene: React.FC<GrowToSceneProps> = ({
  from,
  stage,
  surface,
  ground,
  at,
  frames,
  anticipation,
  swell,
  children,
  behind,
}) => {
  const frame = useCurrentFrame();
  const state = growRect(frame, from, stage, { at, frames, anticipation, swell });
  // The camera goes in with the element, as if pushed by it.
  const push = 1 + state.progress ** 2 * 0.35;
  return (
    <>
      {behind ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: `scale(${push})`,
            transformOrigin: `${from.x + from.width / 2}px ${from.y + from.height / 2}px`,
            opacity: 1 - state.progress * 0.3,
          }}
        >
          {behind}
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: state.x,
          top: state.y,
          width: state.width,
          height: state.height,
          borderRadius: state.radius,
          backgroundColor: ground,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ position: "absolute", inset: 0, background: surface, opacity: 1 - state.flat }} />
        {state.label > 0 ? (
          <div
            style={{
              position: "relative",
              whiteSpace: "pre",
              opacity: Math.min(state.label * 1.6, 1),
              transform: `scale(${0.25 + state.label * 0.75})`,
            }}
          >
            {children}
          </div>
        ) : null}
      </div>
    </>
  );
};

type CollageGridProps = {
  steps: readonly GridStep[];
  stage: { width: number; height: number };
  root?: string;
  frames?: number;
  gutter?: number;
  /** Corner radius of each cell. */
  radius?: number;
  /** Ground showing in the gutters. */
  ground?: string;
  /** Slow push on the whole grid, in scale per second at 30 fps. */
  creep?: number;
  /** Below this width or height a cell is not drawn. */
  minSize?: number;
  cell: (cell: GridCell, frame: number) => React.ReactNode;
};

/** A grid that divides on cues, gutters sliding as one cell takes from its neighbours. Cell contents keep their own motion. */
export const CollageGrid: React.FC<CollageGridProps> = ({
  steps,
  stage,
  root,
  frames,
  gutter = 10,
  radius = 14,
  ground,
  creep = 0.025,
  minSize = 3,
  cell,
}) => {
  const frame = useCurrentFrame();
  const scale = 1 + (creep * frame) / 30;
  return (
    <div
      style={{
        position: "relative",
        width: stage.width,
        height: stage.height,
        backgroundColor: ground,
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", inset: 0, transform: `scale(${scale})` }}>
        {collageCells(frame, steps, stage, { root, frames }).map((item) => {
          const width = item.width - gutter;
          const height = item.height - gutter;
          if (width < minSize || height < minSize) return null;
          return (
            <div
              key={item.id}
              style={{
                position: "absolute",
                left: item.x + gutter / 2,
                top: item.y + gutter / 2,
                width,
                height,
                borderRadius: radius,
                overflow: "hidden",
              }}
            >
              {cell({ ...item, width, height }, frame)}
            </div>
          );
        })}
      </div>
    </div>
  );
};
