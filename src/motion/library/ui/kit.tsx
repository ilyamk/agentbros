import React from "react";
import { AbsoluteFill, Easing, random, useCurrentFrame, useVideoConfig } from "remotion";
import { geist } from "./fonts";
import { FilmGrain } from "../../fx";

/** Shared pieces for the ui category: tokens, a lit stage, icons and a believable app screen. */

export const uiFont = geist;

export type UiTheme = {
  canvas: string;
  panel: string;
  raised: string;
  line: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  positive: string;
  negative: string;
};

/** Theme for the screen components (`DashboardScreen`, `MobileScreen`), on the shadcn neutral tokens of `surface.tsx`. */
export const darkTheme = (accent = "#3B82F6"): UiTheme => ({
  canvas: "#0A0A0A",
  panel: "#141416",
  raised: "rgba(255,255,255,0.07)",
  line: "rgba(255,255,255,0.1)",
  text: "#FAFAFA",
  muted: "#A1A1AA",
  faint: "#71717A",
  accent,
  positive: "#22C55E",
  negative: "#F87171",
});

export const ink = (alpha: number, tone: "dark" | "light" = "dark") =>
  tone === "dark" ? `rgba(255,255,255,${alpha})` : `rgba(10,10,10,${alpha})`;

export const lightTheme = (accent = "#2563EB"): UiTheme => ({
  canvas: "#FAFAFA",
  panel: "#FFFFFF",
  raised: "#F4F4F5",
  line: "#E5E5E5",
  text: "#0A0A0A",
  muted: "#737373",
  faint: "#A3A3A3",
  accent,
  positive: "#16A34A",
  negative: "#DC2626",
});

export const themeFor = (tone: "dark" | "light", accent?: string): UiTheme =>
  tone === "dark" ? darkTheme(accent) : lightTheme(accent);

export const isPortrait = (width: number, height: number) => height > width * 1.15;

/** Arrival and exit eases from the craft rules; `curves.expoOut` is the same arrival curve. */
export const ease = {
  arrive: Easing.bezier(0.16, 1, 0.3, 1),
  exit: Easing.bezier(0.6, 0, 0.9, 0.35),
  state: Easing.bezier(0.65, 0, 0.35, 1),
};

/** Ground: a flat solid with a soft light from above. No vignette, no edge darkening, nothing moving behind landed UI. */
export const Stage: React.FC<{ ground?: string; light?: string; grain?: number; children?: React.ReactNode }> = ({
  ground = "#0A0A0A",
  light = "rgba(255,255,255,0.05)",
  grain = 0,
  children,
}) => (
  <AbsoluteFill style={{ backgroundColor: ground, fontFamily: uiFont }}>
    <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 60% at 50% 0%, ${light}, transparent 70%)` }} />
    {children}
    {grain > 0 ? <FilmGrain seed="ui-grain" opacity={grain} /> : null}
  </AbsoluteFill>
);

/** Fits a fixed-size design into a box by scale, keeping its own pixel coordinates. */
export const Fit: React.FC<{
  design: { width: number; height: number };
  width: number;
  height: number;
  cover?: boolean;
  children: React.ReactNode;
}> = ({ design, width, height, cover = false, children }) => {
  const scale = (cover ? Math.max : Math.min)(width / design.width, height / design.height);
  return (
    <div style={{ position: "relative", width, height, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: (width - design.width * scale) / 2,
          top: cover ? 0 : (height - design.height * scale) / 2,
          width: design.width,
          height: design.height,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
        }}
      >
        {children}
      </div>
    </div>
  );
};

/** Entrance used by every assembled element: rise, sharpen, fade. `p` is 0 to 1. */
export const Reveal: React.FC<{ p: number; dy?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({
  p,
  dy = 18,
  style,
  children,
}) => {
  const q = Math.max(0, Math.min(1, p));
  return (
    <div
      style={{
        opacity: q,
        transform: `translateY(${(1 - q) * dy}px) scale(${0.985 + 0.015 * q})`,
        filter: q < 0.999 ? `blur(${(1 - q) * 8}px)` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const ICONS: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z",
  chart: "M4 20V10m6 10V4m6 16v-7m4 7H2",
  users:
    "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7m10 8v-1.5a3.5 3.5 0 0 0-2.5-3.35M15.5 4.2a3.5 3.5 0 0 1 0 6.6",
  inbox: "M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6H3v-6z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6m7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14m10 3-5-5",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zm4 4h4",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  check: "M5 12.5 10 17 19 7",
  plus: "M12 5v14M5 12h14",
  card: "M3 6h18v12H3zM3 10h18",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  send: "M4 12 20 4l-6 16-3-7z",
  folder: "M3 6h6l2 2h10v11H3z",
  layers: "M12 3 2 8l10 5 10-5zM2 13l10 5 10-5",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4m8-4v4",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  lock: "M6 11h12v9H6zm2 0V8a4 4 0 0 1 8 0v3",
  shield: "M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4",
  chevron: "M6 9l6 6 6-6",
  up: "M12 19V5M6 11l6-6 6 6",
};

export type IconName = keyof typeof ICONS;

export const Icon: React.FC<{ name: string; size?: number; color?: string; stroke?: number; fill?: string }> = ({
  name,
  size = 18,
  color = "currentColor",
  stroke = 1.7,
  fill = "none",
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill}
    stroke={color}
    strokeWidth={stroke}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0, display: "block" }}
  >
    <path d={ICONS[name] ?? ICONS.sparkle} />
  </svg>
);

/** Small coloured disc with initials: avatar without a photo. */
export const Avatar: React.FC<{ initials: string; size?: number; hue?: number; tone?: "dark" | "light" }> = ({
  initials,
  size = 32,
  hue,
  tone = "dark",
}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: size,
      flexShrink: 0,
      background:
        hue === undefined ? ink(0.18, tone) : `linear-gradient(140deg, hsl(${hue} 70% 62%), hsl(${hue + 40} 65% 46%))`,
      color: hue === undefined ? ink(0.86, tone) : "white",
      fontSize: size * 0.38,
      fontWeight: 600,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      letterSpacing: -0.2,
      boxShadow: `inset 0 0 0 1px ${ink(0.12, tone)}`,
    }}
  >
    {initials}
  </div>
);

export const hueFor = (text: string) => Math.floor(random(`hue-${text}`) * 360);

/** Smooth seeded series: a believable growth curve with noise. */
export const series = (seed: string, count: number, trend = 0.6): number[] =>
  Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    const wave = Math.sin(t * 7 + random(`${seed}-p`) * 6) * 0.08 + Math.sin(t * 17) * 0.03;
    return 0.25 + t * trend * 0.6 + wave + (random(`${seed}-${i}`) - 0.5) * 0.06;
  });

const smoothPath = (points: { x: number; y: number }[]): string =>
  points.reduce((d, p, i, all) => {
    if (i === 0) return `M${p.x},${p.y}`;
    const prev = all[i - 1]!;
    const mx = (prev.x + p.x) / 2;
    return `${d} C${mx},${prev.y} ${mx},${p.y} ${p.x},${p.y}`;
  }, "");

/** Area chart drawn left to right by `draw` (0 to 1); line, soft fill and a live end dot. */
export const AreaChart: React.FC<{
  width: number;
  height: number;
  values: number[];
  color: string;
  draw?: number;
  grid?: string;
  id: string;
}> = ({ width, height, values, color, draw = 1, grid = "rgba(255,255,255,0.06)", id }) => {
  const max = Math.max(...values) * 1.08;
  const pts = values.map((v, i) => ({ x: (i / (values.length - 1)) * width, y: height - (v / max) * height }));
  const d = smoothPath(pts);
  const clipW = Math.max(0, Math.min(1, draw)) * width;
  const endIndex = Math.min(pts.length - 1, Math.floor(draw * (pts.length - 1)));
  const end = pts[endIndex]!;
  return (
    <svg width={width} height={height} style={{ overflow: "visible", display: "block" }}>
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.32} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <rect x={-4} y={-20} width={clipW + 4} height={height + 40} />
        </clipPath>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((g) => (
        <line key={g} x1={0} x2={width} y1={height * g} y2={height * g} stroke={grid} strokeDasharray="3 5" />
      ))}
      <g clipPath={`url(#${id}-clip)`}>
        <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#${id}-fill)`} />
        <path d={d} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      </g>
      {draw > 0.02 ? (
        <>
          <circle cx={end.x} cy={end.y} r={10} fill={color} opacity={0.18} />
          <circle cx={end.x} cy={end.y} r={4.5} fill={color} stroke="white" strokeWidth={1.5} />
        </>
      ) : null}
    </svg>
  );
};

export const Bars: React.FC<{
  width: number;
  height: number;
  values: number[];
  color: string;
  grow?: number;
  highlight?: number;
}> = ({ width, height, values, color, grow = 1, highlight = -1 }) => {
  const gap = 6;
  const bw = (width - gap * (values.length - 1)) / values.length;
  const max = Math.max(...values);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {values.map((v, i) => {
        const g = Math.max(0, Math.min(1, grow * 1.6 - (i / values.length) * 0.6));
        const h = (v / max) * height * g;
        return (
          <rect
            key={i}
            x={i * (bw + gap)}
            y={height - h}
            width={bw}
            height={h}
            rx={Math.min(4, bw / 2)}
            fill={color}
            opacity={i === highlight ? 1 : 0.38}
          />
        );
      })}
    </svg>
  );
};

export const Pill: React.FC<{
  text: string;
  tone: "positive" | "negative" | "neutral" | "accent";
  theme: UiTheme;
  size?: number;
}> = ({ text, tone, theme, size = 13 }) => {
  const c =
    tone === "positive"
      ? theme.positive
      : tone === "negative"
        ? theme.negative
        : tone === "accent"
          ? theme.accent
          : theme.muted;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: `${size * 0.22}px ${size * 0.65}px`,
        borderRadius: 999,
        fontSize: size,
        fontWeight: 500,
        color: c,
        background: `color-mix(in srgb, ${c} 12%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: size * 0.42, height: size * 0.42, borderRadius: 9, background: c }} />
      {text}
    </span>
  );
};

/** Order of the blocks in `DashboardScreen`; `reveal(index)` is called with these. */
export const DASHBOARD_PARTS = [
  "sidebar",
  "header",
  "kpi-0",
  "kpi-1",
  "kpi-2",
  "kpi-3",
  "chart",
  "side",
  "row-0",
  "row-1",
  "row-2",
  "row-3",
  "row-4",
] as const;

export type DashboardCopy = {
  product: string;
  title: string;
  kpis: { label: string; value: string; delta: string; up: boolean }[];
  rows: { name: string; company: string; status: "Paid" | "Pending" | "Refunded"; amount: string }[];
};

export const DEFAULT_DASHBOARD: DashboardCopy = {
  product: "Lumen",
  title: "Revenue overview",
  kpis: [
    { label: "Net revenue", value: "$284,120", delta: "+12.4%", up: true },
    { label: "Active accounts", value: "18,402", delta: "+3.1%", up: true },
    { label: "Conversion", value: "4.83%", delta: "+0.6pt", up: true },
    { label: "Churn", value: "1.24%", delta: "-0.3pt", up: false },
  ],
  rows: [
    { name: "Amelia Hart", company: "Fieldwork Studio", status: "Paid", amount: "$12,400.00" },
    { name: "Daniel Okafor", company: "Northgate Labs", status: "Pending", amount: "$8,250.00" },
    { name: "Sofia Lindqvist", company: "Bright Harbour", status: "Paid", amount: "$21,980.00" },
    { name: "Marcus Chen", company: "Ridgeline", status: "Refunded", amount: "$1,120.00" },
    { name: "Priya Raman", company: "Atlas Commerce", status: "Paid", amount: "$6,740.00" },
  ],
};

export const DASHBOARD_DESIGN = { width: 1360, height: 850 };

type DashboardProps = { theme: UiTheme; copy?: DashboardCopy; reveal?: (part: string) => number; chartDraw?: number };

/** A desktop analytics screen at 1360 x 850 design pixels (about 1.4x at 1080p, so 15 px body reads at 21 px). Wrap in `Fit` to place it. */
export const DashboardScreen: React.FC<DashboardProps> = ({
  theme,
  copy = DEFAULT_DASHBOARD,
  reveal = () => 1,
  chartDraw,
}) => {
  const t = theme;
  const nav = [
    ["home", "Overview"],
    ["chart", "Analytics"],
    ["users", "Customers"],
    ["card", "Payments"],
    ["inbox", "Inbox"],
    ["layers", "Products"],
    ["settings", "Settings"],
  ];
  const chartValues = series("dash-rev", 28, 0.9);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        background: t.canvas,
        color: t.text,
        fontFamily: uiFont,
        fontSize: 15,
      }}
    >
      <Reveal
        p={reveal("sidebar")}
        dy={0}
        style={{
          width: 216,
          borderRight: `1px solid ${t.line}`,
          background: t.panel,
          padding: "22px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 10px 22px" }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: t.text,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="bolt" size={16} color={t.canvas} fill={t.canvas} stroke={1} />
          </div>
          <span style={{ fontWeight: 650, fontSize: 17, letterSpacing: -0.3 }}>{copy.product}</span>
        </div>
        {nav.map(([icon, label], i) => (
          <div
            key={label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "9px 12px",
              borderRadius: 8,
              color: i === 0 ? t.text : t.muted,
              background: i === 0 ? t.raised : "transparent",
              fontWeight: i === 0 ? 550 : 450,
            }}
          >
            <Icon name={icon!} size={18} color={i === 0 ? t.text : t.muted} />
            {label}
          </div>
        ))}
        <div
          style={{
            marginTop: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 10,
            borderTop: `1px solid ${t.line}`,
          }}
        >
          <Avatar initials="EW" size={30} />
          <div style={{ lineHeight: 1.3 }}>
            <div style={{ fontWeight: 550, fontSize: 14 }}>Elena Weiss</div>
            <div style={{ color: t.faint, fontSize: 12.5 }}>Finance lead</div>
          </div>
        </div>
      </Reveal>
      <div style={{ flex: 1, padding: "20px 26px", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <Reveal p={reveal("header")} style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div>
            <div style={{ color: t.faint, fontSize: 13 }}>Workspace / Finance</div>
            <div style={{ fontSize: 26, fontWeight: 650, letterSpacing: -0.6, marginTop: 2 }}>{copy.title}</div>
          </div>
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "9px 14px",
              width: 220,
              borderRadius: 9,
              border: `1px solid ${t.line}`,
              background: t.panel,
              color: t.faint,
            }}
          >
            <Icon name="search" size={16} color={t.faint} />
            Search
            <span
              style={{
                marginLeft: "auto",
                fontSize: 12,
                border: `1px solid ${t.line}`,
                borderRadius: 5,
                padding: "1px 6px",
              }}
            >
              ⌘K
            </span>
          </div>
          <div
            style={{
              padding: "9px 16px",
              borderRadius: 9,
              background: t.text,
              color: t.canvas,
              fontWeight: 600,
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <Icon name="plus" size={16} color={t.canvas} />
            New report
          </div>
        </Reveal>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          {copy.kpis.slice(0, 4).map((k, i) => (
            <Reveal
              key={k.label}
              p={reveal(`kpi-${i}`)}
              style={{ background: t.panel, border: `1px solid ${t.line}`, borderRadius: 14, padding: "16px 18px" }}
            >
              <div style={{ color: t.muted, fontSize: 14 }}>{k.label}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 10 }}>
                <span
                  style={{ fontSize: 30, fontWeight: 650, letterSpacing: -0.8, fontVariantNumeric: "tabular-nums" }}
                >
                  {k.value}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: k.up ? t.positive : t.negative }}>{k.delta}</span>
              </div>
              <div style={{ marginTop: 12 }}>
                <Bars
                  width={212}
                  height={22}
                  values={series(`kpi-${i}`, 18, k.up ? 0.7 : -0.2)}
                  color={t.accent}
                  highlight={17}
                  grow={reveal(`kpi-${i}`)}
                />
              </div>
            </Reveal>
          ))}
        </div>
        <div style={{ display: "flex", gap: 16, height: 286 }}>
          <Reveal
            p={reveal("chart")}
            style={{
              flex: 2.1,
              background: t.panel,
              border: `1px solid ${t.line}`,
              borderRadius: 14,
              padding: "18px 22px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontWeight: 600, fontSize: 16 }}>Monthly recurring revenue</span>
              <span
                style={{
                  marginLeft: "auto",
                  display: "flex",
                  gap: 4,
                  background: t.raised,
                  borderRadius: 8,
                  padding: 3,
                  fontSize: 13,
                }}
              >
                {["7D", "30D", "90D", "1Y"].map((r) => (
                  <span
                    key={r}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      background: r === "90D" ? t.panel : "transparent",
                      color: r === "90D" ? t.text : t.muted,
                    }}
                  >
                    {r}
                  </span>
                ))}
              </span>
            </div>
            <div style={{ marginTop: 22 }}>
              <AreaChart
                id="dash-area"
                width={660}
                height={196}
                values={chartValues}
                color={t.accent}
                draw={chartDraw ?? reveal("chart")}
                grid={t.line}
              />
            </div>
          </Reveal>
          <Reveal
            p={reveal("side")}
            style={{
              flex: 1,
              background: t.panel,
              border: `1px solid ${t.line}`,
              borderRadius: 14,
              padding: "18px 22px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 16 }}>Top channels</span>
            {[
              ["Direct", 0.82, "$96.4k"],
              ["Partners", 0.61, "$71.2k"],
              ["Organic", 0.47, "$54.9k"],
              ["Paid social", 0.33, "$38.0k"],
              ["Email", 0.21, "$23.6k"],
            ].map(([label, share, value]) => (
              <div key={label as string}>
                <div style={{ display: "flex", fontSize: 14, color: t.muted }}>
                  <span>{label}</span>
                  <span style={{ marginLeft: "auto", color: t.text, fontVariantNumeric: "tabular-nums" }}>{value}</span>
                </div>
                <div style={{ height: 6, borderRadius: 6, background: t.raised, marginTop: 7 }}>
                  <div
                    style={{
                      height: 6,
                      borderRadius: 6,
                      width: `${(share as number) * 100 * Math.max(0, Math.min(1, reveal("side")))}%`,
                      background: t.accent,
                      opacity: 0.55,
                    }}
                  />
                </div>
              </div>
            ))}
          </Reveal>
        </div>
        <div style={{ background: t.panel, border: `1px solid ${t.line}`, borderRadius: 14, overflow: "hidden" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 2fr 1.2fr 1fr",
              padding: "12px 22px",
              color: t.faint,
              fontSize: 13,
              borderBottom: `1px solid ${t.line}`,
            }}
          >
            <span>Customer</span>
            <span>Company</span>
            <span>Status</span>
            <span style={{ textAlign: "right" }}>Amount</span>
          </div>
          {copy.rows.slice(0, 5).map((r, i) => (
            <Reveal
              key={r.name}
              p={reveal(`row-${i}`)}
              dy={10}
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 2fr 1.2fr 1fr",
                alignItems: "center",
                padding: "9px 22px",
                borderBottom: i < 4 ? `1px solid ${t.line}` : undefined,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 500 }}>
                <Avatar
                  initials={r.name
                    .split(" ")
                    .map((s) => s[0])
                    .join("")}
                  size={26}
                />
                {r.name}
              </span>
              <span style={{ color: t.muted }}>{r.company}</span>
              <span>
                <Pill
                  text={r.status}
                  tone={r.status === "Paid" ? "positive" : r.status === "Pending" ? "neutral" : "negative"}
                  theme={t}
                />
              </span>
              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
                {r.amount}
              </span>
            </Reveal>
          ))}
        </div>
      </div>
    </div>
  );
};

export const MOBILE_DESIGN = { width: 390, height: 844 };

/** A phone app screen at 390 x 844 design points: balance, chart, actions, activity. */
export const MobileScreen: React.FC<{ theme: UiTheme; reveal?: (part: string) => number; chartDraw?: number }> = ({
  theme: t,
  reveal = () => 1,
  chartDraw,
}) => {
  const activity = [
    ["Fieldwork Studio", "Invoice #2041", "+$12,400", true],
    ["Cloud hosting", "Subscription", "-$1,280", false],
    ["Bright Harbour", "Invoice #2039", "+$21,980", true],
    ["Office lease", "Monthly", "-$6,500", false],
  ] as const;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: t.canvas,
        color: t.text,
        fontFamily: uiFont,
        padding: "62px 20px 0",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <Reveal p={reveal("header")} style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Avatar initials="EW" size={36} />
        <div style={{ lineHeight: 1.25 }}>
          <div style={{ color: t.muted, fontSize: 13 }}>Good morning</div>
          <div style={{ fontWeight: 650, fontSize: 17 }}>Elena</div>
        </div>
        <div
          style={{
            marginLeft: "auto",
            width: 38,
            height: 38,
            borderRadius: 19,
            background: t.raised,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="bell" size={18} color={t.muted} />
        </div>
      </Reveal>
      <Reveal
        p={reveal("chart")}
        style={{ borderRadius: 22, padding: "18px 18px 12px", background: t.panel, border: `1px solid ${t.line}` }}
      >
        <div style={{ color: t.muted, fontSize: 13 }}>Total balance</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
          <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: -1, fontVariantNumeric: "tabular-nums" }}>
            $84,920.40
          </span>
        </div>
        <div style={{ color: t.muted, fontSize: 13, fontWeight: 600, marginTop: 2 }}>+$6,214.80 this month</div>
        <div style={{ marginTop: 14 }}>
          <AreaChart
            id="mob-area"
            width={318}
            height={96}
            values={series("mob", 20, 0.8)}
            color={t.accent}
            draw={chartDraw ?? reveal("chart")}
            grid="transparent"
          />
        </div>
      </Reveal>
      <Reveal p={reveal("kpi-0")} style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
        {[
          ["send", "Send"],
          ["plus", "Top up"],
          ["card", "Cards"],
          ["chart", "Insights"],
        ].map(([icon, label]) => (
          <div
            key={label}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 7,
              fontSize: 12.5,
              color: t.muted,
            }}
          >
            <div
              style={{
                width: 54,
                height: 54,
                borderRadius: 17,
                background: t.raised,
                border: `1px solid ${t.line}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name={icon!} size={21} color={t.text} />
            </div>
            {label}
          </div>
        ))}
      </Reveal>
      <Reveal p={reveal("side")} style={{ fontWeight: 600, fontSize: 16, display: "flex" }}>
        Activity
        <span style={{ marginLeft: "auto", color: t.muted, fontSize: 14, fontWeight: 500 }}>See all</span>
      </Reveal>
      {activity.map(([name, sub, amount, up], i) => (
        <Reveal key={name} p={reveal(`row-${i}`)} dy={10} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 42,
              height: 42,
              borderRadius: 13,
              background: t.raised,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name={up ? "arrow" : "card"} size={18} color={t.muted} />
          </div>
          <div style={{ lineHeight: 1.3 }}>
            <div style={{ fontWeight: 550, fontSize: 15 }}>{name}</div>
            <div style={{ color: t.faint, fontSize: 13 }}>{sub}</div>
          </div>
          <div
            style={{
              marginLeft: "auto",
              fontWeight: 600,
              fontSize: 15,
              color: t.text,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {amount}
          </div>
        </Reveal>
      ))}
      <Reveal
        p={reveal("header")}
        dy={0}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 84,
          borderTop: `1px solid ${t.line}`,
          background: t.panel,
          display: "flex",
          justifyContent: "space-around",
          paddingTop: 12,
        }}
      >
        {["home", "chart", "card", "settings"].map((icon, i) => (
          <Icon key={icon} name={icon} size={24} color={i === 0 ? t.text : t.faint} />
        ))}
      </Reveal>
    </div>
  );
};

/** Staggered reveal driver: part `i` of `order` starts at `start + i * step` and takes `dur` frames. */
export const useStagger = (
  order: readonly string[],
  start: number,
  step: number,
  dur: number,
  curve: (t: number) => number,
) => {
  const frame = useCurrentFrame();
  return (part: string) => {
    const i = order.indexOf(part);
    if (i < 0) return 1;
    const t = (frame - start - i * step) / dur;
    return t <= 0 ? 0 : t >= 1 ? 1 : curve(t);
  };
};

export const useFormat = () => {
  const { width, height } = useVideoConfig();
  return { width, height, portrait: isPortrait(width, height), square: Math.abs(width - height) < 10 };
};

/** Inner screen size of `DeviceFrame` for a given outer width. */
export const phoneScreen = (width: number, aspect = 19.5 / 9) => {
  const bezel = Math.round(width * 0.022);
  return { width: width - bezel * 2, height: width * aspect - bezel * 2 };
};

/** A soft light band that sweeps once across a screen. Put it last inside a clipped, rounded screen. */
export const Glare: React.FC<{ p: number; strength?: number; angle?: number }> = ({
  p,
  strength = 0.16,
  angle = 112,
}) => {
  const x = -60 + p * 220;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "screen" }}>
      <AbsoluteFill
        style={{ background: `linear-gradient(${angle}deg, rgba(255,255,255,0.07) 0%, transparent 38%)` }}
      />
      {p > 0 && p < 1 ? (
        <AbsoluteFill
          style={{
            background: `linear-gradient(${angle}deg, transparent ${x - 18}%, rgba(255,255,255,${strength * 0.5}) ${x - 6}%, rgba(255,255,255,${strength}) ${x}%, rgba(255,255,255,${strength * 0.5}) ${x + 4}%, transparent ${x + 16}%)`,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

/** Blurred floor shadow; render it as a sibling of a 3D-rotated object, never inside it. */
export const ContactShadow: React.FC<{ cx: number; cy: number; width: number; opacity?: number; spread?: number }> = ({
  cx,
  cy,
  width,
  opacity = 0.6,
  spread = 36,
}) => (
  <>
    <div
      style={{
        position: "absolute",
        left: cx - width / 2,
        top: cy - spread / 2,
        width,
        height: spread,
        borderRadius: "50%",
        background: `rgba(0,0,0,${opacity})`,
        filter: `blur(${spread}px)`,
      }}
    />
    <div
      style={{
        position: "absolute",
        left: cx - width * 0.32,
        top: cy - 6,
        width: width * 0.64,
        height: 12,
        borderRadius: "50%",
        background: `rgba(0,0,0,${opacity})`,
        filter: "blur(8px)",
      }}
    />
  </>
);
