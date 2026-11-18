import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import type { LeftPanel } from "../../types/video";
import { useEntranceStyle } from "./_entrance";
import { useCanvasMood, canvasBg, canvasFg } from "./_canvas";

type Props = Extract<LeftPanel, { kind: "sketch" }>;

const VIEWBOX_W = 1200;
const VIEWBOX_H = 800;
// Margins: L 80, R 60, T 60, B 100
const ML = 80;
const MR = 60;
const MT = 60;
const MB = 100;
const PLOT_W = VIEWBOX_W - ML - MR;
const PLOT_H = VIEWBOX_H - MT - MB;

const TICK_H = 8;

function jitterX(i: number, nx: number, jitter: number): number {
  return Math.sin(i * 1.3 + nx * 7) * jitter;
}

function jitterY(i: number, ny: number, jitter: number): number {
  return Math.cos(i * 2.1 + ny * 5) * jitter;
}

function toSvgX(nx: number): number {
  return ML + nx * PLOT_W;
}

function toSvgY(ny: number): number {
  // ny=0 → bottom (PLOT_H), ny=1 → top (0)
  return MT + PLOT_H - ny * PLOT_H;
}

function segLen(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2);
}

export const HandDrawnSketch: React.FC<Props> = ({
  points,
  color,
  jitter,
  entrance = "fade",
  kind: _kind,
  caption: _caption,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entranceStyle = useEntranceStyle(frame, fps, entrance);
  const mood = useCanvasMood();
  const BG = canvasBg(mood);
  const AXIS_COLOR = canvasFg(mood);

  // Build jittered SVG coordinates
  const svgPts = points.map(([nx, ny], i) => ({
    x: toSvgX(nx) + jitterX(i, nx, jitter),
    y: toSvgY(ny) + jitterY(i, ny, jitter),
  }));

  // Build path string
  const pathD = svgPts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");

  // Compute total path length analytically
  let totalLen = 0;
  for (let i = 1; i < svgPts.length; i++) {
    totalLen += segLen(svgPts[i - 1].x, svgPts[i - 1].y, svgPts[i].x, svgPts[i].y);
  }

  // Animate stroke draw: frames [12, 75]
  const dashOffset = interpolate(frame, [12, 75], [totalLen, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // X-axis tick positions: every 100px from x=80 to x=1140
  const xTicks: number[] = [];
  for (let x = ML; x <= ML + PLOT_W; x += 100) {
    xTicks.push(x);
  }

  const axisY = MT + PLOT_H;

  return (
    <AbsoluteFill style={{ background: BG, ...entranceStyle }}>
      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        style={{ width: "100%", height: "100%" }}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Y-axis */}
        <line x1={ML} y1={MT} x2={ML} y2={axisY} stroke={AXIS_COLOR} strokeWidth={2} />
        {/* X-axis */}
        <line x1={ML} y1={axisY} x2={ML + PLOT_W} y2={axisY} stroke={AXIS_COLOR} strokeWidth={2} />

        {/* X-axis ticks */}
        {xTicks.map((x) => (
          <line key={x} x1={x} y1={axisY} x2={x} y2={axisY + TICK_H} stroke={AXIS_COLOR} strokeWidth={1.5} />
        ))}

        {/* Y-axis ticks (5 evenly spaced) */}
        {Array.from({ length: 6 }, (_, i) => {
          const y = MT + (i / 5) * PLOT_H;
          return <line key={i} x1={ML - TICK_H} y1={y} x2={ML} y2={y} stroke={AXIS_COLOR} strokeWidth={1.5} />;
        })}

        {/* Sketch path */}
        {totalLen > 0 && (
          <path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={totalLen}
            strokeDashoffset={dashOffset}
          />
        )}
      </svg>
    </AbsoluteFill>
  );
};
