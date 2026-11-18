import { getLength, getPointAtLength } from "@remotion/paths";
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import {
  DataStage,
  clamp01,
  ink,
  compact,
  datumSchema,
  formatSchema,
  formatValue,
  keynoteTheme,
  labelFont,
  niceScale,
  numberFont,
  smoothPath,
  themeSchema,
  useStage,
} from "./kit";

export const lineChartRevealSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  data: z.array(datumSchema).min(2),
  format: formatSchema,
  /** Index of the point the callout marks; -1 picks the maximum. */
  highlight: z.number().int(),
  note: z.string(),
  at: z.number(),
  drawFrames: z.number().int().min(10),
  theme: themeSchema,
});
export type LineChartRevealProps = z.infer<typeof lineChartRevealSchema>;

/** An area chart draws on behind a travelling head that carries its live value, then a callout pops on the key point. */
export const LineChartReveal: React.FC<LineChartRevealProps> = ({
  title,
  subtitle,
  data,
  format,
  highlight,
  note,
  at,
  drawFrames,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { width, height, u, vertical } = useStage();
  const id = React.useId().replaceAll(":", "");

  const pad = vertical
    ? { left: 80 * u, right: 90 * u, top: 520 * u, bottom: 420 * u }
    : { left: 200 * u, right: 200 * u, top: 300 * u, bottom: 170 * u };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const values = data.map((d) => d.value);
  const scale = niceScale(Math.min(0, ...values), Math.max(...values), vertical ? 4 : 5);
  const yOf = (v: number): number => plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;
  const points = data.map((d, i) => ({ x: (i / (data.length - 1)) * plotW, y: yOf(d.value) }));
  const d = smoothPath(points);
  const length = getLength(d);

  const enter = progress(frame, at - 10, 20);
  const draw = progress(frame, at, drawFrames, "drift");
  const drawn = Math.max(draw * length, 0.01);
  const head = getPointAtLength(d, Math.min(drawn, length)) ?? points[0]!;
  const headValue = scale.min + ((plotH - head.y) / plotH) * (scale.max - scale.min);
  const done = at + drawFrames;
  const headFade = 1 - progress(frame, done, 10, "linear");

  const hi = highlight >= 0 && highlight < data.length ? highlight : values.indexOf(Math.max(...values));
  const hp = points[hi]!;
  const pop = progress(frame, done + 2, 18, "expoOut");
  const card = progress(frame, done + 8, 18, "expoOut");
  const cardLeft = hp.x > plotW * 0.6;
  const titleBottom = ((vertical ? 260 : 110) + 130) * u;
  const cardEdge = pad.left + hp.x + (cardLeft ? -520 : 70) * u;
  const cardBelow = pad.top + hp.y - 220 * u < titleBottom && cardEdge < pad.left + 820 * u;
  const lead = cardBelow ? -1 : 1;
  const labelStep = Math.ceil(data.length / (vertical ? 5 : 8));

  return (
    <DataStage theme={theme} seed="line-chart">
      <AbsoluteFill style={{ color: theme.text }}>
        <div
          style={{
            position: "absolute",
            left: pad.left,
            top: (vertical ? 260 : 110) * u,
            opacity: enter,
            transform: `translateY(${(1 - enter) * 16 * u}px)`,
          }}
        >
          <div
            style={{
              fontFamily: labelFont,
              fontWeight: 700,
              fontSize: (vertical ? 64 : 56) * u,
              letterSpacing: "-0.02em",
              lineHeight: 1.05,
            }}
          >
            {title}
          </div>
          <div
            style={{ fontFamily: labelFont, fontWeight: 500, fontSize: 30 * u, color: theme.muted, marginTop: 10 * u }}
          >
            {subtitle}
          </div>
        </div>
        <svg width={width} height={height} style={{ position: "absolute", inset: 0, overflow: "visible" }} aria-hidden>
          <defs>
            <linearGradient id={`${id}-area`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={theme.accent} stopOpacity={0.2} />
              <stop offset="100%" stopColor={theme.accent} stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${id}-stroke`} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor={theme.accent} />
              <stop offset="100%" stopColor={theme.accent} />
            </linearGradient>
            <clipPath id={`${id}-clip`}>
              <rect x={-10} y={-plotH} width={head.x + 10} height={plotH * 3} />
            </clipPath>
          </defs>
          <g transform={`translate(${pad.left} ${pad.top})`}>
            {scale.ticks.map((tick, i) => {
              const grow = progress(frame, at - 10 + i * 3, 22);
              return (
                <g key={tick} opacity={grow}>
                  <line
                    x1={0}
                    x2={plotW * grow}
                    y1={yOf(tick)}
                    y2={yOf(tick)}
                    stroke={theme.text}
                    strokeOpacity={tick === scale.min ? 0.28 : 0.08}
                    strokeWidth={1.5 * u}
                  />
                  <text
                    x={-24 * u}
                    y={yOf(tick)}
                    dy="0.35em"
                    textAnchor="end"
                    fill={theme.muted}
                    style={{ fontFamily: numberFont, fontSize: 24 * u, fontVariantNumeric: "tabular-nums" }}
                  >
                    {compact(tick, format.locale)}
                  </text>
                </g>
              );
            })}
            {data.map((datum, i) =>
              i % labelStep === 0 || i === data.length - 1 ? (
                <text
                  key={datum.label}
                  x={points[i]!.x}
                  y={plotH + 50 * u}
                  textAnchor="middle"
                  fill={i === hi && pop > 0 ? theme.text : theme.muted}
                  opacity={progress(frame, at + (i / data.length) * drawFrames - 4, 12)}
                  style={{ fontFamily: labelFont, fontWeight: 500, fontSize: 24 * u }}
                >
                  {datum.label}
                </text>
              ) : null,
            )}
            <g clipPath={`url(#${id}-clip)`}>
              <path d={`${d} L ${plotW} ${plotH} L 0 ${plotH} Z`} fill={`url(#${id}-area)`} />
            </g>
            <path
              d={d}
              fill="none"
              stroke={`url(#${id}-stroke)`}
              strokeWidth={5 * u}
              strokeLinecap="round"
              strokeDasharray={`${drawn} ${length + 10}`}
            />
            {draw > 0 && headFade > 0 ? (
              <g opacity={headFade}>
                <line
                  x1={head.x}
                  x2={head.x}
                  y1={head.y}
                  y2={plotH}
                  stroke={theme.text}
                  strokeOpacity={0.3}
                  strokeWidth={2 * u}
                  strokeDasharray={`${4 * u} ${6 * u}`}
                />
                <circle cx={head.x} cy={head.y} r={9 * u} fill={theme.text} />
                <text
                  x={head.x}
                  y={head.y - 34 * u}
                  textAnchor="middle"
                  fill={theme.text}
                  style={{
                    fontFamily: numberFont,
                    fontWeight: 700,
                    fontSize: 30 * u,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {formatValue(headValue, format)}
                </text>
              </g>
            ) : null}
            {pop > 0 ? (
              <g>
                <circle cx={hp.x} cy={hp.y} r={22 * u * pop} fill={theme.accent} opacity={0.2} />
                <circle
                  cx={hp.x}
                  cy={hp.y}
                  r={10 * u * pop}
                  fill={theme.accent}
                  stroke={theme.background}
                  strokeWidth={3 * u}
                />
                <line
                  x1={hp.x}
                  x2={hp.x + (cardLeft ? -1 : 1) * 70 * u * clamp01(card)}
                  y1={hp.y}
                  y2={hp.y - lead * 70 * u * clamp01(card)}
                  stroke={ink(theme, 0.45)}
                  strokeWidth={2 * u}
                />
              </g>
            ) : null}
          </g>
        </svg>
        {card > 0 ? (
          <div
            style={{
              position: "absolute",
              left: pad.left + hp.x + (cardLeft ? -70 : 70) * u,
              top: pad.top + hp.y - lead * 70 * u,
              transform: `translate(${cardLeft ? "-100%" : "0"}, ${cardBelow ? "0" : "-100%"}) translateY(${(1 - card) * 14 * u}px)`,
              transformOrigin: `${cardLeft ? "100%" : "0%"} ${cardBelow ? "0%" : "100%"}`,
              opacity: clamp01(card),
              padding: `${18 * u}px ${26 * u}px`,
              borderRadius: 18 * u,
              background: `color-mix(in srgb, ${theme.background} 92%, ${theme.text})`,
              border: `${2 * u}px solid ${ink(theme, 0.16)}`,
              boxShadow: `0 ${20 * u}px ${48 * u}px rgba(0,0,0,0.4)`,
              whiteSpace: "nowrap",
            }}
          >
            <div
              style={{
                fontFamily: numberFont,
                fontWeight: 800,
                fontSize: 52 * u,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "-0.02em",
                color: theme.text,
              }}
            >
              {formatValue(data[hi]!.value, format)}
            </div>
            <div style={{ fontFamily: labelFont, fontWeight: 500, fontSize: 24 * u, color: theme.text, opacity: 0.85 }}>
              {note}
            </div>
          </div>
        ) : null}
      </AbsoluteFill>
    </DataStage>
  );
};

export const lineChartRevealDefaults: LineChartRevealProps = {
  title: "Активные пользователи",
  subtitle: "Ежемесячно, млн человек · 2026",
  data: [
    { label: "Янв", value: 2.1 },
    { label: "Фев", value: 2.4 },
    { label: "Мар", value: 2.3 },
    { label: "Апр", value: 3.1 },
    { label: "Май", value: 3.6 },
    { label: "Июн", value: 3.4 },
    { label: "Июл", value: 4.5 },
    { label: "Авг", value: 5.2 },
    { label: "Сен", value: 6.1 },
    { label: "Окт", value: 7.8 },
  ],
  format: { locale: "ru-RU", decimals: 1, prefix: "", suffix: " млн" },
  highlight: -1,
  note: "Рекорд после запуска ИИ-агента",
  at: 14,
  drawFrames: 70,
  theme: keynoteTheme,
};
