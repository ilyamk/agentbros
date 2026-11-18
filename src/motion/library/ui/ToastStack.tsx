import React from "react";
import { z } from "zod";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { DASHBOARD_DESIGN, DashboardScreen, Fit, Icon, Stage, themeFor, uiFont, useFormat } from "./kit";
import { surface } from "./surface";

export const toastStackSchema = z.object({
  toasts: z.array(
    z.object({ app: z.string(), title: z.string(), body: z.string(), icon: z.string(), time: z.string() }),
  ),
  /** Marks exactly one element: the icon of the toast at `accentIndex`. */
  accent: z.string(),
  /** Which toast's icon takes the accent; 0 is the first to arrive. */
  accentIndex: z.number().int().min(0).optional(),
  /** Frame the first toast arrives. */
  start: z.number().int().min(0),
  /** Frames between arrivals. */
  gap: z.number().int().min(4),
  /** "list" pushes older toasts down; "stack" tucks them behind the newest. */
  mode: z.enum(["list", "stack"]),
  /** What sits behind: a dimmed app screen (landscape) or lock screen (vertical), or only the lit ground. */
  context: z.enum(["screen", "none"]),
  clock: z.string(),
  date: z.string(),
  /** Light or dark; defaults to light. */
  tone: z.enum(["light", "dark"]).optional(),
  /** Multiplies the toasts' size, 1 by default (body 32 px at 1080 wide in vertical). Above about 1.05 in vertical the cards keep the frame's width and lines truncate sooner. */
  textScale: z.number().min(0.7).max(1.8).optional(),
});

export type ToastStackProps = z.infer<typeof toastStackSchema>;

const BASE_W = 600;
const H = 136;
const GAP = 14;

/** Notifications slide in one after another; each arrival springs the older ones down or tucks them behind. */
export const ToastStack: React.FC<ToastStackProps> = ({
  toasts,
  accent,
  accentIndex = 0,
  start,
  gap,
  mode,
  context,
  clock,
  date,
  tone = "light",
  textScale = 1,
}) => {
  const ui = surface(tone, accent);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, portrait } = useFormat();
  const arrivals = toasts.map((_, i) => start + i * gap);
  const s = (portrait ? 1.45 : (width * 0.38) / BASE_W) * textScale;
  const W = Math.min(BASE_W, (width * 0.94) / s);
  const left = portrait ? (width - W * s) / 2 : width - W * s - width * 0.04;
  const top = portrait ? 450 : height * 0.07;

  return (
    <Stage ground={ui.ground}>
      {context === "screen" && !portrait ? (
        <AbsoluteFill style={{ opacity: tone === "light" ? 0.75 : 0.45, filter: "blur(4px)" }}>
          <Fit design={DASHBOARD_DESIGN} width={width} height={height} cover>
            <DashboardScreen theme={themeFor(tone, accent)} />
          </Fit>
        </AbsoluteFill>
      ) : null}
      {context === "screen" && portrait ? (
        <div
          style={{
            position: "absolute",
            top: 168,
            width: "100%",
            textAlign: "center",
            fontFamily: uiFont,
            color: ui.text,
          }}
        >
          <div style={{ fontSize: 40, fontWeight: 500, opacity: 0.8 }}>{date}</div>
          <div style={{ fontSize: 200, fontWeight: 650, letterSpacing: "-0.04em", lineHeight: 1 }}>{clock}</div>
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left,
          top,
          width: W,
          transform: `scale(${s})`,
          transformOrigin: "0 0",
          fontFamily: uiFont,
        }}
      >
        {toasts.map((t, i) => {
          const at = arrivals[i]!;
          if (frame < at) return null;
          const enter = spring({
            frame: frame - at,
            fps,
            config: { damping: 18, stiffness: 200, mass: 1, overshootClamping: true },
          });
          const depth = arrivals.slice(i + 1).reduce(
            (sum, a) =>
              sum +
              spring({
                frame: frame - a,
                fps,
                config: { damping: 14, stiffness: 140, mass: 0.8, overshootClamping: true },
              }),
            0,
          );
          const y = mode === "list" ? depth * (H + GAP) : depth * 16;
          const scale = mode === "list" ? 1 : 1 - depth * 0.05;
          const fade = mode === "list" ? Math.max(0, Math.min(1, 4 - depth)) : Math.max(0, 1 - depth * 0.28);
          const x = portrait ? 0 : (1 - enter) * (W + 80);
          const dy = portrait ? (1 - enter) * -140 : 0;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: W,
                height: H,
                zIndex: 100 - Math.round(depth * 10),
                transform: `translate(${x}px, ${y + dy}px) scale(${scale * (portrait ? 0.92 + 0.08 * enter : 1)})`,
                transformOrigin: "50% 0",
                opacity: fade * Math.min(1, enter * 1.4),
                borderRadius: 26,
                padding: "18px 20px",
                display: "flex",
                gap: 16,
                background: tone === "light" ? "rgba(255,255,255,0.92)" : "rgba(28,28,31,0.94)",
                border: `1px solid ${ui.border}`,
                boxShadow: ui.shadow.lg,
                color: ui.text,
              }}
            >
              <div
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: 14,
                  flexShrink: 0,
                  background: i === accentIndex ? accent : ui.muted,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name={t.icon} size={26} color={i === accentIndex ? "white" : ui.text} stroke={2} />
              </div>
              <div style={{ flex: 1, minWidth: 0, lineHeight: 1.3 }}>
                <div style={{ display: "flex", fontSize: 19, color: ui.mutedText, fontWeight: 500 }}>
                  {t.app}
                  <span style={{ marginLeft: "auto" }}>{t.time}</span>
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 600,
                    marginTop: 2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.title}
                </div>
                <div
                  style={{
                    fontSize: 22,
                    color: ui.mutedText,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.body}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Stage>
  );
};
