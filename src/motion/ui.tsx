import { Video } from "@remotion/media";
import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { progress, trackPoint, type PointKeyframe } from "./timing";

type WindowFrameProps = {
  width: number;
  height: number;
  title?: string;
  /** Title bar and hairline colours follow the material: dark interface, dark frame. */
  tone?: "dark" | "light";
  fontFamily?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
};

const TITLE_BAR = 44;

/** A window with a hairline, a real title and a soft shadow, and no toy traffic lights. `height` includes the bar. */
export const WindowFrame: React.FC<WindowFrameProps> = ({
  width,
  height,
  title,
  tone = "dark",
  fontFamily,
  children,
  style,
}) => {
  const dark = tone === "dark";
  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        borderRadius: 14,
        overflow: "hidden",
        backgroundColor: dark ? "#141414" : "#FFFFFF",
        boxShadow: `0 0 0 1px ${dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)"}, 0 40px 90px -20px rgba(0,0,0,0.5)`,
        ...style,
      }}
    >
      <div
        style={{
          height: TITLE_BAR,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily,
          fontSize: 18,
          color: dark ? "rgba(255,255,255,0.62)" : "rgba(0,0,0,0.58)",
          borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.08)"}`,
        }}
      >
        {title}
      </div>
      <div style={{ position: "absolute", top: TITLE_BAR, left: 0, right: 0, bottom: 0, overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );
};

type DeviceFrameProps = { width: number; aspect?: number; children: React.ReactNode; style?: React.CSSProperties };

/** A phone reduced to its edge: thin dark bezel and accurate corners, with the screen doing the work. */
export const DeviceFrame: React.FC<DeviceFrameProps> = ({ width, aspect = 19.5 / 9, children, style }) => {
  const bezel = Math.round(width * 0.022);
  const radius = Math.round(width * 0.14);
  return (
    <div
      style={{
        position: "relative",
        width,
        height: width * aspect,
        borderRadius: radius,
        backgroundColor: "#0B0B0C",
        padding: bezel,
        boxShadow: "0 0 0 1px rgba(255,255,255,0.16), 0 50px 110px -30px rgba(0,0,0,0.65)",
        ...style,
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          borderRadius: radius - bezel,
          overflow: "hidden",
        }}
      >
        {children}
        <div
          style={{
            position: "absolute",
            top: bezel * 1.1,
            left: "50%",
            width: width * 0.28,
            height: width * 0.075,
            marginLeft: -width * 0.14,
            borderRadius: width,
            backgroundColor: "#000",
          }}
        />
      </div>
    </div>
  );
};

type ScreenPlaybackProps =
  | { kind: "image"; src: string; fit?: "cover" | "contain"; position?: string }
  | {
      kind: "video";
      src: string;
      fit?: "cover" | "contain";
      position?: string;
      trimBefore?: number;
      playbackRate?: number;
    };

const asset = (src: string) => (/^https?:/.test(src) ? src : staticFile(src));

/** Real interface material: a screenshot or a muted screen recording, filling its parent. */
export const ScreenPlayback: React.FC<ScreenPlaybackProps> = (props) => {
  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: props.fit ?? "cover",
    objectPosition: props.position ?? "top left",
  };
  return (
    <AbsoluteFill>
      {props.kind === "image" ? (
        <Img src={asset(props.src)} style={style} />
      ) : (
        <Video
          src={asset(props.src)}
          muted
          trimBefore={props.trimBefore}
          playbackRate={props.playbackRate}
          style={style}
        />
      )}
    </AbsoluteFill>
  );
};

type CursorProps = {
  keys: readonly PointKeyframe[];
  /** Frames on which the cursor clicks. */
  clicks?: readonly number[];
  size?: number;
  pulseColor?: string;
};

/** Follows keyframes in the coordinates of its parent; put it inside `RegionCamera` so a zoom carries it along. */
export const Cursor: React.FC<CursorProps> = ({
  keys,
  clicks = [],
  size = 34,
  pulseColor = "rgba(255,255,255,0.9)",
}) => {
  const frame = useCurrentFrame();
  const { x, y } = trackPoint(frame, keys);
  const press = clicks.reduce((depth, at) => Math.max(depth, 1 - Math.min(Math.abs(frame - at) / 4, 1)), 0);
  return (
    <>
      {clicks.map((at) => {
        const p = progress(frame, at, 16, "expoOut");
        if (frame < at || p >= 1) return null;
        const clickPoint = trackPoint(at, keys);
        const diameter = size * (0.6 + p * 2.6);
        return (
          <div
            key={at}
            style={{
              position: "absolute",
              left: clickPoint.x - diameter / 2,
              top: clickPoint.y - diameter / 2,
              width: diameter,
              height: diameter,
              borderRadius: "50%",
              border: `${Math.max(size * 0.07, 1.5)}px solid ${pulseColor}`,
              opacity: 1 - p,
            }}
          />
        );
      })}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{
          position: "absolute",
          left: x,
          top: y,
          transformOrigin: "0 0",
          transform: `scale(${1 - press * 0.14})`,
          filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.45))",
        }}
      >
        <path
          d="M3 2 L3 19.2 L7.6 15 L10.5 21.8 L13.6 20.5 L10.7 13.8 L17 13.5 Z"
          fill="#FFFFFF"
          stroke="#111111"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
};
