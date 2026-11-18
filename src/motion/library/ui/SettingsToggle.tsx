import React from "react";
import { z } from "zod";
import { useCurrentFrame } from "remotion";
import { trackPoint } from "../../timing";
import { progress } from "../../timing";
import { Badge, ClickRing, Ground, Pointer, surface, Toggle, useUnit, Window } from "./surface";

const rowSchema = z.object({ title: z.string(), body: z.string(), on: z.boolean() });

export const settingsToggleSchema = z.object({
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  heading: z.string(),
  rows: z.array(rowSchema).min(1).max(5),
  /** Row whose switch the cursor flips. */
  flip: z.number().int().min(0),
  clickAt: z.number().int().min(4),
  /** Badge shown on the flipped row after the click. */
  savedLabel: z.string(),
});

export type SettingsToggleProps = z.infer<typeof settingsToggleSchema>;

export const settingsToggleCues = (p: SettingsToggleProps) => [
  { frame: 0, kind: "reveal" as const, sfx: "none" as const, weight: "support" as const, label: "card lands" },
  { frame: p.clickAt, kind: "click" as const, sfx: "click" as const, weight: "hero" as const, label: "switch flips" },
  { frame: p.clickAt + 10, kind: "reveal" as const, sfx: "tick" as const, weight: "support" as const, label: "saved" },
];

/** A settings card at reading scale; the cursor travels to one switch and flips it, the track fills with the accent and a badge confirms. */
export const SettingsToggle: React.FC<SettingsToggleProps> = (p) => {
  const frame = useCurrentFrame();
  const { width, height, portrait, u } = useUnit();
  const s = surface(p.tone, p.accent);
  const W = width / u;
  const H = height / u;
  const cardW = portrait ? W - 80 : 1240;
  const rowH = portrait ? 170 : 132;
  const headH = 130;
  const cardH = headH + rowH * p.rows.length;
  const left = (W - cardW) / 2;
  const top = (H - cardH) / 2;
  const rise = progress(frame, 0, 18, "expoOut");
  const flipP = progress(frame, p.clickAt, 9, "inOut");
  const saved = progress(frame, p.clickAt + 10, 12, "expoOut");
  const target = { x: left + cardW - 48 - 32, y: top + headH + rowH * p.flip + rowH / 2 };
  const cursor = trackPoint(frame, [
    { at: p.clickAt - 34, x: W * 0.62, y: H * 0.98 },
    { at: p.clickAt - 2, x: target.x, y: target.y, curve: "expoOut" },
  ]);

  return (
    <Ground s={s}>
      <div style={{ position: "absolute", inset: 0, transform: `scale(${u})`, transformOrigin: "0 0" }}>
        <Window
          s={s}
          width={cardW}
          height={cardH}
          bar={false}
          radius={28}
          style={{ left, top: top + (1 - rise) * 40, opacity: rise }}
        >
          <div
            style={{
              height: headH,
              padding: "0 48px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              borderBottom: `1px solid ${s.border}`,
            }}
          >
            <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>{p.heading}</div>
          </div>
          {p.rows.map((r, i) => {
            const on = i === p.flip ? (r.on ? 1 - flipP : flipP) : r.on ? 1 : 0;
            return (
              <div
                key={i}
                style={{
                  height: rowH,
                  display: "flex",
                  alignItems: "center",
                  gap: 32,
                  padding: "0 48px",
                  borderBottom: i < p.rows.length - 1 ? `1px solid ${s.border}` : undefined,
                  background: i === p.flip && frame >= p.clickAt - 8 ? s.hover : undefined,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 32, fontWeight: 500, display: "flex", alignItems: "center", gap: 16 }}>
                    {r.title}
                    {i === p.flip && saved > 0 ? (
                      <span
                        style={{
                          opacity: saved,
                          transform: `translateX(${(1 - saved) * -10}px)`,
                          display: "inline-flex",
                        }}
                      >
                        <Badge s={s} tone="positive" size={20}>
                          {p.savedLabel}
                        </Badge>
                      </span>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 25, color: s.mutedText, marginTop: 6, lineHeight: 1.35 }}>{r.body}</div>
                </div>
                <Toggle s={s} on={on} scale={1.4} />
              </div>
            );
          })}
        </Window>
        <ClickRing x={target.x} y={target.y} frame={frame} at={p.clickAt} color={p.accent} />
        {frame >= p.clickAt - 34 ? (
          <Pointer x={cursor.x} y={cursor.y} frame={frame} pressAt={p.clickAt} size={56} />
        ) : null}
      </div>
    </Ground>
  );
};
