import React from "react";
import { AbsoluteFill, Easing, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { typedCount, typingSchedule } from "../../kinetic-math";
import { curves, progress, type Curve } from "../../timing";
import { Icon } from "./kit";

/**
 * The real-UI kit: shadcn/ui "new-york" neutral tokens (MIT, https://ui.shadcn.com, pulled with `shadcn add` into
 * ui-sources/ and ported to frame time) at reading scale. Sizes are design pixels for a 1080 px short side, so body
 * text is 26-30 px (about 2.6% of frame height in landscape), never the 1.2% of a page-sized screenshot.
 */

import { geist, geistMono } from "./fonts";

export { geist, geistMono };

export type Tone = "light" | "dark";

export type Surface = {
  tone: Tone;
  ground: string;
  background: string;
  card: string;
  muted: string;
  hover: string;
  border: string;
  input: string;
  text: string;
  mutedText: string;
  faintText: string;
  primary: string;
  primaryText: string;
  accent: string;
  accentSoft: string;
  positive: string;
  shadow: { xs: string; md: string; lg: string; window: string };
};

const alpha = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const n = Number.parseInt(h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export const surface = (tone: Tone, accent = "#2563EB"): Surface =>
  tone === "light"
    ? {
        tone,
        ground: "#EEF0F3",
        background: "#FFFFFF",
        card: "#FFFFFF",
        muted: "#F5F5F5",
        hover: "#F4F4F5",
        border: "#E5E5E5",
        input: "#E4E4E7",
        text: "#0A0A0A",
        mutedText: "#737373",
        faintText: "#A3A3A3",
        primary: "#171717",
        primaryText: "#FAFAFA",
        accent,
        accentSoft: alpha(accent, 0.09),
        positive: "#16A34A",
        shadow: {
          xs: "0 1px 2px rgba(0,0,0,0.05)",
          md: "0 1px 2px rgba(0,0,0,0.04), 0 4px 12px -2px rgba(0,0,0,0.08)",
          lg: "0 1px 3px rgba(0,0,0,0.05), 0 12px 32px -8px rgba(0,0,0,0.14), 0 32px 64px -24px rgba(0,0,0,0.12)",
          window:
            "0 0 0 1px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04), 0 24px 48px -12px rgba(16,24,40,0.18), 0 64px 120px -40px rgba(16,24,40,0.22)",
        },
      }
    : {
        tone,
        ground: "#08080A",
        background: "#0A0A0A",
        card: "#141416",
        muted: "#1C1C1F",
        hover: "#1F1F23",
        border: "rgba(255,255,255,0.1)",
        input: "rgba(255,255,255,0.15)",
        text: "#FAFAFA",
        mutedText: "#A1A1AA",
        faintText: "#71717A",
        primary: "#FAFAFA",
        primaryText: "#18181B",
        accent,
        accentSoft: alpha(accent, 0.16),
        positive: "#22C55E",
        shadow: {
          xs: "0 1px 2px rgba(0,0,0,0.4)",
          md: "0 1px 2px rgba(0,0,0,0.4), 0 6px 16px -4px rgba(0,0,0,0.5)",
          lg: "0 0 0 1px rgba(255,255,255,0.04), 0 16px 40px -8px rgba(0,0,0,0.6), 0 40px 80px -24px rgba(0,0,0,0.6)",
          window:
            "inset 0 1px 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(0,0,0,0.6), 0 32px 64px -16px rgba(0,0,0,0.7), 0 80px 140px -40px rgba(0,0,0,0.8)",
        },
      };

/** Format geometry: `u` scales design pixels so a 1080 px short side is 1. */
export const useUnit = () => {
  const { width, height } = useVideoConfig();
  const portrait = height > width * 1.15;
  return { width, height, portrait, u: Math.min(width, height) / 1080 };
};

/** Flat, quiet ground with one soft light from above. Nothing moves behind landed UI. */
export const Ground: React.FC<{ s: Surface; children?: React.ReactNode }> = ({ s, children }) => (
  <AbsoluteFill
    style={{ backgroundColor: s.ground, fontFamily: geist, color: s.text, fontFeatureSettings: '"ss01", "cv11"' }}
  >
    <AbsoluteFill
      style={{
        background:
          s.tone === "light"
            ? "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(255,255,255,0.9), transparent 70%)"
            : "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(255,255,255,0.05), transparent 70%)",
      }}
    />
    {children}
  </AbsoluteFill>
);

/** An app window: hairline border, layered shadow, macOS lights and an optional centred title or tab pair. */
export const Window: React.FC<{
  s: Surface;
  width: number;
  height: number;
  title?: string;
  tabs?: string[];
  activeTab?: number;
  radius?: number;
  bar?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ s, width, height, title, tabs, activeTab = 0, radius = 22, bar = true, style, children }) => (
  <div
    style={{
      position: "absolute",
      width,
      height,
      borderRadius: radius,
      background: s.background,
      boxShadow: s.shadow.window,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      ...style,
    }}
  >
    {bar ? (
      <div
        style={{
          height: 64,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          borderBottom: `1px solid ${s.border}`,
          position: "relative",
        }}
      >
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <div
            key={c}
            style={{
              width: 15,
              height: 15,
              borderRadius: 15,
              background: c,
              marginRight: 10,
              boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.15)",
            }}
          />
        ))}
        {tabs ? (
          <div
            style={{
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              padding: 4,
              borderRadius: 12,
              background: s.muted,
              gap: 2,
            }}
          >
            {tabs.map((t, i) => (
              <div
                key={t}
                style={{
                  padding: "7px 26px",
                  borderRadius: 9,
                  fontSize: 21,
                  fontWeight: 500,
                  color: i === activeTab ? s.text : s.mutedText,
                  background: i === activeTab ? s.card : "transparent",
                  boxShadow: i === activeTab ? s.shadow.xs : undefined,
                }}
              >
                {t}
              </div>
            ))}
          </div>
        ) : title ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              textAlign: "center",
              fontSize: 21,
              fontWeight: 500,
              color: s.mutedText,
            }}
          >
            {title}
          </div>
        ) : null}
      </div>
    ) : null}
    <div style={{ flex: 1, position: "relative", minHeight: 0 }}>{children}</div>
  </div>
);

/** Text caret: solid while typing, blinks on a 16-frame period at rest. */
export const Caret: React.FC<{ frame: number; lastKey: number; color: string; height: number; width?: number }> = ({
  frame,
  lastKey,
  color,
  height,
  width = 3,
}) => {
  const on = frame - lastKey < 10 || Math.floor((frame - lastKey) / 16) % 2 === 0;
  return (
    <span
      style={{
        display: "inline-block",
        width,
        height,
        background: color,
        opacity: on ? 1 : 0,
        marginLeft: 2,
        verticalAlign: "middle",
        borderRadius: 1,
        transform: "translateY(-0.06em)",
      }}
    />
  );
};

/** Human-rhythm typing: visible text, the frame of the last key and the frame typing ends. */
export const useTyping = (text: string, at: number, pace: number, seed: string) => {
  const frame = useCurrentFrame();
  const schedule = typingSchedule(text, { at, pace, seed });
  const count = typedCount(frame, schedule);
  return {
    shown: text.slice(0, count),
    lastKey: count > 0 ? schedule[count - 1]! : at,
    done: schedule.length ? schedule[schedule.length - 1]! : at,
    count,
    total: text.length,
  };
};

export const typingEnd = (text: string, at: number, pace: number, seed: string): number => {
  const schedule = typingSchedule(text, { at, pace, seed });
  return schedule.length ? schedule[schedule.length - 1]! : at;
};

/** Words of `text` revealed from `at` at `wordsPerFrame`, with the newest word fading in. */
export const streamWords = (text: string, frame: number, at: number, wordsPerFrame: number) => {
  const words = text.split(/(\s+)/);
  const visible = Math.max(0, (frame - at) * wordsPerFrame);
  let index = 0;
  return words.map((w, i) => {
    if (/^\s+$/.test(w)) return { w, o: index - 1 < visible ? 1 : 0, key: i };
    const o = Math.max(0, Math.min(1, visible - index));
    index += 1;
    return { w, o, key: i };
  });
};

export const streamEnd = (text: string, at: number, wordsPerFrame: number) =>
  at + Math.ceil(text.split(/\s+/).filter(Boolean).length / wordsPerFrame);

export const Badge: React.FC<{
  s: Surface;
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "positive";
  size?: number;
}> = ({ s, children, tone = "neutral", size = 19 }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: `${size * 0.22}px ${size * 0.6}px`,
      borderRadius: 999,
      fontSize: size,
      fontWeight: 500,
      lineHeight: 1.2,
      color: tone === "accent" ? s.accent : tone === "positive" ? s.positive : s.mutedText,
      background:
        tone === "accent"
          ? s.accentSoft
          : tone === "positive"
            ? s.tone === "light"
              ? "rgba(22,163,74,0.1)"
              : "rgba(34,197,94,0.14)"
            : s.muted,
      border: `1px solid ${tone === "neutral" ? s.border : "transparent"}`,
    }}
  >
    {children}
  </span>
);

export const Kbd: React.FC<{ s: Surface; children: React.ReactNode; size?: number }> = ({ s, children, size = 18 }) => (
  <span
    style={{
      fontFamily: geist,
      fontSize: size,
      fontWeight: 500,
      color: s.mutedText,
      padding: "2px 8px",
      borderRadius: 6,
      border: `1px solid ${s.border}`,
      background: s.muted,
      boxShadow: s.shadow.xs,
    }}
  >
    {children}
  </span>
);

/** shadcn Switch, thumb and track driven by `on` from 0 to 1. */
export const Toggle: React.FC<{ s: Surface; on: number; scale?: number }> = ({ s, on, scale = 1 }) => {
  const w = 64 * scale;
  const h = 36 * scale;
  const d = h - 6 * scale;
  return (
    <div
      style={{
        position: "relative",
        width: w,
        height: h,
        borderRadius: h,
        flexShrink: 0,
        background: on > 0.5 ? s.accent : s.input,
        boxShadow: s.shadow.xs,
      }}
    >
      <div style={{ position: "absolute", inset: 0, borderRadius: h, background: s.accent, opacity: on }} />
      <div
        style={{
          position: "absolute",
          top: 3 * scale,
          left: 3 * scale + on * (w - d - 6 * scale),
          width: d,
          height: d,
          borderRadius: d,
          background: "#FFFFFF",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2), 0 1px 1px rgba(0,0,0,0.06)",
        }}
      />
    </div>
  );
};

/** Ring spinner that turns on frame time and resolves into a check at `doneAt`. */
export const Status: React.FC<{ s: Surface; frame: number; doneAt: number; size?: number }> = ({
  s,
  frame,
  doneAt,
  size = 26,
}) => {
  const done = progress(frame, doneAt, 8, "overshoot");
  if (frame >= doneAt)
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size,
          background: s.positive,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${0.6 + 0.4 * done})`,
          flexShrink: 0,
        }}
      >
        <Icon name="check" size={size * 0.62} color="#FFFFFF" stroke={3} />
      </div>
    );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ transform: `rotate(${frame * 18}deg)`, flexShrink: 0 }}
    >
      <circle cx={12} cy={12} r={9} fill="none" stroke={s.border} strokeWidth={3} />
      <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke={s.mutedText} strokeWidth={3} strokeLinecap="round" />
    </svg>
  );
};

/** Pointer arrow with a press dip at `pressAt`. Coordinates are its tip. */
export const Pointer: React.FC<{ x: number; y: number; frame: number; pressAt?: number; size?: number }> = ({
  x,
  y,
  frame,
  pressAt = -99,
  size = 44,
}) => {
  const dip = frame >= pressAt && frame < pressAt + 6 ? 0.86 : 1;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{
        position: "absolute",
        left: x - size * 0.2,
        top: y - size * 0.1,
        transform: `scale(${dip})`,
        transformOrigin: "20% 10%",
        filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.3))",
        zIndex: 50,
      }}
    >
      <path
        d="M5 2.5v17.2l4.6-4.4 2.9 6.6 3-1.3-2.9-6.5h6.3z"
        fill="#0A0A0A"
        stroke="#FFFFFF"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
};

/** Expanding ring at a click point. */
export const ClickRing: React.FC<{ x: number; y: number; frame: number; at: number; color: string }> = ({
  x,
  y,
  frame,
  at,
  color,
}) => {
  const p = progress(frame, at, 14, "expoOut");
  if (frame < at || p >= 1) return null;
  const r = 14 + p * 40;
  return (
    <div
      style={{
        position: "absolute",
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: r * 2,
        border: `3px solid ${color}`,
        opacity: 1 - p,
        zIndex: 49,
      }}
    />
  );
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** Easings a scroll can take: "snap" leaves hard and lands soft, "inOut" is symmetric, "expoOut" is a flick, "power2Out" streams and settles (GSAP power2.out). */
export const SCROLL_EASES = {
  inOut: curves.inOut,
  snap: Easing.bezier(0.6, 0, 0.25, 1),
  expoOut: curves.expoOut,
  expoIn: curves.expoIn,
  drift: curves.drift,
  linear: curves.linear,
  power2Out: (t: number) => 1 - (1 - t) ** 3,
} satisfies Record<string, Curve>;
export const scrollEaseSchema = z.enum(["inOut", "snap", "expoOut", "expoIn", "drift", "linear", "power2Out"]);

/** A camera push into the frame: from `at` over `frames` it scales toward the point (x, y), shares of the frame, accelerating. */
export const pushSchema = z.object({
  at: z.number().int(),
  frames: z.number().int().min(1),
  scale: z.number().min(1).max(3),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type Push = z.infer<typeof pushSchema>;

export const pushStyle = (frame: number, push?: Push): React.CSSProperties =>
  push
    ? {
        transform: `scale(${1 + (push.scale - 1) * progress(frame, push.at, push.frames, "expoIn")})`,
        transformOrigin: `${push.x * 100}% ${push.y * 100}%`,
      }
    : {};
