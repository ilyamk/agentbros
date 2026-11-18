import React, { createContext, useContext, useMemo } from "react";
import { AbsoluteFill } from "remotion";
import {
  DEFAULT_LENS,
  projectLayer,
  regionTransform,
  type CameraPose,
  type Lens,
  type RegionKeyframe,
} from "./camera-math";

const CameraContext = createContext<{ pose: CameraPose; lens: Lens } | null>(null);

type CameraProps = { pose: CameraPose; lens?: Partial<Lens>; children: React.ReactNode; style?: React.CSSProperties };

/** Drive `pose` from `track()`s; every `DepthLayer` inside derives its own parallax, scale and defocus from it. */
export const Camera: React.FC<CameraProps> = ({ pose, lens, children, style }) => {
  const value = useMemo(() => ({ pose, lens: { ...DEFAULT_LENS, ...lens } }), [pose, lens]);
  return (
    <AbsoluteFill style={{ overflow: "hidden", ...style }}>
      <AbsoluteFill style={{ transform: `rotate(${pose.roll}deg)` }}>
        <CameraContext.Provider value={value}>{children}</CameraContext.Provider>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

type DepthLayerProps = {
  /** World distance: 0 is the focal plane, positive is further away, negative is nearer. */
  depth: number;
  /** Extra pixels on every side, so far layers never show an edge. */
  overscan?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
};

export const DepthLayer: React.FC<DepthLayerProps> = ({ depth, overscan = 0, children, style }) => {
  const camera = useContext(CameraContext);
  if (!camera) throw new Error("DepthLayer must be inside Camera.");
  const { x, y, scale, blur } = projectLayer(camera.pose, depth, camera.lens);
  return (
    <div
      style={{
        position: "absolute",
        inset: -overscan,
        transform: `translate(${x}px, ${y}px) scale(${scale})`,
        filter: blur > 0.1 ? `blur(${blur}px)` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

type RegionCameraProps = {
  /** Size of the material being framed, in its own pixels. */
  stage: { width: number; height: number };
  /** Size of the viewport it plays in; defaults to the stage, for a zoom inside a window. */
  viewport?: { width: number; height: number };
  frame: number;
  keys: readonly RegionKeyframe[];
  children: React.ReactNode;
};

/** Camera on a flat region: an interface, a page, a chart. Children keep stage coordinates, so a cursor stays aligned. */
export const RegionCamera: React.FC<RegionCameraProps> = ({ stage, viewport = stage, frame, keys, children }) => {
  const { scale, x, y } = regionTransform(frame, keys, viewport);
  return (
    <div style={{ position: "relative", width: viewport.width, height: viewport.height, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: stage.width,
          height: stage.height,
          transformOrigin: "0 0",
          transform: `translate(${x}px, ${y}px) scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
};
