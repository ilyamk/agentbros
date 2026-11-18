import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { z } from "zod";
import { progress, stagger } from "../../timing";
import {
  DataStage,
  clamp01,
  ink,
  formatValue,
  keynoteTheme,
  labelFont,
  numberFont,
  themeSchema,
  useStage,
} from "./kit";

const metricSchema = z.object({
  label: z.string(),
  before: z.number(),
  after: z.number(),
  decimals: z.number().int().min(0).max(3),
  prefix: z.string(),
  suffix: z.string(),
});

export const beforeAfterSplitSchema = z.object({
  beforeTitle: z.string(),
  afterTitle: z.string(),
  metrics: z.array(metricSchema).min(1).max(4),
  locale: z.string(),
  at: z.number(),
  theme: themeSchema,
});
export type BeforeAfterSplitProps = z.infer<typeof beforeAfterSplitSchema>;

const deltaText = (before: number, after: number, locale: string): string => {
  if (before === 0) return "";
  const pct = ((after - before) / Math.abs(before)) * 100;
  const sign = pct > 0 ? "+" : "−";
  return `${sign}${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.abs(pct))}%`;
};

/** The old numbers sit dimmed; a seam sweeps across and the new numbers roll from old to new, each landing with its change. */
export const BeforeAfterSplit: React.FC<BeforeAfterSplitProps> = ({
  beforeTitle,
  afterTitle,
  metrics,
  locale,
  at,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { width, height, u, vertical } = useStage();
  const enter = progress(frame, at - 10, 18);
  const seamAt = at + 16;
  const seam = progress(frame, seamAt, 30, "inOut");
  const starts = stagger(metrics.length, { kind: "index", step: 7 }).map((d) => seamAt + 18 + d);

  const strike = (i: number): number => progress(frame, starts[i]! + 18, 12, "expoOut");
  const half = vertical ? height / 2 : width / 2;
  const seamPos = half * (2 - seam);
  const panelPad = (vertical ? 90 : 120) * u;

  const panel = (side: "before" | "after"): React.ReactNode => {
    const isAfter = side === "after";
    return (
      <div
        style={{
          position: "absolute",
          ...(vertical
            ? { left: 0, right: 0, top: isAfter ? half : 0, height: half }
            : { top: 0, bottom: 0, left: isAfter ? half : 0, width: half }),
          padding: panelPad,
          paddingTop: vertical ? (isAfter ? 80 : 200) * u : 200 * u,
          display: "flex",
          flexDirection: "column",
          gap: (vertical ? 34 : 48) * u,
          color: theme.text,
        }}
      >
        <div
          style={{
            fontFamily: labelFont,
            fontWeight: 600,
            fontSize: 30 * u,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: isAfter ? theme.text : theme.muted,
          }}
        >
          {isAfter ? afterTitle : beforeTitle}
        </div>
        {metrics.map((m, i) => {
          const fmt = { locale, decimals: m.decimals, prefix: m.prefix, suffix: m.suffix };
          const roll = isAfter ? progress(frame, starts[i]!, 30, "expoOut") : 1;
          const value = isAfter ? m.before + (m.after - m.before) * roll : m.before;
          const chip = progress(frame, starts[i]! + 20, 14, "expoOut");
          const delta = deltaText(m.before, m.after, locale);
          return (
            <div key={m.label} style={{ display: "flex", flexDirection: "column", gap: 4 * u }}>
              <div style={{ fontFamily: labelFont, fontWeight: 500, fontSize: 28 * u, color: theme.muted }}>
                {m.label}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 22 * u }}>
                <div
                  style={{
                    position: "relative",
                    fontFamily: numberFont,
                    fontWeight: isAfter ? 800 : 600,
                    fontSize: (vertical ? 92 : 104) * u,
                    letterSpacing: "-0.035em",
                    lineHeight: 1,
                    fontVariantNumeric: "tabular-nums",
                    color: isAfter ? theme.text : `color-mix(in srgb, ${theme.text} 42%, transparent)`,
                  }}
                >
                  {formatValue(value, fmt)}
                  {isAfter || strike(i) <= 0 ? null : (
                    <div
                      style={{
                        position: "absolute",
                        left: -6 * u,
                        top: "52%",
                        height: 4 * u,
                        width: `calc((100% + ${12 * u}px) * ${strike(i)})`,
                        backgroundColor: theme.muted,
                        opacity: 0.7,
                        borderRadius: 2 * u,
                      }}
                    />
                  )}
                </div>
                {isAfter && delta ? (
                  <div
                    style={{
                      fontFamily: numberFont,
                      fontWeight: 700,
                      fontSize: 30 * u,
                      color: theme.background,
                      backgroundColor: theme.accent,
                      padding: `${6 * u}px ${16 * u}px`,
                      borderRadius: 999,
                      opacity: chip,
                      transform: `translateX(${(1 - chip) * -10 * u}px)`,
                    }}
                  >
                    {delta}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const clip = vertical ? `inset(${seamPos}px 0 0 0)` : `inset(0 0 0 ${seamPos}px)`;
  return (
    <DataStage theme={theme} seed="before-after">
      <AbsoluteFill style={{ opacity: enter }}>{panel("before")}</AbsoluteFill>
      <AbsoluteFill style={{ clipPath: clip, opacity: seam > 0 ? 1 : 0 }}>
        <AbsoluteFill style={{ background: vertical ? ink(theme, 0) : ink(theme, 0) }} />
        {panel("after")}
      </AbsoluteFill>
      {seam > 0 ? (
        <div
          style={{
            position: "absolute",
            ...(vertical
              ? { left: 0, right: 0, top: seamPos - 1.5 * u, height: 3 * u }
              : { top: 0, bottom: 0, left: seamPos - 1.5 * u, width: 3 * u }),
            background: ink(theme, 0.5),
          }}
        />
      ) : null}
    </DataStage>
  );
};

export const beforeAfterSplitDefaults: BeforeAfterSplitProps = {
  beforeTitle: "Вручную",
  afterTitle: "С агентом",
  metrics: [
    { label: "Время на отчёт", before: 6.5, after: 0.4, decimals: 1, prefix: "", suffix: " ч" },
    { label: "Ошибок в месяц", before: 38, after: 3, decimals: 0, prefix: "", suffix: "" },
    { label: "Стоимость обработки", before: 1240, after: 180, decimals: 0, prefix: "", suffix: " ₽" },
  ],
  locale: "ru-RU",
  at: 10,
  theme: keynoteTheme,
};
