import React from "react";
import { z } from "zod";
import { useCurrentFrame } from "remotion";
import { VelocityBlur } from "../../fx";
import { progress } from "../../timing";
import { Icon } from "./kit";
import { arrivalTint } from "../../text-modes";
import { PILL_FILL, PILL_STRETCH, PILL_TYPING, PILL_WIPE, pillState } from "./ui-plan";
import {
  geistMono,
  Ground,
  pushSchema,
  pushStyle,
  SCROLL_EASES,
  scrollEaseSchema,
  Status,
  streamEnd,
  streamWords,
  surface,
  useUnit,
  Window,
} from "./surface";

const toolSchema = z.object({
  icon: z.string(),
  name: z.string(),
  detail: z.string(),
  result: z.string(),
  frames: z.number().int().min(4),
});

export const aiChatSchema = z.object({
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  assistant: z.string(),
  question: z.string(),
  /** Tool calls run one after another; each spins for `frames`, then shows its result. */
  tools: z.array(toolSchema).max(5),
  answer: z.string(),
  start: z.number().int().min(0),
  wordsPerFrame: z.number().min(0.05),
  /** A table the reply streams into after the answer: the header, then a row every `rowStep` frames. */
  table: z
    .object({
      columns: z.array(z.string()).min(1).max(6),
      rows: z.array(z.array(z.string())).min(1),
      rowStep: z.number().min(0.5),
      widths: z.array(z.number().positive()).optional(),
    })
    .optional(),
  /** A scroll through the whole thread to its end, with directional blur; rows past the fold fill unseen until it starts. */
  scrollAt: z.number().int().min(0).optional(),
  scrollFrames: z.number().int().min(4).optional(),
  scrollEase: scrollEaseSchema.optional(),
  /** Optional camera push into the window, e.g. ending on `scrollAt`. */
  push: pushSchema.optional(),
  /** Window tabs, e.g. ["Plan", "Render"]; absent shows `assistant` as the title. */
  tabs: z.array(z.string()).optional(),
  /** A "Thinking" line with this detail holds for `thinkFrames` before the answer, e.g. "Reading the motion library". */
  thinking: z.string().optional(),
  thinkFrames: z.number().int().min(4).optional(),
  /** Small grey line over the answer, e.g. "Worked for 41s". */
  answerLabel: z.string().optional(),
  /** Strength of the scroll's directional blur as a shutter share, 0.22 by default; 0.6 smears like a fast trackpad flick. */
  scrollBlur: z.number().min(0).max(1).optional(),
  /** Height in layout pixels the answer (with its label and the gap under it) takes in the thread. Estimated from the text when unset. */
  answerHeight: z.number().positive().optional(),
  /** Placeholder of the follow-up field, in the film's language; empty by default, so no locale is assumed. */
  followUp: z.string().optional(),
  /** Multiplies the whole window's type and spacing, 1 by default; 1.2-1.4 reads better in vertical on a phone. */
  textScale: z.number().min(0.7).max(1.8).optional(),
  /**
   * How the answer arrives: `fade` (default) fades the answer in under the avatar; `pill` shows a typing pill that fills
   * with the accent (2 f), stretches into a bar 0.30 of the frame wide (6 f, power3.out), and the reply card wipes in
   * through it from the left (5 f) and then grows with its lines (muse). The pill adds 25 frames before the answer.
   */
  answerEntry: z.enum(["fade", "pill"]).optional(),
  /**
   * Arrival tint of each row (tool-call card and table row): its text shows these colours one a frame from its arrival,
   * then settles to its own colour, done `rowTintFrames` after it appeared (motionfly t11; the same `arrivalTint` as
   * `type-sentence-build`'s `tint`, e.g. `sentenceBuildTintPreset.tint`). Absent: no tint.
   */
  rowTint: z.array(z.string()).optional(),
  rowTintFrames: z.number().int().min(1).max(30).optional(),
});

export type AiChatProps = z.infer<typeof aiChatSchema>;

export const aiChatTiming = (p: AiChatProps) => {
  const toolStarts: number[] = [];
  let t = p.start + 18;
  for (const tool of p.tools) {
    toolStarts.push(t);
    t += tool.frames + 6;
  }
  const thinkAt = t;
  /** Where the answer (or, with `answerEntry: "pill"`, the typing pill) starts; the thinking line ends 4 frames before. */
  const pillAt = t + 4 + (p.thinking ? (p.thinkFrames ?? 24) : 0);
  const thinkEnd = pillAt - 4;
  const answerAt = p.answerEntry === "pill" ? pillAt + PILL_TYPING + PILL_FILL + PILL_STRETCH + PILL_WIPE : pillAt;
  const answerDone = streamEnd(p.answer, answerAt, p.wordsPerFrame);
  const tableAt = answerDone + 4;
  const rowAt = (i: number) => Math.round(tableAt + 4 + i * (p.table?.rowStep ?? 0));
  return {
    toolStarts,
    toolDone: p.tools.map((tool, i) => toolStarts[i]! + tool.frames),
    thinkAt,
    thinkEnd,
    pillAt,
    answerAt,
    answerDone,
    tableAt,
    rowAt,
  };
};

export const aiChatCues = (p: AiChatProps) => {
  const t = aiChatTiming(p);
  return [
    { frame: p.start, kind: "reveal" as const, sfx: "pop" as const, weight: "support" as const, label: "question" },
    ...t.toolDone.map((frame, i) => ({
      frame,
      kind: "hit" as const,
      sfx: "tick" as const,
      weight: "support" as const,
      label: `${p.tools[i]!.name} done`,
    })),
    ...(p.thinking
      ? [
          {
            frame: t.thinkAt,
            kind: "reveal" as const,
            sfx: "none" as const,
            weight: "support" as const,
            label: "thinking",
          },
        ]
      : []),
    ...(p.answerEntry === "pill"
      ? [
          {
            frame: pillState(0, t.answerAt).stretchAt,
            kind: "hit" as const,
            sfx: "whoosh" as const,
            weight: "support" as const,
            label: "typing pill stretches into the answer",
          },
        ]
      : []),
    {
      frame: t.answerAt,
      kind: "reveal" as const,
      sfx: "chime" as const,
      weight: "hero" as const,
      label: "answer streams",
    },
    ...(p.table
      ? [
          {
            frame: t.tableAt,
            kind: "reveal" as const,
            sfx: "tick" as const,
            weight: "support" as const,
            label: "table streams",
          },
        ]
      : []),
    ...(p.push
      ? [
          {
            frame: p.push.at,
            kind: "hit" as const,
            sfx: "none" as const,
            weight: "support" as const,
            label: "camera push",
          },
        ]
      : []),
    ...(p.scrollAt !== undefined
      ? [
          {
            frame: p.scrollAt,
            kind: "hit" as const,
            sfx: "whoosh" as const,
            weight: "support" as const,
            label: "fast scroll",
          },
          {
            frame: p.scrollAt + (p.scrollFrames ?? 24),
            kind: "stop" as const,
            sfx: "tick" as const,
            weight: "support" as const,
            label: "scroll lands",
          },
        ]
      : []),
  ];
};

/** Advance of one character as a share of the font size, for Geist: a deterministic stand-in for measuring the DOM. */
const advance = (c: string): number =>
  c === " " ? 0.27 : /[.,:;'!|il1]/.test(c) ? 0.26 : /[mwMW@%]/.test(c) ? 0.8 : /[A-Z0-9]/.test(c) ? 0.62 : 0.52;

/** Lines a text wraps to at `width` pixels and `fontSize`, greedy by word, as the browser wraps it. */
export const wrapLines = (text: string, width: number, fontSize: number): number => {
  const space = advance(" ") * fontSize;
  let lines = 1;
  let line = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = [...word].reduce((sum, c) => sum + advance(c), 0) * fontSize;
    if (line > 0 && line + space + w > width) {
      lines++;
      line = w;
    } else line += (line > 0 ? space : 0) + w;
  }
  return lines;
};

/** Height of the answer block in the thread: label, wrapped text at its line height, and the thread's gap. */
export const answerBlockHeight = (
  answer: string,
  label: string | undefined,
  textWidth: number,
  fontSize: number,
): number =>
  Math.max(52, 4 + (label ? 22 * 1.3 + 8 : 0) + wrapLines(answer, textWidth, fontSize) * fontSize * 1.45) + 26;

/** An assistant thread at reading scale: the question lands, tool calls spin and resolve with results, then the answer streams. */
export const AiChat: React.FC<AiChatProps> = (p) => {
  const frame = useCurrentFrame();
  const unit = useUnit();
  const { width, height, portrait } = unit;
  const u = unit.u * (p.textScale ?? 1);
  const s = surface(p.tone, p.accent);
  const t = aiChatTiming(p);
  const W = width / u;
  const H = height / u;
  const winW = portrait ? W - 60 : Math.min(W - 200, 1500);
  const winH = portrait ? H - 220 : H - 100;
  const rise = progress(frame, 0, 18, "expoOut");
  const q = progress(frame, p.start, 12, "expoOut");
  const shownTools = t.toolStarts.reduce((sum, at) => sum + progress(frame, at, 12, "inOut"), 0);
  const answerIn = progress(frame, t.answerAt - 4, 10, "expoOut");
  const ROW = 56;
  const answerFont = portrait ? 36 : 34;
  const pill = p.answerEntry === "pill";
  const answerH =
    p.answerHeight ??
    (pill
      ? answerBlockHeight(p.answer, p.answerLabel, winW - 112 - 72 - 56, answerFont) + 40
      : answerBlockHeight(p.answer, p.answerLabel, winW - 112 - 72, answerFont));
  // The pill holds a 78 px slot (56 px pill and the thread's gap) until the card grows past it.
  const answerSlot = (f: number) =>
    pill
      ? f < t.pillAt
        ? 0
        : Math.max(78 * progress(f, t.pillAt, 8, "inOut"), progress(f, t.answerAt - 4, 16, "inOut") * answerH)
      : progress(f, t.answerAt - 4, 16, "inOut") * answerH;
  const rowsIn = (f: number) => (p.table ? p.table.rows.filter((_, i) => f >= t.rowAt(i)).length : 0);
  const tableH = (f: number, rows: number) => (p.table && f >= t.tableAt ? 70 + rows * ROW : 0);
  const contentAt = (f: number) =>
    120 +
    t.toolStarts.reduce((sum, at) => sum + progress(f, at, 12, "inOut"), 0) * 122 +
    answerSlot(f) +
    (p.thinking && f >= t.thinkAt && f < t.thinkEnd ? 90 : 0);
  const scrolls = p.scrollAt !== undefined;
  const autoAt = (f: number) => Math.max(0, contentAt(f) + (scrolls ? 0 : tableH(f, rowsIn(f))) - (winH - 260));
  const scrollAt = p.scrollAt ?? 0;
  const scrollFrames = p.scrollFrames ?? 24;
  const offsetAt = (f: number) => {
    if (!scrolls || f < scrollAt) return autoAt(f);
    const from = autoAt(scrollAt);
    const to = Math.max(from, contentAt(scrollAt + scrollFrames) + tableH(f, p.table?.rows.length ?? 0) - (winH - 260));
    return from + (to - from) * progress(f, scrollAt, scrollFrames, SCROLL_EASES[p.scrollEase ?? "snap"]);
  };
  const scrollUp = offsetAt(frame);
  // Only the deliberate scroll smears; the thread's own follow-scroll stays sharp.
  const speed = scrolls && frame >= scrollAt ? offsetAt(frame + 1) - scrollUp : 0;
  const shownRows = scrolls && frame >= scrollAt ? (p.table?.rows.length ?? 0) : rowsIn(frame);
  /** A row's text colour: its arrival tint settling to `base`, or `base` without `rowTint`. */
  const tinted = (at: number, base: string) =>
    p.rowTint?.length ? arrivalTint(frame, at, p.rowTint, base, p.rowTintFrames ?? 5) : base;
  const widths = p.table?.widths ?? p.table?.columns.map(() => 1) ?? [];
  const widthSum = widths.reduce((a, b) => a + b, 0) || 1;

  return (
    <Ground s={s}>
      <div style={{ position: "absolute", inset: 0, ...pushStyle(frame, p.push) }}>
        <div style={{ position: "absolute", inset: 0, transform: `scale(${u})`, transformOrigin: "0 0" }}>
          <Window
            s={s}
            width={winW}
            height={winH}
            title={p.tabs?.length ? undefined : p.assistant}
            tabs={p.tabs?.length ? p.tabs : undefined}
            style={{ left: (W - winW) / 2, top: (H - winH) / 2 + (1 - rise) * 40, opacity: rise }}
          >
            <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
              <VelocityBlur
                axis="y"
                speed={speed}
                shutter={p.scrollBlur ?? 0.22}
                maxBlur={Math.min(120, 60 * ((p.scrollBlur ?? 0.22) / 0.22))}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 56,
                    right: 56,
                    top: 40 - scrollUp,
                    display: "flex",
                    flexDirection: "column",
                    gap: 26,
                  }}
                >
                  <div
                    style={{
                      alignSelf: "flex-end",
                      maxWidth: "78%",
                      padding: "20px 28px",
                      borderRadius: 26,
                      background: s.muted,
                      fontSize: 32,
                      lineHeight: 1.35,
                      opacity: q,
                      transform: `translateY(${(1 - q) * 20}px)`,
                    }}
                  >
                    {p.question}
                  </div>
                  {p.tools.map((tool, i) => {
                    const at = t.toolStarts[i]!;
                    if (frame < at) return null;
                    const inP = progress(frame, at, 10, "expoOut");
                    const done = frame >= t.toolDone[i]!;
                    return (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 20,
                          padding: "20px 24px",
                          borderRadius: 18,
                          border: `1px solid ${s.border}`,
                          background: s.card,
                          boxShadow: s.shadow.xs,
                          opacity: inP,
                          transform: `translateY(${(1 - inP) * 16}px)`,
                          maxWidth: 1100,
                        }}
                      >
                        <div
                          style={{
                            width: 48,
                            height: 48,
                            borderRadius: 12,
                            background: s.muted,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Icon name={tool.icon} size={26} color={s.mutedText} stroke={2} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 28, fontWeight: 500, color: tinted(at, s.text) }}>
                            {tool.name}
                            <span style={{ fontFamily: geistMono, fontSize: 22, color: s.mutedText, marginLeft: 14 }}>
                              {tool.detail}
                            </span>
                          </div>
                          <div style={{ fontSize: 24, color: done ? s.mutedText : s.faintText, marginTop: 4 }}>
                            {done ? tool.result : "Running…"}
                          </div>
                        </div>
                        <Status s={s} frame={frame} doneAt={t.toolDone[i]!} size={32} />
                      </div>
                    );
                  })}
                  {p.thinking && frame >= t.thinkAt && frame < t.thinkEnd ? (
                    <div style={{ marginLeft: 72, opacity: progress(frame, t.thinkAt, 6, "linear") }}>
                      <div style={{ fontSize: 22, color: s.faintText, marginBottom: 8 }}>Thinking</div>
                      <div
                        style={{
                          fontSize: 28,
                          color: s.mutedText,
                          opacity: 0.6 + 0.4 * Math.cos(((frame - t.thinkAt) / 20) * Math.PI * 2),
                        }}
                      >
                        {p.thinking}
                      </div>
                    </div>
                  ) : null}
                  {pill && frame >= t.pillAt ? (
                    <PillAnswer
                      p={p}
                      s={s}
                      frame={frame}
                      answerAt={t.answerAt}
                      barW={W * 0.3}
                      maxW={winW - 112 - 72}
                      font={answerFont}
                    />
                  ) : null}
                  {!pill && frame >= t.answerAt - 4 ? (
                    <div style={{ opacity: answerIn, display: "flex", gap: 20 }}>
                      <div
                        style={{
                          width: 52,
                          height: 52,
                          borderRadius: 52,
                          background: p.accent,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <Icon name="sparkle" size={28} color="#FFFFFF" stroke={2} />
                      </div>
                      <div style={{ fontSize: answerFont, lineHeight: 1.45, letterSpacing: "-0.01em", paddingTop: 4 }}>
                        {p.answerLabel ? (
                          <div style={{ fontSize: 22, color: s.faintText, marginBottom: 8, lineHeight: 1.3 }}>
                            {p.answerLabel}
                          </div>
                        ) : null}
                        {streamWords(p.answer, frame, t.answerAt, p.wordsPerFrame).map(({ w, o, key }) => (
                          <span key={key} style={{ opacity: o }}>
                            {w}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {p.table && frame >= t.tableAt ? (
                    <div style={{ marginLeft: 72, opacity: progress(frame, t.tableAt, 6, "linear") }}>
                      <div
                        style={{
                          display: "flex",
                          height: 58,
                          alignItems: "center",
                          fontSize: 24,
                          fontWeight: 600,
                          color: s.mutedText,
                          borderBottom: `1px solid ${s.border}`,
                        }}
                      >
                        {p.table.columns.map((c, i) => (
                          <div key={i} style={{ width: `${(widths[i]! / widthSum) * 100}%` }}>
                            {c}
                          </div>
                        ))}
                      </div>
                      {p.table.rows.slice(0, shownRows).map((row, ri) => (
                        <div
                          key={ri}
                          style={{
                            display: "flex",
                            height: ROW,
                            alignItems: "center",
                            fontSize: 26,
                            borderBottom: `1px solid ${s.border}`,
                          }}
                        >
                          {row.map((cell, ci) => (
                            <div
                              key={ci}
                              style={{
                                width: `${(widths[ci]! / widthSum) * 100}%`,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                paddingRight: 16,
                                color: tinted(
                                  t.rowAt(ri),
                                  ci === 0 ? s.text : ci === row.length - 1 ? p.accent : s.mutedText,
                                ),
                                fontWeight: ci === 0 ? 500 : 400,
                                fontVariantNumeric: "tabular-nums",
                              }}
                            >
                              {cell}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </VelocityBlur>
            </div>
            <div
              style={{
                position: "absolute",
                left: 40,
                right: 40,
                bottom: 32,
                height: 84,
                borderRadius: 24,
                border: `1px solid ${s.border}`,
                background: s.card,
                boxShadow: s.shadow.md,
                display: "flex",
                alignItems: "center",
                padding: "0 28px",
                fontSize: 28,
                color: s.faintText,
              }}
            >
              {p.followUp ?? ""}
              <div
                style={{
                  marginLeft: "auto",
                  width: 52,
                  height: 52,
                  borderRadius: 52,
                  background: s.muted,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="arrow" size={26} color={s.faintText} stroke={2.2} />
              </div>
            </div>
          </Window>
        </div>
      </div>
    </Ground>
  );
};

/** muse's answer entry: a typing pill fills with the accent, stretches into a bar, the reply card wipes through it and grows with its lines. */
const PillAnswer: React.FC<{
  p: AiChatProps;
  s: ReturnType<typeof surface>;
  frame: number;
  answerAt: number;
  barW: number;
  maxW: number;
  font: number;
}> = ({ p, s, frame, answerAt, barW, maxW, font }) => {
  const st = pillState(frame, answerAt);
  const pillW = 110;
  const pillH = 56;
  const w = pillW + (barW - pillW) * st.stretch;
  const grown = progress(frame, answerAt, 10, "expoOut");
  const cardW = w + (maxW - w) * grown;
  const dots = st.stretch <= 0;
  return (
    <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 52,
          background: p.accent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          opacity: progress(frame, st.typingAt, 6, "linear"),
        }}
      >
        <Icon name="sparkle" size={28} color="#FFFFFF" stroke={2} />
      </div>
      <div style={{ position: "relative", width: frame >= answerAt ? cardW : w, minHeight: pillH }}>
        {st.wipe < 1 ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: w,
              height: pillH,
              borderRadius: pillH / 2,
              background: s.muted,
              overflow: "hidden",
              opacity: progress(frame, st.typingAt, 4, "linear"),
            }}
          >
            <div style={{ position: "absolute", inset: 0, background: p.accent, opacity: st.fill }} />
            {dots
              ? [0, 1, 2].map((k) => (
                  <div
                    key={k}
                    style={{
                      position: "absolute",
                      top: pillH / 2 - 6 + Math.sin(((frame - st.typingAt) / 8 - k / 3) * Math.PI * 2) * 3,
                      left: pillW / 2 - 26 + k * 20,
                      width: 12,
                      height: 12,
                      borderRadius: 12,
                      background: st.fill > 0.5 ? "#FFFFFF" : s.faintText,
                    }}
                  />
                ))
              : null}
          </div>
        ) : null}
        {frame >= st.wipeAt ? (
          <div
            style={{
              position: frame >= answerAt ? "relative" : "absolute",
              left: 0,
              top: 0,
              width: "100%",
              minHeight: pillH,
              height: frame < answerAt ? pillH : undefined,
              overflow: "hidden",
              whiteSpace: frame < answerAt ? "nowrap" : undefined,
              boxSizing: "border-box",
              padding: "14px 28px",
              borderRadius: 28,
              background: s.card,
              border: `1px solid ${s.border}`,
              boxShadow: s.shadow.md,
              WebkitMaskImage:
                st.wipe < 1
                  ? `linear-gradient(90deg, #000 ${st.wipe * 160 - 60}%, transparent ${st.wipe * 160}%)`
                  : undefined,
              maskImage:
                st.wipe < 1
                  ? `linear-gradient(90deg, #000 ${st.wipe * 160 - 60}%, transparent ${st.wipe * 160}%)`
                  : undefined,
              fontSize: font,
              lineHeight: 1.45,
              letterSpacing: "-0.01em",
            }}
          >
            {p.answerLabel ? (
              <div style={{ fontSize: 22, color: s.faintText, marginBottom: 6, lineHeight: 1.3, whiteSpace: "nowrap" }}>
                {p.answerLabel}
              </div>
            ) : null}
            {frame >= st.wipeAt
              ? streamWords(p.answer, frame, st.wipeAt, p.wordsPerFrame).map(({ w: word, o, key }) => (
                  <span key={key} style={{ opacity: o }}>
                    {word}
                  </span>
                ))
              : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};
