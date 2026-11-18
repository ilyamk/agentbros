import React from "react";
import { z } from "zod";
import { useCurrentFrame } from "remotion";
import { progress } from "../../timing";
import { Avatar, hueFor, Icon } from "./kit";
import { Badge, Ground, initials, surface, useUnit, Window } from "./surface";

const messageSchema = z.object({
  from: z.string(),
  subject: z.string(),
  preview: z.string(),
  time: z.string(),
  tag: z.string(),
});

export const appWindowSchema = z.object({
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  product: z.string(),
  nav: z.array(z.object({ icon: z.string(), label: z.string(), count: z.number().int().min(0) })).min(2),
  /** Sidebar item selected at the start and the one the selection moves to. */
  from: z.number().int().min(0),
  to: z.number().int().min(0),
  heading: z.string(),
  /** Messages already in the inbox, newest first. */
  messages: z.array(messageSchema).min(1),
  /** Messages that arrive at the top one after another. */
  arrivals: z.array(messageSchema),
  switchAt: z.number().int().min(0),
  arriveAt: z.number().int().min(0),
  gap: z.number().int().min(4),
});

export type AppWindowProps = z.infer<typeof appWindowSchema>;

export const appWindowCues = (p: AppWindowProps) => [
  { frame: 0, kind: "reveal" as const, sfx: "none" as const, weight: "support" as const, label: "window lands" },
  {
    frame: p.switchAt,
    kind: "click" as const,
    sfx: "click" as const,
    weight: "support" as const,
    label: "sidebar selection",
  },
  ...p.arrivals.map((_, i) => ({
    frame: p.arriveAt + i * p.gap,
    kind: "reveal" as const,
    sfx: "pop" as const,
    weight: (i === 0 ? "hero" : "support") as "hero" | "support",
    label: `message ${i + 1} arrives`,
  })),
];

const ROW = 128;

/** A full app window with a real sidebar: the selection slides to Inbox, the list swaps in and new messages push in at the top with unread dots. */
export const AppWindow: React.FC<AppWindowProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, portrait, u } = useUnit();
  const s = surface(p.tone, p.accent);
  const W = width / u;
  const H = height / u;
  const winW = portrait ? W - 40 : W - 120;
  const winH = portrait ? H - 200 : H - 90;
  const side = portrait ? 0 : 340;
  const rise = progress(frame, 0, 18, "expoOut");
  const sw = progress(frame, p.switchAt, 12, "inOut");
  const navY = (i: number) => 92 + i * 64;
  const selY = navY(p.from) + (navY(p.to) - navY(p.from)) * sw;
  const pushed = p.arrivals.reduce((sum, _, i) => sum + progress(frame, p.arriveAt + i * p.gap, 14, "expoOut"), 0);
  const list = [...p.arrivals].reverse().concat(p.messages);
  const swapIn = progress(frame, p.switchAt + 4, 14, "expoOut");
  const unread = p.nav[p.to]!.count + p.arrivals.filter((_, i) => frame >= p.arriveAt + i * p.gap).length;

  return (
    <Ground s={s}>
      <div style={{ position: "absolute", inset: 0, transform: `scale(${u})`, transformOrigin: "0 0" }}>
        <Window
          s={s}
          width={winW}
          height={winH}
          title={p.product}
          style={{ left: (W - winW) / 2, top: (H - winH) / 2 + (1 - rise) * 40, opacity: rise }}
        >
          {side ? (
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: side,
                borderRight: `1px solid ${s.border}`,
                background: s.tone === "light" ? "#FAFAFA" : "#0E0E10",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "26px 28px",
                  fontSize: 28,
                  fontWeight: 600,
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 11,
                    background: s.primary,
                    color: s.primaryText,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 22,
                  }}
                >
                  {p.product[0]}
                </div>
                {p.product}
              </div>
              <div
                style={{
                  position: "absolute",
                  left: 14,
                  right: 14,
                  top: selY,
                  height: 56,
                  borderRadius: 12,
                  background: s.card,
                  boxShadow: `${s.shadow.xs}, 0 0 0 1px ${s.border}`,
                }}
              />
              {p.nav.map((n, i) => {
                const active = Math.abs(navY(i) - selY) < 20;
                const count = i === p.to ? unread : n.count;
                return (
                  <div
                    key={n.label}
                    style={{
                      position: "absolute",
                      left: 30,
                      right: 30,
                      top: navY(i),
                      height: 56,
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                      fontSize: 26,
                      fontWeight: active ? 500 : 400,
                      color: active ? s.text : s.mutedText,
                    }}
                  >
                    <Icon name={n.icon} size={26} color={active ? s.text : s.mutedText} stroke={1.9} />
                    {n.label}
                    {count ? (
                      <span
                        style={{
                          marginLeft: "auto",
                          fontSize: 21,
                          fontWeight: 500,
                          color: i === p.to ? p.accent : s.mutedText,
                        }}
                      >
                        {count}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          <div style={{ position: "absolute", left: side, right: 0, top: 0, bottom: 0, overflow: "hidden" }}>
            <div
              style={{ position: "absolute", left: 0, right: 0, top: 0, padding: "34px 48px 0", opacity: 1 - swapIn }}
            >
              <div style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.02em" }}>Good morning</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 30 }}>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} style={{ height: 180, borderRadius: 18, border: `1px solid ${s.border}`, padding: 26 }}>
                    <div style={{ width: "40%", height: 18, borderRadius: 6, background: s.muted }} />
                    <div style={{ width: "60%", height: 36, borderRadius: 8, background: s.muted, marginTop: 22 }} />
                  </div>
                ))}
              </div>
            </div>
            <div
              style={{
                position: "absolute",
                inset: 0,
                opacity: swapIn,
                transform: `translateY(${(1 - swapIn) * 18}px)`,
              }}
            >
              <div
                style={{
                  height: 112,
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  padding: "0 48px",
                  borderBottom: `1px solid ${s.border}`,
                }}
              >
                <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>{p.heading}</div>
                <Badge s={s} tone="accent" size={21}>
                  {unread} unread
                </Badge>
              </div>
              {list.map((m, k) => {
                const arrivalIndex = p.arrivals.length - 1 - k;
                const isArrival = arrivalIndex >= 0;
                const at = p.arriveAt + arrivalIndex * p.gap;
                if (isArrival && frame < at) return null;
                const enter = isArrival ? progress(frame, at, 14, "expoOut") : 1;
                const slot = k - (p.arrivals.length - pushed);
                const fresh = isArrival ? 1 - progress(frame, at + 30, 30, "linear") : 0;
                return (
                  <div
                    key={`${m.from}-${m.subject}`}
                    style={{
                      position: "absolute",
                      left: 24,
                      right: 24,
                      top: 112 + 12 + slot * ROW,
                      height: ROW - 8,
                      borderRadius: 16,
                      display: "flex",
                      alignItems: "center",
                      gap: 22,
                      padding: "0 24px",
                      opacity: enter,
                      transform: `scale(${0.97 + 0.03 * enter})`,
                      background: fresh > 0.02 ? s.accentSoft : undefined,
                    }}
                  >
                    <div
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 12,
                        background: isArrival ? p.accent : "transparent",
                        flexShrink: 0,
                      }}
                    />
                    <Avatar initials={initials(m.from)} size={60} hue={hueFor(m.from)} tone={s.tone} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 14, fontSize: 28 }}>
                        <span style={{ fontWeight: isArrival ? 600 : 500 }}>{m.from}</span>
                        <span style={{ marginLeft: "auto", fontSize: 22, color: s.mutedText }}>{m.time}</span>
                      </div>
                      <div
                        style={{
                          fontSize: 26,
                          marginTop: 2,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          color: isArrival ? s.text : s.mutedText,
                        }}
                      >
                        {m.subject} <span style={{ color: s.faintText }}>— {m.preview}</span>
                      </div>
                    </div>
                    {!portrait ? (
                      <Badge s={s} size={20}>
                        {m.tag}
                      </Badge>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </Window>
      </div>
    </Ground>
  );
};
