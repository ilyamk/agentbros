import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  delayRender,
  continueRender,
  cancelRender,
} from "remotion";
import { layoutTerminalLabels } from "./chart-label-layout";
import { resolveChart } from "../../lib/chart-domain";
import type { LeftPanel } from "../../types/video";
import { useEntranceStyle } from "./_entrance";
import { useCanvasMood, canvasBg, canvasFg, canvasMuted } from "./_canvas";

type Props = Extract<LeftPanel, { kind: "chart" }>;

/**
 * Editorial chart panel.
 *
 * Visual contract (FT Alphaville / Bloomberg Terminal register):
 *   1. Optional headline title above the plot.
 *   2. Y- and X-axis labels (rotated y, centred x).
 *   3. Up to N series — first/hero series rendered in `color`; rest muted.
 *   4. Animated stroke draw [12, 60] frames; per-point reveal trailing.
 *   5. Optional hero callout — big number anchored to a data point with a leader line.
 *   6. Optional annotations — short labels on specific points with thin leader lines.
 *
 * Use the multi-series form for comparisons; single-series `data` is accepted
 * for backwards compat with old storyboards.
 */

const VIEWBOX_W = 1200;
const VIEWBOX_H = 800;
const MARGIN = { left: 100, right: 80, top: 100, bottom: 110 };

const PLOT_W = VIEWBOX_W - MARGIN.left - MARGIN.right;
const PLOT_H = VIEWBOX_H - MARGIN.top - MARGIN.bottom;

const TICK_COUNT = 5;
const MUTED_SERIES_COLOR_LIGHT = "#B5B5B5";
const MUTED_SERIES_COLOR_DARK = "#5A5A60";
const TITLE_FONT = "700 28px 'Inter', system-ui, sans-serif";
const LABEL_FONT = "500 18px 'Inter', system-ui, sans-serif";
const SMALL_FONT = "500 14px 'Inter', system-ui, sans-serif";

function toPlotX(index: number, total: number): number {
  if (total <= 1) return MARGIN.left;
  return MARGIN.left + (index / (total - 1)) * PLOT_W;
}
function toPlotY(value: number, min: number, max: number): number {
  if (max === min) return MARGIN.top + PLOT_H / 2;
  const normalised = (value - min) / (max - min);
  return MARGIN.top + PLOT_H - normalised * PLOT_H;
}

function buildLinePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}
function buildAreaPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  const line = buildLinePath(points);
  const baseline = MARGIN.top + PLOT_H;
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L ${last.x.toFixed(2)} ${baseline} L ${first.x.toFixed(2)} ${baseline} Z`;
}
function totalPathLength(points: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

export const AnimatedLineChart: React.FC<Props> = (props) => {
  const [fontHandle] = useState(() => delayRender("Chart terminal label font measurement"));
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let disposed = false;
    document.fonts.ready
      .then(() => {
        if (!disposed) {
          setFontsReady(true);
          continueRender(fontHandle);
        }
      })
      .catch(cancelRender);
    return () => {
      disposed = true;
      continueRender(fontHandle);
    };
  }, [fontHandle]);
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const entranceStyle = useEntranceStyle(frame, fps, props.entrance ?? "fade");

  const mood = useCanvasMood();
  const BG = canvasBg(mood);
  const AXIS_COLOR = canvasFg(mood);
  const TICK_COLOR = canvasMuted(mood);
  const mutedSeriesColor = mood === "dark" ? MUTED_SERIES_COLOR_DARK : MUTED_SERIES_COLOR_LIGHT;

  const resolved = resolveChart(props, mutedSeriesColor);
  const seriesList = resolved.series;
  if (seriesList.length === 0) {
    return <AbsoluteFill style={{ background: BG, ...entranceStyle }} />;
  }

  const allValues = seriesList.flatMap((s) => s.data.map((d) => d.value));
  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);

  const labelCanvas = fontsReady ? document.createElement("canvas").getContext("2d") : null;
  if (labelCanvas) labelCanvas.font = SMALL_FONT;
  const terminalLabels = labelCanvas
    ? layoutTerminalLabels(
        seriesList.flatMap((series, seriesIndex) => {
          const last = series.data.at(-1);
          return !series.isHero && last
            ? [
                {
                  seriesIndex,
                  text: series.label,
                  x: toPlotX(series.data.length - 1, series.data.length),
                  y: toPlotY(last.value, minValue, maxValue),
                },
              ]
            : [];
        }),
        (text) => labelCanvas.measureText(text).width,
        { left: MARGIN.left + 8, right: VIEWBOX_W - 16, top: MARGIN.top + 8, bottom: MARGIN.top + PLOT_H - 8 },
      )
    : [];

  const heroSeries = resolved.heroSeries!;
  const xAxisCount = resolved.xAxisCount;
  const xLabelFor = (index: number): string => resolved.axisLabels[index];

  const yTicks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => {
    const frac = i / TICK_COUNT;
    return {
      y: MARGIN.top + PLOT_H - frac * PLOT_H,
      value: minValue + frac * (maxValue - minValue),
    };
  });

  // Title fade-in [0–18]
  const titleOpacity = interpolate(frame, [0, 18], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Axes draw-in [6–24]
  const axisOpacity = interpolate(frame, [6, 24], [0, 1], {
    extrapolateRight: "clamp",
  });

  // Per-series reveal range — stagger across series
  const seriesReveal = (index: number): { start: number; end: number } => ({
    start: 18 + index * 8,
    end: Math.min(durationInFrames - 18, 60 + index * 8),
  });

  // Callout reveal — late, after the hero stroke completes
  const calloutFrame = Math.min(durationInFrames - 9, 72);
  const calloutScale = spring({
    frame: frame - calloutFrame,
    fps,
    config: { damping: 12, stiffness: 80 },
  });
  const calloutAnchorIndex = props.callout?.anchorIndex ?? heroSeries.data.length - 1;
  const calloutAnchor = {
    x: toPlotX(calloutAnchorIndex, heroSeries.data.length),
    y: toPlotY(heroSeries.data[calloutAnchorIndex]?.value ?? 0, minValue, maxValue),
  };

  return (
    <AbsoluteFill
      style={{
        background: BG,
        ...entranceStyle,
      }}
    >
      <svg
        viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
        style={{ width: "100%", height: "100%" }}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Title */}
        {props.title ? (
          <text
            x={MARGIN.left}
            y={MARGIN.top - 40}
            textAnchor="start"
            fill={AXIS_COLOR}
            opacity={titleOpacity}
            style={{ font: TITLE_FONT }}
          >
            {props.title}
          </text>
        ) : null}

        {/* Y-axis title (rotated) */}
        {props.yAxisLabel ? (
          <text
            transform={`translate(${MARGIN.left - 70}, ${MARGIN.top + PLOT_H / 2}) rotate(-90)`}
            textAnchor="middle"
            fill={TICK_COLOR}
            opacity={axisOpacity}
            style={{ font: SMALL_FONT, letterSpacing: "0.05em", textTransform: "uppercase" as const }}
          >
            {props.yAxisLabel}
          </text>
        ) : null}

        {/* X-axis title */}
        {props.xAxisLabel ? (
          <text
            x={MARGIN.left + PLOT_W / 2}
            y={VIEWBOX_H - 24}
            textAnchor="middle"
            fill={TICK_COLOR}
            opacity={axisOpacity}
            style={{ font: SMALL_FONT, letterSpacing: "0.05em", textTransform: "uppercase" as const }}
          >
            {props.xAxisLabel}
          </text>
        ) : null}

        {/* Axes */}
        <g opacity={axisOpacity}>
          <line
            x1={MARGIN.left}
            y1={MARGIN.top}
            x2={MARGIN.left}
            y2={MARGIN.top + PLOT_H}
            stroke={AXIS_COLOR}
            strokeWidth={1.5}
          />
          <line
            x1={MARGIN.left}
            y1={MARGIN.top + PLOT_H}
            x2={MARGIN.left + PLOT_W}
            y2={MARGIN.top + PLOT_H}
            stroke={AXIS_COLOR}
            strokeWidth={1.5}
          />

          {yTicks.map((t, i) => (
            <g key={`y${i}`}>
              {i > 0 ? (
                <line
                  x1={MARGIN.left}
                  y1={t.y}
                  x2={MARGIN.left + PLOT_W}
                  y2={t.y}
                  stroke={TICK_COLOR}
                  strokeWidth={1}
                  strokeDasharray="2 6"
                  opacity={0.25}
                />
              ) : null}
              <text x={MARGIN.left - 18} y={t.y + 6} textAnchor="end" fill={AXIS_COLOR} style={{ font: LABEL_FONT }}>
                {Math.round(t.value)}
                {props.yUnit ?? ""}
              </text>
            </g>
          ))}

          {Array.from({ length: xAxisCount }, (_, i) => {
            const x = toPlotX(i, xAxisCount);
            return (
              <text
                key={`x${i}`}
                x={x}
                y={MARGIN.top + PLOT_H + 36}
                textAnchor="middle"
                fill={AXIS_COLOR}
                style={{ font: LABEL_FONT }}
              >
                {xLabelFor(i)}
              </text>
            );
          })}
        </g>

        {/* Series — non-hero first so hero draws on top */}
        {[
          ...seriesList.map((s, i) => ({ s, i })).filter((x) => !x.s.isHero),
          ...seriesList.map((s, i) => ({ s, i })).filter((x) => x.s.isHero),
        ].map(({ s, i }) => {
          const points = s.data.map((d, j) => ({
            x: toPlotX(j, s.data.length),
            y: toPlotY(d.value, minValue, maxValue),
          }));
          const pathLen = totalPathLength(points);
          const linePath = buildLinePath(points);
          const areaPath = buildAreaPath(points);
          const { start, end } = seriesReveal(i);
          const drawn = interpolate(frame, [start, end], [0, pathLen], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const isBar = props.chartType === "bar";

          return (
            <g key={`s${i}`} data-chart-series={i} opacity={s.isHero ? 1 : 0.5}>
              {props.chartType === "area" && pathLen > 0 ? (
                <path d={areaPath} fill={s.color} fillOpacity={s.isHero ? 0.18 : 0.08} />
              ) : null}

              {!isBar && pathLen > 0 ? (
                <path
                  d={linePath}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.isHero ? 6 : 3.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={pathLen}
                  strokeDashoffset={pathLen - drawn}
                />
              ) : null}

              {isBar &&
                points.map((p, j) => {
                  const barW = Math.min(PLOT_W / s.data.length - 16, 56);
                  const barProgress = interpolate(frame, [start + j * 3, start + j * 3 + 24], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  });
                  const fullH = MARGIN.top + PLOT_H - p.y;
                  const animH = fullH * barProgress;
                  return (
                    <rect
                      key={`bar${i}_${j}`}
                      x={p.x - barW / 2}
                      y={MARGIN.top + PLOT_H - animH}
                      width={barW}
                      height={animH}
                      fill={s.color}
                      rx={4}
                    />
                  );
                })}

              {!isBar &&
                points.map((p, j) => {
                  const ptStart = start + 12 + j * 3;
                  const ptProgress = interpolate(frame, [ptStart, ptStart + 12], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  });
                  return (
                    <circle
                      key={`pt${i}_${j}`}
                      cx={p.x}
                      cy={p.y}
                      r={(s.isHero ? 9 : 5) * ptProgress}
                      fill="#FFFFFF"
                      stroke={s.color}
                      strokeWidth={s.isHero ? 3 : 2}
                    />
                  );
                })}
            </g>
          );
        })}

        {/* Terminal labels paint after every path/point; opaque canvas backing protects glyphs. */}
        <g data-terminal-label-layer="true">
          {terminalLabels.map((label) => {
            const series = seriesList[label.seriesIndex];
            const points = series.data.map((point, index) => ({
              x: toPlotX(index, series.data.length),
              y: toPlotY(point.value, minValue, maxValue),
            }));
            const pathLen = totalPathLength(points);
            const { start, end } = seriesReveal(label.seriesIndex);
            const drawn = interpolate(frame, [start, end], [0, pathLen], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            return (
              <g
                key={`label${label.seriesIndex}`}
                data-terminal-series={label.seriesIndex}
                opacity={drawn === pathLen ? 1 : 0}
              >
                <line
                  x1={label.x}
                  y1={label.y}
                  x2={label.left + label.width}
                  y2={label.top + label.height / 2}
                  stroke={series.color}
                  strokeWidth={1}
                  opacity={0.5}
                />
                <rect x={label.left} y={label.top} width={label.width} height={label.height} rx={3} fill={BG} />
                <text
                  x={label.left + 6}
                  y={label.top + 20}
                  textAnchor="start"
                  fill={series.color}
                  opacity={0.5}
                  style={{ font: SMALL_FONT, whiteSpace: "pre" }}
                >
                  {label.lines.map((line, row) => (
                    <tspan key={row} x={label.left + 6} dy={row === 0 ? 0 : 18}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            );
          })}
        </g>

        {/* Annotations */}
        {resolved.annotations.map(({ annotation: a, index: k, targetSeries, targetPoint }) => {
          if (!targetSeries || !targetPoint) return null;
          const x = toPlotX(a.dataIndex, targetSeries.data.length);
          const y = toPlotY(targetPoint.value, minValue, maxValue);
          const op = interpolate(frame, [42 + k * 6, 60 + k * 6], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <g key={`ann${k}`} opacity={op}>
              <line x1={x} y1={y - 14} x2={x} y2={y - 56} stroke={AXIS_COLOR} strokeWidth={1} strokeDasharray="3 3" />
              <text
                x={x}
                y={y - 64}
                textAnchor="middle"
                fill={AXIS_COLOR}
                style={{ font: SMALL_FONT, fontWeight: 600 }}
              >
                {a.text}
              </text>
            </g>
          );
        })}

        {/* Callout — big number near hero anchor */}
        {props.callout ? (
          <g
            opacity={calloutScale > 0.05 ? 1 : 0}
            transform={`translate(${calloutAnchor.x}, ${calloutAnchor.y - 72}) scale(${calloutScale.toFixed(3)})`}
            style={{ transformOrigin: "center" }}
          >
            <line x1={0} y1={50} x2={0} y2={70} stroke={heroSeries.color} strokeWidth={3} />
            <circle cx={0} cy={72} r={6} fill={heroSeries.color} />
            <text
              x={0}
              y={20}
              textAnchor="middle"
              fill={heroSeries.color}
              style={{
                font: "800 64px 'Inter', system-ui, sans-serif",
                letterSpacing: "-0.02em",
              }}
            >
              {props.callout.value}
            </text>
            {props.callout.label ? (
              <text
                x={0}
                y={44}
                textAnchor="middle"
                fill={AXIS_COLOR}
                style={{ font: SMALL_FONT, letterSpacing: "0.05em", textTransform: "uppercase" as const }}
              >
                {props.callout.label}
              </text>
            ) : null}
          </g>
        ) : null}
      </svg>
    </AbsoluteFill>
  );
};
