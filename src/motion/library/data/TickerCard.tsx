import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { formatValue, labelFont, numberFont, smoothPath } from "./kit";
import {
  TICKER_PULL_FRAMES,
  TICKER_ROW_SCALE,
  TICKER_SWAP_MAX,
  TICKER_SWAP_MIN,
  neighbourBlur,
  tickerDrift,
  tickerIndexAt,
  tickerPull,
  tickerSeries,
  tickerSwaps,
} from "./ticker-plan";
import { intendedOverflow } from "../overflow";
import type { Cue } from "../types";

/**
 * ticker-card: one market card holds its place while its asset, price, change and line chart swap in place every
 * 6-12 frames; then a soft pull-back (sine.inOut, about 20 frames) shows it as one of a row of neighbours, blurred by
 * depth, the row sliding left. Pure numbers in ticker-plan.ts. Unbranded: the tickers are invented; a real product's
 * card is captured (`capture:app`), never drawn here.
 */

const assetSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  price: z.number(),
  /** Change in percent; its sign colours the line and the figure. */
  change: z.number(),
  /** Colour of the round mark behind the symbol's initials. */
  colour: z.string(),
});
export type TickerAsset = z.infer<typeof assetSchema>;

export const tickerCardSchema = z.object({
  /** Assets the centre card cycles through, in order; it rests on the last. */
  assets: z.array(assetSchema).min(1),
  /** Cards of the row either side of the centre card, revealed by the pull-back (left ones first). */
  neighbours: z.array(assetSchema),
  /** Frame the first asset shows. */
  at: z.number().int().min(0),
  /** Shortest and longest hold of one asset, in frames (polymarket: 6-12). */
  swapMin: z.number().int().min(1),
  swapMax: z.number().int().min(1),
  seed: z.string(),
  /** Frame the pull-back starts; -1 holds the single card. */
  pullAt: z.number().int().min(-1),
  pullFrames: z.number().int().min(4).max(60),
  /** Card scale once pulled back (polymarket: about 0.72). */
  rowScale: z.number().min(0.3).max(1),
  /** Row slide in widths a second after the pull starts. */
  drift: z.number().min(0).max(0.3),
  /** Depth-of-field blur of the nearest neighbour in px at 1080. */
  blur: z.number().min(0).max(30),
  locale: z.string(),
  currency: z.string(),
  /** `light` and `dark` paint a ground; `transparent` lays the card over any layer. */
  ground: z.enum(["light", "dark", "transparent"]),
});

export type TickerCardProps = z.infer<typeof tickerCardSchema>;

export const tickerCardSwaps = (p: Pick<TickerCardProps, "assets" | "at" | "swapMin" | "swapMax" | "seed">): number[] =>
  tickerSwaps(p.assets.length, p.at, { min: p.swapMin, max: Math.max(p.swapMin, p.swapMax), seed: p.seed });

/** A tick on every swap, the pull-back as the hero reveal. */
export const tickerCardCues = (p: TickerCardProps): Cue[] => [
  { frame: p.at, kind: "reveal", sfx: "none", weight: "support", label: "first asset" },
  ...tickerCardSwaps(p).map((frame): Cue => ({
    frame,
    kind: "cut",
    sfx: "tick",
    weight: "support",
    label: "asset swaps",
  })),
  ...(p.pullAt >= 0
    ? [{ frame: p.pullAt, kind: "reveal", sfx: "whoosh", weight: "hero", label: "pull back to the row" } satisfies Cue]
    : []),
];

const PALETTE = {
  light: {
    ground: "#F2F2F1",
    card: "#FFFFFF",
    ink: "#15171A",
    muted: "#8A8F98",
    line: "rgba(21,23,26,0.08)",
    shadow: "0 18px 50px rgba(20,24,30,0.10)",
  },
  dark: {
    ground: "#0B0C0E",
    card: "#16181C",
    ink: "#F3F4F6",
    muted: "#8A8F98",
    line: "rgba(255,255,255,0.10)",
    shadow: "0 18px 50px rgba(0,0,0,0.5)",
  },
};
const UP = "#16A34A";
const DOWN = "#DC2626";

const Card: React.FC<{
  asset: TickerAsset;
  w: number;
  tone: "light" | "dark";
  seed: string;
  locale: string;
  currency: string;
}> = ({ asset, w, tone, seed, locale, currency }) => {
  const c = PALETTE[tone];
  const h = w * 0.66;
  const k = w / 700;
  const pad = 34 * k;
  const up = asset.change >= 0;
  const colour = up ? UP : DOWN;
  const series = tickerSeries(`${seed}-${asset.symbol}`, asset.change);
  const cw = w - pad * 2;
  const ch = h * 0.34;
  const pts = series.map((v, i) => ({ x: (i / (series.length - 1)) * cw, y: ch * (1 - v) * 0.9 + ch * 0.05 }));
  const line = smoothPath(pts);
  const id = `tk-${asset.symbol}-${tone}`;
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: 26 * k,
        background: c.card,
        boxShadow: c.shadow,
        border: `1px solid ${c.line}`,
        position: "relative",
        boxSizing: "border-box",
        padding: pad,
        fontFamily: labelFont,
        color: c.ink,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 * k }}>
        <div
          style={{
            width: 62 * k,
            height: 62 * k,
            borderRadius: 16 * k,
            background: asset.colour,
            color: "#FFFFFF",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 700,
            fontSize: 24 * k,
          }}
        >
          {asset.symbol.slice(0, 2)}
        </div>
        <div style={{ lineHeight: 1.15 }}>
          <div style={{ fontWeight: 700, fontSize: 30 * k }}>{asset.symbol}</div>
          <div style={{ fontSize: 23 * k, color: c.muted }}>{asset.name}</div>
        </div>
        <svg width={34 * k} height={34 * k} viewBox="0 0 24 24" style={{ marginLeft: "auto" }}>
          <path
            d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z"
            fill="none"
            stroke={c.muted}
            strokeWidth={1.6}
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <svg width={cw} height={ch} style={{ position: "absolute", left: pad, top: h * 0.3, overflow: "visible" }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={colour} stopOpacity={0.22} />
            <stop offset="1" stopColor={colour} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={`${line} L ${cw} ${ch} L 0 ${ch} Z`} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke={colour} strokeWidth={4 * k} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div
        style={{
          position: "absolute",
          left: pad,
          right: pad,
          bottom: pad,
          display: "flex",
          alignItems: "baseline",
          gap: 14 * k,
        }}
      >
        <div
          style={{
            fontFamily: numberFont,
            fontWeight: 700,
            fontSize: 40 * k,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: "-0.01em",
          }}
        >
          {formatValue(asset.price, { locale, decimals: 2, prefix: currency, suffix: "" })}
        </div>
        <div style={{ fontWeight: 600, fontSize: 24 * k, color: colour, fontVariantNumeric: "tabular-nums" }}>
          {up ? "+" : "−"}
          {formatValue(Math.abs(asset.change), { locale, decimals: 2, prefix: "", suffix: "%" })}
        </div>
        <div style={{ marginLeft: "auto", fontSize: 22 * k, color: c.muted }}>1D</div>
      </div>
    </div>
  );
};

/** One card swaps asset, price and line in place, then pulls back to a row of neighbours. */
export const TickerCard: React.FC<TickerCardProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const vertical = height > width;
  const tone = p.ground === "dark" ? "dark" : "light";
  const swaps = tickerCardSwaps(p);
  const shown = p.assets[Math.min(tickerIndexAt(frame, swaps), p.assets.length - 1)]!;
  const { p: pull, scale } = tickerPull(frame, p.pullAt, p.pullFrames, p.rowScale);
  const drift = tickerDrift(frame, p.pullAt, p.drift, fps) * width;
  const w = (vertical ? 0.62 : 0.37) * width;
  // polymarket: cards about 0.2 W apart by 0.07 W in the row, so the gap is about a third of a card.
  const gap = w * (vertical ? 0.1 : 0.32); // vertical: tighter, so half of each neighbour shows in the narrow frame
  const u = Math.min(width, height) / 1080;
  const half = Math.ceil(p.neighbours.length / 2);
  // Left neighbours take the first half of the list (nearest first), right the rest.
  const row = [
    ...p.neighbours.slice(0, half).map((asset, i) => ({ asset, slot: -(i + 1) })),
    { asset: shown, slot: 0 },
    ...p.neighbours.slice(half).map((asset, i) => ({ asset, slot: i + 1 })),
  ];
  const content = (
    <AbsoluteFill style={{ transform: `translateX(${drift}px) scale(${scale})`, transformOrigin: "50% 50%" }}>
      {row.map(({ asset, slot }) => {
        const centre = slot === 0;
        if (!centre && pull <= 0) return null;
        const blur = centre ? 0 : neighbourBlur(slot, pull, p.blur * u) / Math.max(scale, 0.01);
        return (
          <div
            key={`${slot}-${asset.symbol}`}
            {...intendedOverflow(!centre, "the row of neighbour cards runs past the frame edges by design")}
            style={{
              position: "absolute",
              left: width / 2 - w / 2 + slot * (w + gap),
              top: height / 2 - (w * 0.66) / 2,
              opacity: centre ? 1 : Math.min(1, pull * 1.6),
              filter: blur > 0.2 ? `blur(${blur}px)` : undefined,
            }}
          >
            <Card asset={asset} w={w} tone={tone} seed={p.seed} locale={p.locale} currency={p.currency} />
          </div>
        );
      })}
    </AbsoluteFill>
  );
  return p.ground === "transparent" ? (
    <AbsoluteFill>{content}</AbsoluteFill>
  ) : (
    <AbsoluteFill style={{ backgroundColor: PALETTE[tone].ground, overflow: "hidden" }}>{content}</AbsoluteFill>
  );
};

const A = (symbol: string, name: string, price: number, change: number, colour: string): TickerAsset => ({
  symbol,
  name,
  price,
  change,
  colour,
});

export const TICKER_CARD_FRAMES = 120;

export const tickerCardDefaults: TickerCardProps = {
  assets: [
    A("NOVA", "Nova Labs", 138.75, -3.57, "#111827"),
    A("KELP", "Kelp Energy", 42.1, 1.84, "#0F766E"),
    A("ORBT", "Orbit Freight", 1792.8, -0.67, "#7C3AED"),
    A("MIRA", "Mira Health", 86.42, 2.31, "#DB2777"),
    A("VOLT", "Volt Grid", 311.05, 0.92, "#F59E0B"),
    A("TIDE", "Tide Water", 57.3, -1.12, "#2563EB"),
    A("ARCO", "Arco Robotics", 1792.8, 4.05, "#111827"),
  ],
  neighbours: [
    A("LUMA", "Luma Optics", 91.29, 2.12, "#059669"),
    A("FERN", "Fern Foods", 7632.8, -1.02, "#E11D48"),
    A("QUILL", "Quill Paper", 24.6, 0.4, "#475569"),
    A("BRIO", "Brio Motors", 412.7, 3.3, "#EA580C"),
  ],
  at: 0,
  swapMin: TICKER_SWAP_MIN,
  swapMax: TICKER_SWAP_MAX,
  seed: "ticker",
  pullAt: 54,
  pullFrames: TICKER_PULL_FRAMES,
  rowScale: TICKER_ROW_SCALE,
  drift: 0.02,
  blur: 10,
  locale: "en-US",
  currency: "$",
  ground: "light",
};
