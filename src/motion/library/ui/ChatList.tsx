import React from "react";
import { z } from "zod";
import { useCurrentFrame } from "remotion";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { Avatar, hueFor, Icon } from "./kit";
import { Ground, initials, surface, useUnit } from "./surface";

const rowSchema = z.object({
  name: z.string(),
  preview: z.string(),
  time: z.string(),
  /** Unread count shown as a badge; 0 hides it. */
  unread: z.number().int().min(0),
  /** A muted chat: grey badge instead of the accent. */
  muted: z.boolean().optional(),
});

const eventSchema = z.object({
  /** Frame the message arrives: the row jumps to the top with the new preview. */
  at: z.number().int().min(0),
  /** Index into `rows`. */
  row: z.number().int().min(0),
  preview: z.string(),
  time: z.string().optional(),
  /** Unread messages this event adds, 1 by default; 0 for your own reply. */
  unread: z.number().int().min(0).optional(),
  /** Frames of "typing…" in the preview before the message lands; 0 for none. */
  typingFrames: z.number().int().min(0).optional(),
});

const markSchema = z.object({
  row: z.number().int().min(0),
  at: z.number().int().min(0),
  /** "highlight" tints the row with the accent; "dim" greys it out; "read" clears its badge. */
  kind: z.enum(["highlight", "dim", "read"]),
});

export const chatListSchema = z.object({
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  /** Header over the list, e.g. "Chats"; empty hides it. */
  title: z.string(),
  rows: z.array(rowSchema).min(1).max(12),
  events: z.array(eventSchema),
  marks: z.array(markSchema).optional(),
  /** Preview text while someone types, in the film's language. */
  typingLabel: z.string(),
  /** Frames a row takes to travel to the top. */
  moveFrames: z.number().int().min(1).optional(),
  /** Multiplies type and row height, 1 by default (name 40 px at 1080 wide); 1.15-1.3 for a close phone read. */
  textScale: z.number().min(0.7).max(1.8).optional(),
});

export type ChatListProps = z.infer<typeof chatListSchema>;

type RowState = { preview: string; time: string; unread: number; typing: boolean };

/** Row order after each event, starting with the initial order. A row that gets a message moves to the top. */
export const chatListOrders = (rows: number, events: readonly { at: number; row: number }[]): number[][] => {
  const orders = [Array.from({ length: rows }, (_, i) => i)];
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    const previous = orders.at(-1)!;
    orders.push([event.row, ...previous.filter((row) => row !== event.row)]);
  }
  return orders;
};

/** Everything a row shows at `frame`: a pure function of the props and the frame. */
export const chatListState = (p: ChatListProps, frame: number) => {
  const events = [...p.events].sort((a, b) => a.at - b.at);
  const orders = chatListOrders(p.rows.length, events);
  const landed = events.filter((event) => frame >= event.at).length;
  const moving = landed > 0 ? progress(frame, events[landed - 1]!.at, p.moveFrames ?? 14, "inOut") : 1;
  const states: RowState[] = p.rows.map((row) => ({
    preview: row.preview,
    time: row.time,
    unread: row.unread,
    typing: false,
  }));
  events.forEach((event, i) => {
    const state = states[event.row]!;
    if (i < landed)
      Object.assign(state, {
        preview: event.preview,
        time: event.time ?? state.time,
        unread: state.unread + (event.unread ?? 1),
        typing: false,
      });
    else if (frame >= event.at - (event.typingFrames ?? 0)) state.typing = true;
  });
  for (const mark of p.marks ?? []) if (mark.kind === "read" && frame >= mark.at) states[mark.row]!.unread = 0;
  return {
    from: orders[Math.max(0, landed - 1)]!,
    to: orders[landed]!,
    moving,
    states,
    lastAt: landed > 0 ? events[landed - 1]!.at : -1,
  };
};

/** The typing label with its trailing dots replaced by one to three that cycle every 8 frames. */
export const typingText = (label: string, frame: number): string =>
  `${label.replace(/[.…\s]+$/, "")}${".".repeat(1 + (Math.floor(frame / 8) % 3))}`;

export const chatListCues = (p: ChatListProps): Cue[] => [
  { frame: 0, kind: "reveal", sfx: "none", weight: "support", label: "list lands" },
  ...p.events.flatMap((event): Cue[] => [
    ...(event.typingFrames
      ? [
          {
            frame: event.at - event.typingFrames,
            kind: "type" as const,
            sfx: "none" as const,
            weight: "support" as const,
            label: `${p.rows[event.row]?.name ?? "row"} is typing`,
          },
        ]
      : []),
    {
      frame: event.at,
      kind: "land",
      sfx: "pop",
      weight: "hero",
      label: `message from ${p.rows[event.row]?.name ?? "row"}, row moves to the top`,
    },
  ]),
  ...(p.marks ?? []).map((mark): Cue => ({
    frame: mark.at,
    kind: mark.kind === "highlight" ? "hit" : "reveal",
    sfx: mark.kind === "highlight" ? "tick" : "none",
    weight: "support",
    label: `${p.rows[mark.row]?.name ?? "row"} ${mark.kind}`,
  })),
];

/** A messenger's conversation list: rows jump to the top as messages arrive, with typing, unread badges and marks. */
export const ChatList: React.FC<ChatListProps> = (p) => {
  const frame = useCurrentFrame();
  const unit = useUnit();
  const { portrait } = unit;
  const k = p.textScale ?? 1;
  const u = unit.u * k;
  const W = unit.width / u;
  const H = unit.height / u;
  const s = surface(p.tone, p.accent);
  const listW = portrait ? W : Math.min(W - 160 / k, 1000);
  const left = (W - listW) / 2;
  const rowH = 150;
  // In vertical the list fills the screen from the top edge; the header keeps clear of the status bar.
  const headH = (p.title ? 150 : 40) + (portrait ? 140 / k : 0);
  // Clear of the 60 px side margins of the vertical safe zone.
  const padX = portrait ? 66 / k : 44;
  const top = portrait ? 0 : (H - headH - rowH * Math.min(p.rows.length, 6)) / 2;
  const rise = progress(frame, 0, 18, "expoOut");
  const { from, to, moving, states, lastAt } = chatListState(p, frame);
  const slot = (row: number) => from.indexOf(row) + (to.indexOf(row) - from.indexOf(row)) * moving;
  const marked = (row: number, kind: "highlight" | "dim") =>
    (p.marks ?? [])
      .filter((mark) => mark.row === row && mark.kind === kind)
      .reduce((value, mark) => Math.max(value, progress(frame, mark.at, 10, "inOut")), 0);

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
            left,
            top: top + (portrait ? 0 : (1 - rise) * 40),
            width: listW,
            bottom: portrait ? 0 : undefined,
            height: portrait ? undefined : headH + rowH * Math.min(p.rows.length, 6),
            opacity: rise,
            background: s.background,
            borderRadius: portrait ? 0 : 28,
            boxShadow: portrait ? undefined : s.shadow.window,
            overflow: "hidden",
          }}
        >
          {p.title ? (
            <div
              style={{
                height: headH,
                display: "flex",
                alignItems: "flex-end",
                padding: `0 ${padX}px 34px`,
                fontSize: 56,
                fontWeight: 700,
                letterSpacing: "-0.02em",
              }}
            >
              {p.title}
            </div>
          ) : null}
          <div style={{ position: "absolute", left: 0, right: 0, top: headH, bottom: 0 }}>
            {p.rows.map((row, i) => {
              const state = states[i]!;
              const y = slot(i) * rowH;
              const lift = to.indexOf(i) === 0 && moving < 1 && frame >= lastAt ? 1 : 0;
              const glow = to.indexOf(i) === 0 && lastAt >= 0 ? 1 - progress(frame, lastAt, 30, "inOut") : 0;
              const tint = marked(i, "highlight");
              const dim = marked(i, "dim");
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    top: y,
                    height: rowH,
                    zIndex: lift ? 2 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 28,
                    padding: `0 ${padX}px`,
                    background: tint > 0 ? s.accentSoft : glow > 0 ? s.hover : s.background,
                    opacity: 1 - 0.6 * dim,
                    boxShadow: lift ? s.shadow.md : undefined,
                  }}
                >
                  <Avatar initials={initials(row.name)} size={96} hue={hueFor(row.name)} tone={p.tone} />
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      height: rowH,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "center",
                      gap: 8,
                      borderBottom: `1px solid ${s.border}`,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
                      <div
                        style={{
                          fontSize: 40,
                          fontWeight: 600,
                          letterSpacing: "-0.01em",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          flex: 1,
                        }}
                      >
                        {row.name}
                      </div>
                      <div
                        style={{
                          fontSize: 28,
                          color: state.unread > 0 && !row.muted ? s.accent : s.mutedText,
                          flexShrink: 0,
                        }}
                      >
                        {state.time}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                      <div
                        style={{
                          fontSize: 33,
                          color: state.typing ? s.accent : s.mutedText,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          flex: 1,
                        }}
                      >
                        {state.typing ? typingText(p.typingLabel, frame) : state.preview}
                      </div>
                      {row.muted && state.unread === 0 ? <Icon name="bell" size={30} color={s.faintText} /> : null}
                      {state.unread > 0 ? (
                        <div
                          style={{
                            minWidth: 46,
                            height: 46,
                            padding: "0 14px",
                            borderRadius: 46,
                            background: row.muted ? s.faintText : s.accent,
                            color: "#FFFFFF",
                            fontSize: 26,
                            fontWeight: 600,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          {state.unread}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </Ground>
  );
};
