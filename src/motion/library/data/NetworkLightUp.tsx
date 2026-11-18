import type React from "react";
import { AbsoluteFill, random, useCurrentFrame } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import {
  DataStage,
  clamp01,
  ink,
  formatSchema,
  formatValue,
  keynoteTheme,
  labelFont,
  numberFont,
  themeSchema,
  useStage,
} from "./kit";

export const networkLightUpSchema = z.object({
  hub: z.string(),
  /** Named nodes on the inner ring, lit in order. */
  nodes: z.array(z.string()).min(2).max(10),
  /** Unnamed outer nodes that branch off the named ones. */
  ambient: z.number().int().min(0).max(80),
  statValue: z.number(),
  statLabel: z.string(),
  format: formatSchema,
  seed: z.string(),
  at: z.number(),
  theme: themeSchema,
});
export type NetworkLightUpProps = z.infer<typeof networkLightUpSchema>;

type Node = { x: number; y: number; at: number; parent: number; named: boolean; label: string };

const EDGE_FRAMES = 10;

/** A hub lights its named nodes one by one along drawn edges and outer nodes branch off them as a counter climbs; once lit, it holds still. */
export const NetworkLightUp: React.FC<NetworkLightUpProps> = ({
  hub,
  nodes: names,
  ambient,
  statValue,
  statLabel,
  format,
  seed,
  at,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { width, height, u, vertical } = useStage();
  const cx = width / 2;
  const cy = vertical ? height * 0.44 : height * 0.47;
  const rx = (vertical ? 330 : 520) * u;
  const ry = (vertical ? 430 : 290) * u;

  const graph: Node[] = [{ x: cx, y: cy, at, parent: -1, named: true, label: hub }];
  names.forEach((label, i) => {
    const angle = -Math.PI / 2 + (i / names.length) * Math.PI * 2 + (random(`${seed}-a-${i}`) - 0.5) * 0.3;
    const r = 0.86 + random(`${seed}-r-${i}`) * 0.18;
    graph.push({
      x: cx + Math.cos(angle) * rx * r,
      y: cy + Math.sin(angle) * ry * r,
      at: at + 10 + i * 5,
      parent: 0,
      named: true,
      label,
    });
  });
  for (let i = 0; i < ambient; i++) {
    const angle = random(`${seed}-aa-${i}`) * Math.PI * 2;
    const r = 1.2 + random(`${seed}-ar-${i}`) * 0.55;
    const x = cx + Math.cos(angle) * rx * r;
    const jitter = random(`${seed}-aj-${i}`) * 110 * u;
    const y = Math.min(
      Math.max(cy + Math.sin(angle) * ry * r, 90 * u + jitter),
      height - (vertical ? 470 : 240) * u - jitter,
    );
    let parent = 1;
    let best = Infinity;
    for (let p = 1; p <= names.length; p++) {
      const dist = (graph[p]!.x - x) ** 2 + (graph[p]!.y - y) ** 2;
      if (dist < best) [best, parent] = [dist, p];
    }
    graph.push({
      x,
      y,
      at: graph[parent]!.at + EDGE_FRAMES + 2 + Math.floor(random(`${seed}-at-${i}`) * 16),
      parent,
      named: false,
      label: "",
    });
  }

  const enter = progress(frame, at - 10, 18);
  const lastAt = Math.max(...graph.map((n) => n.at));
  const count = progress(frame, at + 6, lastAt - at + 6, "expoOut");
  const lit = (n: Node): number => progress(frame, n.at, 12, "expoOut");

  return (
    <DataStage theme={theme} seed={`network-${seed}`}>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden>
        {graph.map((n, i) => {
          if (n.parent < 0) return null;
          const p = graph[n.parent]!;
          const draw = progress(frame, n.at - EDGE_FRAMES, EDGE_FRAMES, "inOut");
          if (draw <= 0) return null;
          const hx = p.x + (n.x - p.x) * draw;
          const hy = p.y + (n.y - p.y) * draw;
          return (
            <g key={i}>
              <line
                x1={p.x}
                y1={p.y}
                x2={hx}
                y2={hy}
                stroke={theme.text}
                strokeOpacity={n.named ? 0.4 : 0.16}
                strokeWidth={2 * u}
              />
              {draw < 1 ? <circle cx={hx} cy={hy} r={5 * u} fill={theme.text} /> : null}
            </g>
          );
        })}
        {graph.map((n, i) => {
          const s = lit(n);
          if (s <= 0) return null;
          const isHub = i === 0;
          const r = (isHub ? 34 : n.named ? 14 : 6) * u;
          return (
            <g key={`n-${i}`}>
              <circle
                cx={n.x}
                cy={n.y}
                r={r * s}
                fill={isHub ? theme.accent : n.named ? theme.text : ink(theme, 0.4)}
              />
            </g>
          );
        })}
      </svg>
      <AbsoluteFill>
        {graph.map((n, i) => {
          if (!n.named || i === 0) return null;
          const a = clamp01(progress(frame, n.at + 2, 12));
          const below = n.y > cy;
          return (
            <div
              key={`l-${i}`}
              style={{
                position: "absolute",
                left: n.x,
                top: n.y + (below ? 28 : -28) * u,
                transform: `translate(-50%, ${below ? "0" : "-100%"}) translateY(${(1 - a) * (below ? -8 : 8) * u}px)`,
                opacity: a,
                fontFamily: labelFont,
                fontWeight: 600,
                fontSize: 28 * u,
                color: theme.text,
                whiteSpace: "nowrap",
              }}
            >
              {n.label}
            </div>
          );
        })}
        <div
          style={{
            position: "absolute",
            left: cx,
            top: cy,
            transform: "translate(-50%, -50%)",
            marginTop: 74 * u,
            opacity: lit(graph[0]!) > 0 ? 1 : 0,
            fontFamily: labelFont,
            fontWeight: 700,
            fontSize: 30 * u,
            color: theme.text,
            whiteSpace: "nowrap",
            letterSpacing: "0.04em",
          }}
        >
          {hub}
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: (vertical ? 200 : 70) * u,
            textAlign: "center",
            opacity: enter,
            color: theme.text,
          }}
        >
          <div
            style={{
              fontFamily: numberFont,
              fontWeight: 800,
              fontSize: (vertical ? 120 : 96) * u,
              letterSpacing: "-0.035em",
              lineHeight: 1,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatValue(statValue * count, format)}
          </div>
          <div
            style={{ fontFamily: labelFont, fontWeight: 500, fontSize: 30 * u, color: theme.muted, marginTop: 8 * u }}
          >
            {statLabel}
          </div>
        </div>
      </AbsoluteFill>
    </DataStage>
  );
};

export const networkLightUpDefaults: NetworkLightUpProps = {
  hub: "Ядро",
  nodes: ["CRM", "Почта", "Telegram", "Склад", "Оплаты", "Аналитика", "Поддержка"],
  ambient: 34,
  statValue: 12480,
  statLabel: "событий в минуту между сервисами",
  format: { locale: "ru-RU", decimals: 0, prefix: "", suffix: "" },
  seed: "mesh",
  at: 12,
  theme: keynoteTheme,
};
