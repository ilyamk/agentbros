import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { z } from "zod";
import { odometerReels } from "../../kinetic-math";
import { progress } from "../../timing";
import {
  DataStage,
  clamp01,
  ink,
  formatSchema,
  keynoteTheme,
  labelFont,
  numberFont,
  smoothPath,
  themeSchema,
  useStage,
} from "./kit";

export const heroStatSchema = z.object({
  kicker: z.string(),
  value: z.number().min(0),
  format: formatSchema,
  label: z.string(),
  delta: z.string(),
  /** Supporting series drawn under the number as it counts; empty hides it. */
  sparkline: z.array(z.number()),
  at: z.number(),
  countFrames: z.number().int().min(10),
  theme: themeSchema,
});
export type HeroStatProps = z.infer<typeof heroStatSchema>;

const separators = (locale: string): { group: string; decimal: string } => {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  return {
    group: parts.find((p) => p.type === "group")?.value ?? ",",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
};

/** Slow tail so the last digits are readable as they lock. */
const countCurve = (t: number): number => 1 - (1 - t) ** 4;

const Odometer: React.FC<{
  value: number;
  next: number;
  target: number;
  decimals: number;
  locale: string;
  size: number;
}> = ({ value, next, target, decimals, locale, size }) => {
  const scale = 10 ** decimals;
  const columns = Math.max(String(Math.round(target * scale)).length, decimals + 1);
  const reels = odometerReels(value * scale, columns);
  const nextReels = odometerReels(next * scale, columns);
  const { group, decimal } = separators(locale);
  const height = size * 1.02;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", height }}>
      {reels.map((reel, column) => {
        const fromRight = columns - 1 - column;
        const intPlace = fromRight - decimals;
        const hidden = intPlace > 0 && value * scale < 10 ** fromRight;
        const digit = Math.floor(reel) % 10;
        const offset = reel - Math.floor(reel);
        const speed = Math.min(Math.abs(nextReels[column]! - reel), 1.5);
        return (
          <React.Fragment key={column}>
            <span
              style={{
                position: "relative",
                display: "inline-block",
                width: "0.6em",
                height,
                overflow: "hidden",
                textAlign: "center",
                opacity: hidden ? 0 : 1,
                maskImage: "linear-gradient(transparent 0, black 18%, black 82%, transparent 100%)",
                WebkitMaskImage: "linear-gradient(transparent 0, black 18%, black 82%, transparent 100%)",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: 0,
                  transform: `translateY(${-offset * height}px)`,
                  filter: speed > 0.05 ? `blur(${speed * size * 0.03}px)` : undefined,
                  lineHeight: `${height}px`,
                }}
              >
                <span style={{ display: "block" }}>{digit}</span>
                <span style={{ display: "block" }}>{(digit + 1) % 10}</span>
              </span>
            </span>
            {intPlace > 0 && intPlace % 3 === 0 ? (
              <span style={{ opacity: hidden ? 0 : 1, width: group.trim() ? "0.28em" : "0.18em", textAlign: "center" }}>
                {group.trim()}
              </span>
            ) : null}
            {decimals > 0 && fromRight === decimals ? (
              <span style={{ width: "0.26em", textAlign: "center" }}>{decimal}</span>
            ) : null}
          </React.Fragment>
        );
      })}
    </span>
  );
};

/** The keynote stat: one huge number rolls up on odometer reels while its own history draws beneath it, then lands and holds still. */
export const HeroStat: React.FC<HeroStatProps> = ({
  kicker,
  value,
  format,
  label,
  delta,
  sparkline,
  at,
  countFrames,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { width, u, vertical } = useStage();
  const land = at + countFrames;
  const t = progress(frame, at, countFrames, countCurve);
  const tNext = progress(frame + 1, at, countFrames, countCurve);
  const enter = progress(frame, at - 8, 22);
  const integerDigits = String(Math.floor(value)).length;
  const ems =
    (integerDigits + format.decimals) * 0.6 +
    Math.floor((integerDigits - 1) / 3) * 0.28 +
    (format.decimals > 0 ? 0.26 : 0) +
    format.prefix.length * 0.4 +
    format.suffix.length * 0.36;
  const size = Math.min((vertical ? 250 : 300) * u, (width * 0.86) / ems);

  const sparkWidth = vertical ? width * 0.78 : width * 0.5;
  const sparkHeight = 120 * u;
  const lo = Math.min(...sparkline);
  const hi = Math.max(...sparkline);
  const points = sparkline.map((v, i) => ({
    x: (i / Math.max(sparkline.length - 1, 1)) * sparkWidth,
    y: sparkHeight - ((v - lo) / (hi - lo || 1)) * sparkHeight,
  }));
  const reveal = clamp01(t);
  const clipX = reveal * sparkWidth;
  const headIndex = reveal * (points.length - 1);
  const i0 = Math.floor(headIndex);
  const p0 = points[Math.min(i0, points.length - 1)];
  const p1 = points[Math.min(i0 + 1, points.length - 1)];
  const head =
    p0 && p1 ? { x: p0.x + (p1.x - p0.x) * (headIndex - i0), y: p0.y + (p1.y - p0.y) * (headIndex - i0) } : null;
  const id = React.useId().replaceAll(":", "");

  const chip = progress(frame, land + 2, 16, "expoOut");

  return (
    <DataStage theme={theme} seed="hero-stat">
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          gap: 28 * u,
          flexDirection: "column",
          color: theme.text,
        }}
      >
        <div
          style={{
            fontFamily: labelFont,
            fontWeight: 600,
            fontSize: 30 * u,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: theme.muted,
            opacity: enter,
            transform: `translateY(${(1 - enter) * 14 * u}px)`,
          }}
        >
          {kicker}
        </div>
        <div style={{ position: "relative" }}>
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "flex-end",
              fontFamily: numberFont,
              fontWeight: 800,
              fontSize: size,
              letterSpacing: "-0.04em",
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
              opacity: enter,
              color: theme.text,
            }}
          >
            {format.prefix ? (
              <span style={{ fontSize: "0.62em", lineHeight: 1, paddingBottom: "0.16em", marginRight: "0.04em" }}>
                {format.prefix}
              </span>
            ) : null}
            <Odometer
              value={value * t}
              next={value * tNext}
              target={value}
              decimals={format.decimals}
              locale={format.locale}
              size={size}
            />
            {format.suffix ? (
              <span
                style={{
                  fontSize: "0.55em",
                  lineHeight: 1,
                  paddingBottom: "0.13em",
                  marginLeft: "0.06em",
                  color: theme.muted,
                }}
              >
                {format.suffix}
              </span>
            ) : null}
          </div>
        </div>
        <div
          style={{
            fontFamily: labelFont,
            fontWeight: 500,
            fontSize: 40 * u,
            color: theme.text,
            opacity: enter * 0.92,
            maxWidth: vertical ? width * 0.8 : width * 0.6,
            textAlign: "center",
            lineHeight: 1.2,
          }}
        >
          {label}
        </div>
        {delta ? (
          <div
            style={{
              fontFamily: numberFont,
              fontWeight: 700,
              fontSize: 28 * u,
              fontVariantNumeric: "tabular-nums",
              color: theme.text,
              backgroundColor: ink(theme, 0.1),
              border: `${2 * u}px solid ${ink(theme, 0.18)}`,
              padding: `${8 * u}px ${20 * u}px`,
              borderRadius: 999,
              opacity: chip,
              transform: `translateY(${(1 - chip) * 12 * u}px)`,
            }}
          >
            {delta}
          </div>
        ) : null}
        {sparkline.length > 1 ? (
          <svg
            width={sparkWidth + 40 * u}
            height={sparkHeight + 40 * u}
            viewBox={`${-20 * u} ${-20 * u} ${sparkWidth + 40 * u} ${sparkHeight + 40 * u}`}
            style={{ marginTop: (vertical ? 40 : 10) * u, opacity: enter, overflow: "visible" }}
            aria-hidden
          >
            <defs>
              <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={theme.accent} stopOpacity={0.22} />
                <stop offset="100%" stopColor={theme.accent} stopOpacity={0} />
              </linearGradient>
              <clipPath id={`${id}-clip`}>
                <rect x={-20 * u} y={-40 * u} width={clipX + 20 * u} height={sparkHeight + 80 * u} />
              </clipPath>
            </defs>
            <path
              d={smoothPath(points)}
              fill="none"
              stroke={theme.muted}
              strokeOpacity={0.18}
              strokeWidth={2 * u}
              strokeDasharray={`${4 * u} ${8 * u}`}
            />
            <g clipPath={`url(#${id}-clip)`}>
              <path
                d={`${smoothPath(points)} L ${sparkWidth} ${sparkHeight} L 0 ${sparkHeight} Z`}
                fill={`url(#${id}-fill)`}
              />
              <path
                d={smoothPath(points)}
                fill="none"
                stroke={theme.accent}
                strokeWidth={4 * u}
                strokeLinecap="round"
              />
            </g>
            {head && reveal > 0 ? (
              <>
                <circle cx={head.x} cy={head.y} r={7 * u} fill={theme.text} />
              </>
            ) : null}
          </svg>
        ) : null}
      </AbsoluteFill>
    </DataStage>
  );
};

export const heroStatDefaults: HeroStatProps = {
  kicker: "Processed in 2026",
  value: 1.42,
  format: { locale: "en-GB", decimals: 2, prefix: "$", suffix: "T" },
  label: "in total payment volume, across 46 countries",
  delta: "+38% year on year",
  sparkline: [0.41, 0.46, 0.44, 0.55, 0.61, 0.58, 0.72, 0.8, 0.86, 0.97, 1.08, 1.21, 1.29, 1.42],
  at: 8,
  countFrames: 62,
  theme: keynoteTheme,
};
