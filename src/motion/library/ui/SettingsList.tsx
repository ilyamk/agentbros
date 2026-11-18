import React from "react";
import { z } from "zod";
import { useCurrentFrame } from "remotion";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { hueFor, Icon } from "./kit";
import { Ground, surface, Toggle, useUnit } from "./surface";

const rowSchema = z.object({
  /** Icon name from the ui kit (bell, lock, shield, users, card, calendar, folder, settings, mic, search, home…). */
  icon: z.string(),
  title: z.string(),
  /** Grey value before the chevron, e.g. "English"; empty for none. */
  value: z.string().optional(),
  /** "chevron" opens a page, "toggle" is a switch (`on`), "none" is a plain row. */
  control: z.enum(["chevron", "toggle", "none"]),
  on: z.boolean().optional(),
});

const sectionSchema = z.object({ header: z.string(), rows: z.array(rowSchema).min(1) });
const ref = { section: z.number().int().min(0), row: z.number().int().min(0) };

export const settingsListSchema = z.object({
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  /** Screen title; empty hides it. */
  title: z.string(),
  sections: z.array(sectionSchema).min(1).max(4),
  /** Frame the first row lands and frames between rows. */
  start: z.number().int().min(0),
  step: z.number().min(0.5),
  /** One row tinted with the accent from `at`. */
  highlight: z.object({ ...ref, at: z.number().int().min(0) }).optional(),
  /** Switches that flip at their frame. */
  flips: z.array(z.object({ ...ref, at: z.number().int().min(0) })).optional(),
  /** A selection list that opens under one row at `at`; the checkmark moves from `from` to `chosen` at `chooseAt`, and the row's value follows. */
  select: z
    .object({
      ...ref,
      at: z.number().int().min(0),
      options: z.array(z.string()).min(2).max(6),
      from: z.number().int().min(0),
      chosen: z.number().int().min(0),
      chooseAt: z.number().int().min(0),
    })
    .optional(),
  /** Multiplies type and row height, 1 by default (titles 36 px at 1080 wide); 1.15-1.3 for a close phone read. */
  textScale: z.number().min(0.7).max(1.8).optional(),
});

export type SettingsListProps = z.infer<typeof settingsListSchema>;

/** Landing frame of every row, section by section, in reading order. */
export const settingsRowFrames = (p: Pick<SettingsListProps, "sections" | "start" | "step">): number[][] => {
  let index = 0;
  return p.sections.map((section) => section.rows.map(() => Math.round(p.start + index++ * p.step)));
};

export const settingsListCues = (p: SettingsListProps): Cue[] => {
  const frames = settingsRowFrames(p);
  const last = frames.at(-1)!.at(-1)!;
  const name = (r: { section: number; row: number }) => p.sections[r.section]?.rows[r.row]?.title ?? "row";
  return [
    { frame: frames[0]![0]!, kind: "reveal", sfx: "none", weight: "support", label: "rows land one by one" },
    { frame: last, kind: "land", sfx: "tick", weight: "support", label: "last row lands" },
    ...(p.highlight
      ? [
          {
            frame: p.highlight.at,
            kind: "hit" as const,
            sfx: "tick" as const,
            weight: "support" as const,
            label: `${name(p.highlight)} highlighted`,
          },
        ]
      : []),
    ...(p.flips ?? []).map((flip): Cue => ({
      frame: flip.at,
      kind: "click",
      sfx: "click",
      weight: "hero",
      label: `${name(flip)} switch flips`,
    })),
    ...(p.select
      ? [
          {
            frame: p.select.at,
            kind: "reveal" as const,
            sfx: "whoosh" as const,
            weight: "support" as const,
            label: `${name(p.select)} options open`,
          },
          {
            frame: p.select.chooseAt,
            kind: "click" as const,
            sfx: "click" as const,
            weight: "hero" as const,
            label: `checkmark moves to ${p.select.options[p.select.chosen] ?? "option"}`,
          },
        ]
      : []),
  ];
};

const same = (a: { section: number; row: number } | undefined, section: number, row: number) =>
  a !== undefined && a.section === section && a.row === row;

/** A settings screen: section headers, rows with icon, title, value and chevron or switch, landing one by one. */
export const SettingsList: React.FC<SettingsListProps> = (p) => {
  const frame = useCurrentFrame();
  const unit = useUnit();
  const { portrait } = unit;
  const k = p.textScale ?? 1;
  const rowH = 118;
  const optionH = 100;
  const topGap = portrait ? 200 / k : 70;
  // Shrinks to fit when the sections and the open selection list would run off the frame (landscape mostly).
  const contentH =
    (p.title ? 110 : 0) +
    p.sections.reduce((sum, section) => sum + 82 + section.rows.length * rowH, 0) +
    (p.select ? p.select.options.length * optionH : 0);
  const fit = Math.min(1, (unit.height / (unit.u * k) - topGap - 40) / contentH);
  const u = unit.u * k * fit;
  const W = unit.width / u;
  const H = unit.height / u;
  const s = surface(p.tone, p.accent);
  const frames = settingsRowFrames(p);
  const listW = portrait ? W - 64 : Math.min(W - 160 / k, 1100);
  const select = p.select;
  const open = select ? progress(frame, select.at, 16, "inOut") : 0;
  const checked = select ? (frame >= select.chooseAt ? select.chosen : select.from) : 0;
  const checkIn = select ? progress(frame, select.chooseAt, 8, "overshoot") : 0;
  const rise = progress(frame, 0, 18, "expoOut");

  return (
    <Ground s={s}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${u})`,
          transformOrigin: "0 0",
          width: W,
          height: H,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: (W - listW) / 2,
            width: listW,
            top: topGap / fit,
            opacity: rise,
            transform: `translateY(${(1 - rise) * 40}px)`,
          }}
        >
          {p.title ? (
            <div style={{ fontSize: 64, fontWeight: 700, letterSpacing: "-0.02em", padding: "0 36px 24px" }}>
              {p.title}
            </div>
          ) : null}
          {p.sections.map((section, si) => (
            <div key={si} style={{ marginBottom: 40 }}>
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 500,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: s.mutedText,
                  padding: "0 28px 14px",
                  opacity: progress(frame, frames[si]![0]! - 4, 10, "expoOut"),
                }}
              >
                {section.header}
              </div>
              <div
                style={{
                  background: s.card,
                  borderRadius: 26,
                  boxShadow: s.shadow.xs,
                  border: `1px solid ${s.border}`,
                  overflow: "hidden",
                  opacity: progress(frame, frames[si]![0]!, 10, "expoOut"),
                }}
              >
                {section.rows.map((row, ri) => {
                  const land = progress(frame, frames[si]![ri]!, 12, "expoOut");
                  const flip = (p.flips ?? []).find((item) => same(item, si, ri));
                  const flipP = flip ? progress(frame, flip.at, 9, "inOut") : 0;
                  const on = row.on ? 1 - flipP : flipP;
                  const tint = same(p.highlight, si, ri) ? progress(frame, p.highlight!.at, 10, "inOut") : 0;
                  const selecting = same(select, si, ri);
                  const value = selecting ? select!.options[checked] : row.value;
                  const hue = hueFor(row.icon + row.title);
                  return (
                    <div key={ri} style={{ opacity: land, transform: `translateY(${(1 - land) * 24}px)` }}>
                      <div
                        style={{
                          height: rowH,
                          display: "flex",
                          alignItems: "center",
                          gap: 28,
                          padding: "0 28px",
                          background: tint > 0 ? s.accentSoft : undefined,
                          boxShadow: tint > 0 ? `inset 6px 0 0 ${p.accent}` : undefined,
                        }}
                      >
                        <div
                          style={{
                            width: 64,
                            height: 64,
                            borderRadius: 16,
                            flexShrink: 0,
                            background: `hsl(${hue} 62% ${p.tone === "light" ? 52 : 46}%)`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Icon name={row.icon} size={36} color="#FFFFFF" stroke={2.1} />
                        </div>
                        <div
                          style={{
                            flex: 1,
                            minWidth: 0,
                            height: rowH,
                            display: "flex",
                            alignItems: "center",
                            gap: 18,
                            borderBottom:
                              ri < section.rows.length - 1 || (selecting && open > 0)
                                ? `1px solid ${s.border}`
                                : undefined,
                          }}
                        >
                          <div
                            style={{
                              flex: 1,
                              fontSize: 36,
                              fontWeight: 500,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {row.title}
                          </div>
                          {value ? (
                            <div style={{ fontSize: 34, color: s.mutedText, whiteSpace: "nowrap", flexShrink: 0 }}>
                              {value}
                            </div>
                          ) : null}
                          {row.control === "chevron" ? (
                            <div
                              style={{
                                transform: `rotate(${selecting ? -90 + 90 * open : -90}deg)`,
                                display: "flex",
                                flexShrink: 0,
                              }}
                            >
                              <Icon name="chevron" size={34} color={s.faintText} stroke={2.4} />
                            </div>
                          ) : null}
                          {row.control === "toggle" ? <Toggle s={s} on={on} scale={1.3} /> : null}
                        </div>
                      </div>
                      {selecting ? (
                        <div
                          style={{
                            height: open * optionH * select!.options.length,
                            overflow: "hidden",
                            background: s.muted,
                          }}
                        >
                          {select!.options.map((option, oi) => (
                            <div
                              key={oi}
                              style={{
                                height: optionH,
                                display: "flex",
                                alignItems: "center",
                                padding: "0 28px 0 120px",
                                fontSize: 34,
                                borderBottom: oi < select!.options.length - 1 ? `1px solid ${s.border}` : undefined,
                              }}
                            >
                              <div style={{ flex: 1, fontWeight: oi === checked ? 600 : 400 }}>{option}</div>
                              {oi === checked ? (
                                <div
                                  style={{
                                    transform: `scale(${frame >= select!.chooseAt ? checkIn : 1})`,
                                    display: "flex",
                                  }}
                                >
                                  <Icon name="check" size={38} color={p.accent} stroke={2.8} />
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Ground>
  );
};
