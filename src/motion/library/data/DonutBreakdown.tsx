import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import {
  DataStage,
  clamp01,
  datumSchema,
  formatSchema,
  formatValue,
  keynoteTheme,
  labelFont,
  numberFont,
  themeSchema,
  useStage,
} from "./kit";

export const donutBreakdownSchema = z.object({
  title: z.string(),
  data: z.array(datumSchema).min(1).max(7),
  /** One colour per segment, in order; repeats when short. */
  colours: z.array(z.string()).min(1),
  /** Segment whose share the centre counts to and which lifts out at the end. */
  focus: z.number().int().min(0),
  centreLabel: z.string(),
  format: formatSchema,
  at: z.number(),
  sweepFrames: z.number().int().min(10),
  theme: themeSchema,
});
export type DonutBreakdownProps = z.infer<typeof donutBreakdownSchema>;

/** A donut sweeps round segment by segment with rounded gaps, the legend answering each arrival; the focus slice then lifts out as the centre lands on its share. */
export const DonutBreakdown: React.FC<DonutBreakdownProps> = ({
  title,
  data,
  colours,
  focus,
  centreLabel,
  format,
  at,
  sweepFrames,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { width, height, u, vertical } = useStage();
  const total = data.reduce((sum, d) => sum + Math.max(d.value, 0), 0) || 1;
  const shares = data.map((d) => Math.max(d.value, 0) / total);
  const focusIndex = Math.min(focus, data.length - 1);

  const radius = (vertical ? 300 : 280) * u;
  const stroke = (vertical ? 50 : 44) * u;
  const box = (radius + stroke) * 2 + 60 * u;
  const cx = vertical ? width / 2 : width * 0.32;
  const cy = vertical ? height * 0.36 : height * 0.53;
  const circumference = 2 * Math.PI * radius;
  const gap = data.length > 1 ? 16 * u + stroke : 0;
  const sweep = progress(frame, at, sweepFrames, "drift");
  const settled = at + sweepFrames;
  const lift = progress(frame, settled + 2, 20, "expoOut");
  const enter = progress(frame, at - 12, 20);
  const centre = progress(frame, at + sweepFrames * 0.3, sweepFrames * 0.9, "expoOut");

  let cursor = 0;
  const segments = shares.map((share, i) => {
    const start = cursor;
    cursor += share;
    return { start, share, i, colour: colours[i % colours.length]! };
  });

  return (
    <DataStage theme={theme} seed="donut">
      <AbsoluteFill style={{ color: theme.text }}>
        <div
          style={{
            position: "absolute",
            left: vertical ? 0 : width * 0.56,
            right: vertical ? 0 : undefined,
            top: vertical ? 200 * u : height * 0.2,
            textAlign: vertical ? "center" : "left",
            fontFamily: labelFont,
            fontWeight: 700,
            fontSize: (vertical ? 60 : 54) * u,
            letterSpacing: "-0.02em",
            lineHeight: 1.1,
            maxWidth: vertical ? undefined : width * 0.38,
            opacity: enter,
            transform: `translateY(${(1 - enter) * 16 * u}px)`,
          }}
        >
          {title}
        </div>
        <svg
          width={box}
          height={box}
          viewBox={`${-box / 2} ${-box / 2} ${box} ${box}`}
          style={{ position: "absolute", left: cx - box / 2, top: cy - box / 2, overflow: "visible" }}
          aria-hidden
        >
          <circle r={radius} fill="none" stroke={theme.text} strokeOpacity={0.06 * enter} strokeWidth={stroke} />
          {segments.map(({ start, share, i, colour }) => {
            const shown = clamp01((sweep - start) / share) * share;
            if (shown <= 0) return null;
            const isFocus = i === focusIndex;
            const arc = Math.max(shown * circumference - gap, 0.5);
            const mid = (start + share / 2) * 2 * Math.PI - Math.PI / 2;
            const push = isFocus ? 26 * u * lift : 0;
            const dim = isFocus ? 1 : 1 - 0.35 * clamp01(lift);
            return (
              <g key={i} transform={`translate(${Math.cos(mid) * push} ${Math.sin(mid) * push})`} opacity={dim}>
                <circle
                  r={radius}
                  fill="none"
                  stroke={colour}
                  strokeWidth={stroke + (isFocus ? 10 * u * clamp01(lift) : 0)}
                  strokeLinecap="round"
                  strokeDasharray={`${arc} ${circumference}`}
                  transform={`rotate(${start * 360 - 90 + (gap / 2 / circumference) * 360})`}
                />
              </g>
            );
          })}
        </svg>
        <div
          style={{
            position: "absolute",
            left: cx,
            top: cy,
            transform: "translate(-50%, -50%)",
            textAlign: "center",
            opacity: enter,
          }}
        >
          <div
            style={{
              fontFamily: numberFont,
              fontWeight: 800,
              fontSize: 132 * u,
              letterSpacing: "-0.04em",
              lineHeight: 1,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatValue(shares[focusIndex]! * 100 * centre, { ...format, suffix: "%", prefix: "" })}
          </div>
          <div
            style={{
              fontFamily: labelFont,
              fontWeight: 500,
              fontSize: 28 * u,
              color: theme.muted,
              marginTop: 10 * u,
              maxWidth: radius * 1.3,
            }}
          >
            {centreLabel}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: vertical ? 120 * u : width * 0.56,
            right: vertical ? 120 * u : undefined,
            top: vertical ? cy + radius + stroke + 110 * u : height * 0.38,
            display: "flex",
            flexDirection: "column",
            gap: (vertical ? 26 : 22) * u,
            width: vertical ? undefined : width * 0.34,
          }}
        >
          {segments.map(({ start, i, colour }) => {
            const appear = progress(frame, at + start * sweepFrames - 2, 14);
            const isFocus = i === focusIndex;
            const dim = isFocus ? 1 : 1 - 0.4 * clamp01(lift);
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 20 * u,
                  opacity: appear * dim,
                  transform: `translateX(${(1 - appear) * 24 * u}px)`,
                  fontFamily: labelFont,
                  fontSize: 34 * u,
                }}
              >
                <div style={{ width: 22 * u, height: 22 * u, borderRadius: "50%", backgroundColor: colour }} />
                <div style={{ flex: 1, fontWeight: isFocus ? 700 : 500 }}>{data[i]!.label}</div>
                <div
                  style={{
                    fontFamily: numberFont,
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    color: isFocus ? theme.text : theme.muted,
                  }}
                >
                  {formatValue(data[i]!.value * clamp01(appear), format)}
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </DataStage>
  );
};

export const donutBreakdownDefaults: DonutBreakdownProps = {
  title: "Откуда приходят клиенты",
  data: [
    { label: "Рекомендации", value: 46 },
    { label: "Поиск", value: 24 },
    { label: "Соцсети", value: 17 },
    { label: "Партнёры", value: 9 },
    { label: "Другое", value: 4 },
  ],
  colours: [
    "#3D8BFF",
    "rgba(244,244,242,0.55)",
    "rgba(244,244,242,0.36)",
    "rgba(244,244,242,0.22)",
    "rgba(244,244,242,0.12)",
  ],
  focus: 0,
  centreLabel: "по рекомендации",
  format: { locale: "ru-RU", decimals: 0, prefix: "", suffix: "%" },
  at: 14,
  sweepFrames: 56,
  theme: keynoteTheme,
};
