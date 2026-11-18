import React from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { progress, stagger } from "../../timing";
import {
  DataStage,
  clamp01,
  ink,
  datumSchema,
  formatSchema,
  formatValue,
  keynoteTheme,
  labelFont,
  niceScale,
  numberFont,
  themeSchema,
  useStage,
} from "./kit";

export const rankedBarsSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  data: z.array(datumSchema).min(2).max(10),
  format: formatSchema,
  /** Sort largest first; off keeps the given order. */
  sort: z.boolean(),
  at: z.number(),
  staggerFrames: z.number().min(0),
  theme: themeSchema,
});
export type RankedBarsProps = z.infer<typeof rankedBarsSchema>;

/** Ranked bars spring out one after another with counting labels on their tips; the leader alone keeps the accent. */
export const RankedBars: React.FC<RankedBarsProps> = ({
  title,
  subtitle,
  data,
  format,
  sort,
  at,
  staggerFrames,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, u, vertical } = useStage();
  const rows = sort ? [...data].sort((a, b) => b.value - a.value) : data;
  const max = Math.max(...rows.map((r) => r.value));
  const leader = rows.findIndex((r) => r.value === max);
  const scale = niceScale(0, max, 5);
  const top = Math.max(max, scale.max * 0.88);

  const left = vertical ? 80 * u : 200 * u;
  const right = vertical ? 80 * u : 200 * u;
  const labelW = vertical ? 0 : 300 * u;
  const trackW = width - left - right - labelW - 160 * u;
  const areaTop = vertical ? 560 * u : 290 * u;
  const areaH = vertical ? height - areaTop - 260 * u : height - areaTop - 130 * u;
  const rowH = areaH / rows.length;
  const barH = Math.min(rowH * (vertical ? 0.36 : 0.56), 72 * u);
  const delays = stagger(rows.length, { kind: "index", step: staggerFrames });
  const settled = at + delays.at(-1)! + 34;
  const crown = progress(frame, settled, 20);
  const enter = progress(frame, at - 12, 20);

  return (
    <DataStage theme={theme} seed="ranked-bars">
      <AbsoluteFill style={{ color: theme.text }}>
        <div
          style={{
            position: "absolute",
            left,
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
        {rows.map((row, i) => {
          const start = at + delays[i]!;
          const grow = spring({ frame: frame - start, fps, config: { damping: 14, stiffness: 140, mass: 0.8 } });
          const count = progress(frame, start, 26, "expoOut");
          const appear = progress(frame, start - 6, 14);
          const isLeader = i === leader;
          const dim = isLeader ? 0 : crown * 0.3;
          const w = Math.max((row.value / top) * trackW * grow, 0);
          const y = areaTop + i * rowH + (rowH - barH) / 2 + (vertical ? rowH * 0.16 : 0);
          const fill = isLeader ? theme.accent : ink(theme, 0.28);
          return (
            <div key={`${row.label}-${i}`} style={{ position: "absolute", left, top: y, opacity: appear * (1 - dim) }}>
              <div
                style={{
                  position: "absolute",
                  ...(vertical
                    ? { left: 0, top: -48 * u }
                    : { left: 0, top: 0, height: barH, width: labelW - 28 * u, justifyContent: "flex-end" }),
                  display: "flex",
                  alignItems: "center",
                  fontFamily: labelFont,
                  fontWeight: isLeader ? 700 : 500,
                  fontSize: (vertical ? 32 : 30) * u,
                  whiteSpace: "nowrap",
                  color: isLeader && crown > 0 ? theme.text : `color-mix(in srgb, ${theme.text} 80%, transparent)`,
                }}
              >
                {row.label}
              </div>
              <div
                style={{
                  position: "absolute",
                  left: labelW,
                  top: 0,
                  width: trackW,
                  height: barH,
                  borderRadius: barH / 2,
                  backgroundColor: ink(theme, 0.06),
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: labelW,
                  top: 0,
                  width: w,
                  height: barH,
                  borderRadius: barH / 2,
                  background: fill,
                }}
              ></div>
              <div
                style={{
                  position: "absolute",
                  left: labelW + w + 22 * u,
                  top: 0,
                  height: barH,
                  display: "flex",
                  alignItems: "center",
                  fontFamily: numberFont,
                  fontWeight: isLeader ? 800 : 600,
                  fontSize: (isLeader ? 42 : 34) * u,
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: "-0.01em",
                  whiteSpace: "nowrap",
                  color: isLeader ? theme.text : `color-mix(in srgb, ${theme.text} 85%, transparent)`,
                }}
              >
                {formatValue(row.value * clamp01(count), format)}
              </div>
            </div>
          );
        })}
      </AbsoluteFill>
    </DataStage>
  );
};

export const rankedBarsDefaults: RankedBarsProps = {
  title: "Where we grew fastest",
  subtitle: "Revenue growth by market, 2026 vs 2025",
  data: [
    { label: "Germany", value: 41 },
    { label: "Brazil", value: 128 },
    { label: "Japan", value: 36 },
    { label: "India", value: 94 },
    { label: "Mexico", value: 67 },
    { label: "Indonesia", value: 58 },
  ],
  format: { locale: "en-GB", decimals: 0, prefix: "+", suffix: "%" },
  sort: true,
  at: 14,
  staggerFrames: 5,
  theme: keynoteTheme,
};
