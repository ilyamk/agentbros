import type React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { cyrillicGroteskFont } from "../../../lib/fonts-cyrillic";
import { FilmGrain } from "../../fx";

export const numberFont = primaryFont;
export const labelFont = cyrillicGroteskFont;

export const datumSchema = z.object({ label: z.string(), value: z.number() });
export type Datum = z.infer<typeof datumSchema>;

export const themeSchema = z.object({
  background: z.string(),
  glow: z.string(),
  text: z.string(),
  muted: z.string(),
  accent: z.string(),
  accent2: z.string(),
});
export type Theme = z.infer<typeof themeSchema>;

/** Neutral graphite, ink alphas for everything, one accent for the one element that carries the point. */
export const keynoteTheme: Theme = {
  background: "#0E0E10",
  glow: "#FFF4E6",
  text: "#F4F4F2",
  muted: "#8E8E93",
  accent: "#3D8BFF",
  accent2: "#3D8BFF",
};

/** Ink at a given alpha: the colour of every element that is not the point. */
export const ink = (theme: Theme, alpha: number): string =>
  `color-mix(in srgb, ${theme.text} ${Math.round(alpha * 100)}%, transparent)`;

export const formatSchema = z.object({
  locale: z.string(),
  decimals: z.number().int().min(0).max(4),
  prefix: z.string(),
  suffix: z.string(),
});
export type NumberFormat = z.infer<typeof formatSchema>;

/** Locale-aware grouping (`ru-RU` gives a narrow no-break space), fixed decimals, so widths never jitter. */
export const formatValue = (value: number, { locale, decimals, prefix, suffix }: NumberFormat): string =>
  `${prefix}${new Intl.NumberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value)}${suffix}`;

/** Axis bounds and ticks on 1/2/5 x 10^n steps that contain `min` and `max`. */
export const niceScale = (
  min: number,
  max: number,
  ticks = 5,
): { min: number; max: number; step: number; ticks: number[] } => {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / Math.max(ticks - 1, 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return { min: lo, max: hi, step, ticks: out };
};

/** Short axis numbers: 12 000 -> 12K, 3 400 000 -> 3.4M. */
export const compact = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);

/** A smooth curve through points that never overshoots between them (monotone cubic in x). */
export const smoothPath = (points: readonly { x: number; y: number }[]): string => {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`;
  const n = points.length;
  const dx = points.slice(1).map((p, i) => p.x - points[i]!.x);
  const slope = points.slice(1).map((p, i) => (p.y - points[i]!.y) / dx[i]!);
  const tangent = points.map((_, i) => {
    if (i === 0) return slope[0]!;
    if (i === n - 1) return slope[n - 2]!;
    const a = slope[i - 1]!;
    const b = slope[i]!;
    return a * b <= 0
      ? 0
      : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b);
  });
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < n - 1; i++) {
    const p = points[i]!;
    const q = points[i + 1]!;
    const h = dx[i]! / 3;
    d += ` C ${p.x + h} ${p.y + tangent[i]! * h} ${q.x - h} ${q.y - tangent[i + 1]! * h} ${q.x} ${q.y}`;
  }
  return d;
};

/** Stage geometry shared by every data item: `u` is one design pixel at 1080 on the short side. */
export const useStage = (): { width: number; height: number; u: number; vertical: boolean } => {
  const { width, height } = useVideoConfig();
  return { width, height, u: Math.min(width, height) / 1080, vertical: height > width * 1.2 };
};

type DataStageProps = { theme: Theme; seed: string; children: React.ReactNode };

/** Neutral solid ground, one soft local light from the upper left, a 0.5 vignette and grain: the room a stat lives in. */
export const DataStage: React.FC<DataStageProps> = ({ theme, seed, children }) => (
  <AbsoluteFill style={{ backgroundColor: theme.background, overflow: "hidden" }}>
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse 70% 60% at 28% 22%, color-mix(in srgb, ${theme.glow} 16%, transparent) 0%, transparent 70%)`,
      }}
    />
    <AbsoluteFill
      style={{ background: "radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0,0,0,0.5) 100%)" }}
    />
    {children}
    <FilmGrain seed={seed} opacity={0.065} />
  </AbsoluteFill>
);

export const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1);
