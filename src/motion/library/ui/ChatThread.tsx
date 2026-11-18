import React from "react";
import { z } from "zod";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { progress } from "../../timing";
import { Avatar, ease, hueFor, Icon, Stage, uiFont, useFormat } from "./kit";
import { surface } from "./surface";

export const chatThreadSchema = z.object({
  contactName: z.string(),
  contactInitials: z.string(),
  contactStatus: z.string(),
  messages: z.array(z.object({ from: z.enum(["me", "them"]), text: z.string(), time: z.string().optional() })),
  /** Frame of the first message. */
  start: z.number().int().min(0),
  /** Frames between messages. */
  gap: z.number().int().min(4),
  /** Frames the typing indicator shows before each incoming message. */
  typingFrames: z.number().int().min(0),
  myBubble: z.string(),
  /** Empty uses the theme's muted surface. */
  theirBubble: z.string(),
  placeholder: z.string(),
  /** Light or dark app; defaults to light. */
  tone: z.enum(["light", "dark"]).optional(),
  /** Multiplies the thread's type and bubbles, 1 by default (42 px at 1080 wide in vertical, 34 in landscape). 1.15-1.3 reads better on a phone. */
  textScale: z.number().min(0.7).max(1.8).optional(),
});

export type ChatThreadProps = z.infer<typeof chatThreadSchema>;

/** Frame each message lands, with typing time added before incoming ones. Exported for SFX cues. */
export const chatSchedule = (
  messages: { from: "me" | "them" }[],
  start: number,
  gap: number,
  typingFrames: number,
): number[] => {
  let at = start;
  return messages.map((m, i) => {
    if (i > 0) at += gap;
    if (m.from === "them" && i > 0) at += typingFrames;
    return at;
  });
};

const Grow: React.FC<{ p: number; children: React.ReactNode }> = ({ p, children }) => (
  <div style={{ display: "grid", gridTemplateRows: `${Math.max(0, Math.min(1, p))}fr` }}>
    <div style={{ overflow: "hidden", minHeight: 0 }}>{children}</div>
  </div>
);

/** A full-frame messenger: messages land one by one with typing dots, settle without overshoot and push the column up. Any script. */
export const ChatThread: React.FC<ChatThreadProps> = ({
  contactName,
  contactInitials,
  contactStatus,
  messages,
  start,
  gap,
  typingFrames,
  myBubble,
  theirBubble: theirInput,
  placeholder,
  tone = "light",
  textScale = 1,
}) => {
  const s = surface(tone, myBubble);
  const theirBubble =
    theirInput && !(tone === "light" && theirInput.startsWith("rgba(255,255,255")) ? theirInput : s.muted;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { width, height, portrait } = useFormat();
  const lands = chatSchedule(messages, start, gap, typingFrames);

  const type = (portrait ? 42 : 34) * textScale;
  const sidebarW = portrait ? 0 : width * 0.3;
  const threads = [
    [contactName, messages.at(-1)?.text ?? "", "09:42"],
    ["Design review", "Jonas: pushed the new flows", "09:10"],
    ["Ops", "Payout window opens at 10:00", "08:55"],
    ["Priya Raman", "Thanks, signed and sent back", "Yesterday"],
    ["Finance team", "Q2 forecast draft is in the doc", "Yesterday"],
    ["Marcus Chen", "Can we move the call to 4?", "Mon"],
  ];

  const typingIndex = messages.findIndex(
    (m, i) => m.from === "them" && frame >= lands[i]! - typingFrames && frame < lands[i]!,
  );

  return (
    <Stage ground={s.background}>
      <div style={{ position: "absolute", inset: 0, display: "flex", fontFamily: uiFont, color: s.text }}>
        {sidebarW > 0 ? (
          <div
            style={{
              width: sidebarW,
              borderRight: `1px solid ${s.border}`,
              background: tone === "light" ? "#FAFAFA" : "#0E0E10",
              paddingTop: 30,
            }}
          >
            <div style={{ padding: "0 30px 22px", fontSize: 34, fontWeight: 600, letterSpacing: -0.6 }}>Messages</div>
            {threads.map(([name, last, time], i) => (
              <div
                key={name}
                style={{
                  display: "flex",
                  gap: 18,
                  alignItems: "center",
                  padding: "18px 30px",
                  background: i === 0 ? s.hover : undefined,
                }}
              >
                <Avatar
                  initials={name!
                    .split(" ")
                    .map((w) => w[0])
                    .join("")
                    .slice(0, 2)}
                  size={64}
                  hue={hueFor(name!)}
                  tone={tone}
                />
                <div style={{ minWidth: 0, flex: 1, lineHeight: 1.3 }}>
                  <div style={{ display: "flex", fontSize: 26, fontWeight: 600 }}>
                    {name}
                    <span style={{ marginLeft: "auto", fontSize: 20, fontWeight: 400, color: s.mutedText }}>
                      {time}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      color: s.mutedText,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {i === 0 ? (messages.slice(0, lands.filter((at) => frame >= at).length).at(-1)?.text ?? "") : last}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            background: s.background,
            paddingTop: portrait ? 168 : 0,
            paddingBottom: portrait ? 200 : 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 18,
              padding: "26px 40px",
              borderBottom: `1px solid ${s.border}`,
            }}
          >
            <Avatar initials={contactInitials} size={type * 1.9} hue={hueFor(contactName)} tone={tone} />
            <div style={{ lineHeight: 1.25 }}>
              <div style={{ fontSize: type * 0.95, fontWeight: 600, letterSpacing: -0.4 }}>{contactName}</div>
              <div style={{ fontSize: type * 0.7, color: s.mutedText }}>{typingIndex >= 0 ? "…" : contactStatus}</div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 22, color: s.mutedText }}>
              <Icon name="search" size={type} color="currentColor" />
              <Icon name="calendar" size={type} color="currentColor" />
            </div>
          </div>
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-end",
              padding: "0 40px 10px",
              overflow: "hidden",
            }}
          >
            {messages.map((m, i) => {
              const at = lands[i]!;
              if (frame < at) return null;
              const pop = spring({
                frame: frame - at,
                fps,
                config: { damping: 14, stiffness: 140, mass: 0.8, overshootClamping: true },
              });
              const fade = progress(frame, at, 6, ease.arrive);
              const grow = spring({
                frame: frame - at,
                fps,
                config: { damping: 18, stiffness: 200, mass: 1, overshootClamping: true },
              });
              const mine = m.from === "me";
              const next = messages[i + 1];
              const tail = !next || next.from !== m.from || frame < lands[i + 1]!;
              const r = type * 0.95;
              return (
                <Grow key={i} p={grow}>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: mine ? "flex-end" : "flex-start",
                      paddingTop: i > 0 && messages[i - 1]!.from === m.from ? 6 : 18,
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "78%",
                        padding: `${type * 0.48}px ${type * 0.72}px`,
                        fontSize: type,
                        lineHeight: 1.32,
                        letterSpacing: -0.2,
                        color: mine ? "#FFFFFF" : s.text,
                        background: mine ? myBubble : theirBubble,
                        borderRadius: r,
                        borderBottomRightRadius: mine && tail ? r * 0.25 : r,
                        borderBottomLeftRadius: !mine && tail ? r * 0.25 : r,
                        transformOrigin: mine ? "100% 100%" : "0% 100%",
                        transform: `scale(${0.9 + 0.1 * pop})`,
                        opacity: fade,
                        boxShadow: mine ? undefined : `inset 0 0 0 1px ${s.border}`,
                      }}
                    >
                      {m.text}
                    </div>
                    {m.time && tail ? (
                      <div
                        style={{
                          fontSize: type * 0.6,
                          color: s.mutedText,
                          marginTop: 6,
                          padding: "0 6px",
                          opacity: progress(frame, at + 6, 10),
                        }}
                      >
                        {m.time}
                      </div>
                    ) : null}
                  </div>
                </Grow>
              );
            })}
            {typingIndex >= 0 ? (
              <div style={{ paddingTop: 18 }}>
                <div
                  style={{
                    display: "inline-flex",
                    gap: type * 0.24,
                    padding: `${type * 0.62}px ${type * 0.7}px`,
                    borderRadius: type,
                    borderBottomLeftRadius: type * 0.25,
                    background: theirBubble,
                    transform: `scale(${spring({ frame: frame - (lands[typingIndex]! - typingFrames), fps, config: { damping: 14, stiffness: 140, mass: 0.8, overshootClamping: true } })})`,
                    transformOrigin: "0 100%",
                  }}
                >
                  {[0, 1, 2].map((d) => {
                    const phase = Math.sin((frame - d * 4) / 3.2);
                    return (
                      <div
                        key={d}
                        style={{
                          width: type * 0.3,
                          height: type * 0.3,
                          borderRadius: type,
                          background: s.mutedText,
                          opacity: 0.4 + 0.6 * Math.max(0, phase),
                          transform: `translateY(${-Math.max(0, phase) * type * 0.12}px)`,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "18px 24px 26px" }}>
            <div
              style={{
                flex: 1,
                padding: `${type * 0.45}px ${type * 0.75}px`,
                borderRadius: type * 2,
                background: s.card,
                border: `1px solid ${s.border}`,
                boxShadow: s.shadow.xs,
                fontSize: type * 0.85,
                color: s.faintText,
              }}
            >
              {placeholder}
            </div>
            <div
              style={{
                width: type * 1.9,
                height: type * 1.9,
                borderRadius: type * 2,
                background: myBubble,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="send" size={type * 0.9} color="white" />
            </div>
          </div>
        </div>
      </div>
    </Stage>
  );
};
