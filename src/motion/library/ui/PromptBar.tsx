import React from "react";
import { z } from "zod";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { progress } from "../../timing";
import { Icon } from "./kit";
import { JUMP_SCALE, jumpFontSize } from "./ui-plan";
import { Caret, geist, Ground, streamEnd, streamWords, surface, typingEnd, useTyping, useUnit } from "./surface";

export const promptBarSchema = z.object({
  tone: z.enum(["light", "dark"]),
  accent: z.string(),
  placeholder: z.string(),
  query: z.string(),
  /** Empty hides the answer: the block ends on the submit. */
  answer: z.string(),
  /** Label over the answer, e.g. "Worked for 18s". */
  answerLabel: z.string(),
  /** Frame the bar starts growing in. */
  start: z.number().int().min(0),
  /** Frame the first key lands. */
  typeAt: z.number().int().min(0),
  /** Mean frames per character; 1.2-1.8 reads as a fast human. */
  pace: z.number().min(0.3),
  /** Frames between the last key and the press of send. */
  submitDelay: z.number().int().min(2),
  wordsPerFrame: z.number().min(0.05),
  /** "hero" (default): 52 px text. "reference": the real interface's scale, text about 2.6% of the height, one line. */
  scale: z.enum(["hero", "reference"]).optional(),
  /** Multiplies the type and controls inside the bar, keeping its width on screen; 1 by default, 1.3-1.6 for "reference" in vertical. */
  textScale: z.number().min(0.7).max(1.8).optional(),
  /** "grow" (default) widens in from the centre; "rise" comes up from below at full width with an ease-out; "creep" widens fast, then creeps to full width over 0.7 s (power2.out). */
  entrance: z.enum(["grow", "rise", "creep"]).optional(),
  /** A ring that spreads from send on the click. Off by default: the craft rules ban it. */
  clickRing: z.boolean().optional(),
  /** An arrow cursor travels to send and presses it; `cursorLead` frames before the click it enters. */
  cursor: z.boolean().optional(),
  cursorLead: z.number().int().min(6).optional(),
  cursorColour: z.string().optional(),
  /** Model picker label beside send, e.g. "Studio agent"; empty or absent for none. */
  model: z.string().optional(),
  /** A microphone icon beside send. */
  mic: z.boolean().optional(),
  /** After the click nothing moves: no lift, no answer, no caret, until the cut. */
  freeze: z.boolean().optional(),
  /** A flat ground colour with no light, e.g. "#FFFFFF" to match a white shot; absent keeps the tone's lit ground. */
  ground: z.string().optional(),
  /** Fill of the send button once text is typed; absent uses the tone's primary. */
  sendColour: z.string().optional(),
  /**
   * On this frame the bar drops away and its text re-sets, centred, at `jumpScale` times its size (fitted to the frame
   * width), keeping the caret and the typing; nothing else is drawn after it (ugc-app's scale jump). Absent: no jump.
   */
  jumpAt: z.number().int().min(0).optional(),
  /** Size of the text after the jump relative to the bar's; 3.5 by default. */
  jumpScale: z.number().min(1).max(8).optional(),
});

export type PromptBarProps = z.infer<typeof promptBarSchema>;

const SEED = "prompt-bar";

export const promptBarTiming = (p: PromptBarProps) => {
  const typed = typingEnd(p.query, p.typeAt, p.pace, SEED);
  const submit = typed + p.submitDelay;
  const answerAt = submit + 22;
  return { typed, submit, answerAt, answerDone: p.answer ? streamEnd(p.answer, answerAt, p.wordsPerFrame) : submit };
};

export const promptBarCues = (p: PromptBarProps) => {
  const t = promptBarTiming(p);
  return [
    {
      frame: p.start,
      kind: "land" as const,
      sfx: "whoosh" as const,
      weight: "support" as const,
      label: p.entrance === "rise" ? "bar rises" : "bar grows",
    },
    {
      frame: p.typeAt,
      kind: "type" as const,
      sfx: "tick" as const,
      weight: "support" as const,
      label: "typing starts",
    },
    ...(p.cursor
      ? [
          {
            frame: t.submit - (p.cursorLead ?? 30),
            kind: "reveal" as const,
            sfx: "none" as const,
            weight: "support" as const,
            label: "cursor enters",
          },
        ]
      : []),
    {
      frame: t.submit,
      kind: "click" as const,
      sfx: "click" as const,
      weight: "hero" as const,
      label: p.freeze ? "send, then hold still" : "send",
    },
    ...(p.answer && !p.freeze && (p.jumpAt === undefined || p.jumpAt > t.answerAt)
      ? [
          {
            frame: t.answerAt,
            kind: "reveal" as const,
            sfx: "pop" as const,
            weight: "support" as const,
            label: "answer streams",
          },
        ]
      : []),
    ...(p.jumpAt !== undefined
      ? [
          {
            frame: p.jumpAt,
            kind: "hit" as const,
            sfx: "none" as const,
            weight: "hero" as const,
            label: "text jumps in scale",
          },
        ]
      : []),
  ].filter((c) => p.jumpAt === undefined || c.frame <= p.jumpAt);
};

/** A real prompt field at the interface's own scale or hero size: it grows, types with a human rhythm, sends, lifts and streams the answer. */
export const PromptBar: React.FC<PromptBarProps> = (props) => {
  const { tone, accent, placeholder, query, answer, answerLabel, start, typeAt, pace } = props;
  const frame = useCurrentFrame();
  const unit = useUnit();
  const { width, height, portrait } = unit;
  const u = unit.u * (props.textScale ?? 1);
  const s = surface(tone, accent);
  const t = promptBarTiming(props);
  const typing = useTyping(query, typeAt, pace, SEED);

  const ref = props.scale === "reference";
  const rise = props.entrance === "rise";
  const freeze = props.freeze ?? false;
  const showAnswer = Boolean(answer) && !freeze;
  const creep = props.entrance === "creep";
  const grow = rise
    ? 1
    : creep
      ? progress(frame, start, 21, (x: number) => 1 - (1 - x) ** 3)
      : progress(frame, start, 18, "expoOut");
  const fullW =
    (ref ? (portrait ? width * 0.9 : width * 0.693) : portrait ? width * 0.9 : Math.min(width * 0.8, 1560 * u)) / u;
  const barW = fullW * (creep ? 0.6 + 0.4 * grow : 0.5 + 0.5 * grow);
  const font = ref ? 28 : portrait ? 46 : 52;
  const lineH = font * 1.35;
  const narrow = !ref && width < height * 1.4;
  const lines = narrow ? Math.max(1, Math.ceil((typing.shown.length * font * 0.52) / (barW - 220))) : 1;
  const barH = ref ? 76 : 52 + lineH * lines;
  const sendSize = ref ? 50 : 84;
  const lift = showAnswer ? progress(frame, t.submit + 4, 22, "inOut") : 0;
  const centreY =
    height / u / 2 - barH / 2 + (rise ? (1 - progress(frame, start, 21, "expoOut")) * 0.2 * (height / u) : 0);
  const topY = (portrait ? 300 : 120) + 0;
  const y = centreY + (topY - centreY) * lift;
  const press = !freeze && frame >= t.submit && frame < t.submit + 5 ? 0.9 : 1;
  const padRight = ref ? 13 : 18;
  const sendX = (width / u + barW) / 2 - padRight - sendSize / 2;
  const sendY = y + barH / 2;
  const cursorIn = t.submit - (props.cursorLead ?? 30);
  const arrive = t.submit - 8;
  const cursorX =
    sendX + 4 + ((width / u) * 0.6 - sendX) * (1 - progress(frame, cursorIn, arrive - cursorIn, "expoOut"));
  const cursorY =
    sendY + 6 + ((height / u) * 0.75 - sendY) * (1 - progress(frame, cursorIn, arrive - cursorIn, "expoOut"));
  const cursorSize = ref ? 36 : 56;
  const sent = frame >= t.submit;
  // The cursor sits on whole device pixels and shrinks by size, not by a transform: at a fractional offset its edges
  // rasterised differently when a frame was reached in sequence than when it was opened directly.
  const snap = (v: number) => Math.round(v * u) / u;
  const cursorDrawn = snap(cursorSize * (sent ? 0.88 : 1));
  const ready = typing.count > 0;
  const answerIn = progress(frame, t.submit + 12, 14, "expoOut");
  const thinking = frame < t.answerAt;

  const Floor: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    props.ground ? (
      <AbsoluteFill
        style={{
          backgroundColor: props.ground,
          fontFamily: geist,
          color: s.text,
          fontFeatureSettings: '"ss01", "cv11"',
        }}
      >
        {children}
      </AbsoluteFill>
    ) : (
      <Ground s={s}>{children}</Ground>
    );

  if (props.jumpAt !== undefined && frame >= props.jumpAt) {
    const big = jumpFontSize(font, Math.max(query.length, 1), (width / u) * 0.88, props.jumpScale ?? JUMP_SCALE);
    return (
      <Floor>
        <div
          style={{
            position: "absolute",
            inset: 0,
            transform: `scale(${u})`,
            transformOrigin: "0 0",
            width: width / u,
            height: height / u,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{ fontSize: big, lineHeight: 1.2, letterSpacing: "-0.02em", color: s.text, whiteSpace: "nowrap" }}
          >
            {typing.shown}
            <Caret
              frame={frame}
              lastKey={typing.lastKey}
              color={accent}
              height={big * 0.95}
              width={Math.max(3, big * 0.06)}
            />
          </div>
        </div>
      </Floor>
    );
  }

  return (
    <Floor>
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${u})`,
          transformOrigin: "0 0",
          width: width / u,
          height: height / u,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: (width / u - barW) / 2,
            top: y,
            width: barW,
            minHeight: barH,
            opacity: Math.min(1, grow * 3),
            borderRadius: narrow ? 36 : barH / 2,
            background: s.card,
            border: `1px solid ${s.border}`,
            boxShadow: s.shadow.lg,
            display: "flex",
            alignItems: "center",
            gap: ref ? 16 : 20,
            padding: ref ? `0 ${padRight}px 0 26px` : "0 18px 0 34px",
            fontSize: font,
            letterSpacing: "-0.01em",
          }}
        >
          <Icon name="sparkle" size={ref ? 26 : 46} color={s.mutedText} stroke={1.8} />
          <div
            style={{
              flex: 1,
              lineHeight: `${lineH}px`,
              padding: ref ? 0 : "26px 0",
              overflow: "hidden",
              whiteSpace: narrow ? "normal" : "nowrap",
            }}
          >
            {ready ? (
              <span style={{ color: s.text }}>{typing.shown}</span>
            ) : (
              <span style={{ color: s.faintText }}>{placeholder}</span>
            )}
            {(!sent || !answer) && !(freeze && sent) ? (
              <Caret frame={frame} lastKey={typing.lastKey} color={accent} height={lineH * 0.8} />
            ) : null}
          </div>
          {props.model ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: font * 0.3,
                fontSize: font * 0.9,
                color: s.faintText,
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              {props.model}
              <Icon name="chevron" size={font * 0.75} color={s.faintText} stroke={2.2} />
            </div>
          ) : null}
          {props.mic ? <Icon name="mic" size={font * 1.05} color={s.mutedText} stroke={2} /> : null}
          <div
            style={{
              width: sendSize,
              height: sendSize,
              borderRadius: sendSize,
              flexShrink: 0,
              alignSelf: "flex-end",
              marginBottom: (barH - sendSize) / 2 > 14 && lines > 1 ? 14 : (barH - sendSize) / 2,
              background: ready ? (props.sendColour ?? s.primary) : s.muted,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transform: `scale(${press})`,
              boxShadow:
                props.clickRing && frame >= t.submit && frame < t.submit + 10
                  ? `0 0 0 ${(frame - t.submit) * 1.6}px ${s.accentSoft}`
                  : undefined,
            }}
          >
            <Icon
              key={sent ? "check" : "arrow"}
              name={sent ? "check" : "arrow"}
              size={ref ? 24 : 38}
              color={ready ? s.primaryText : s.faintText}
              stroke={2.4}
            />
          </div>
        </div>

        {props.cursor && frame >= cursorIn ? (
          <svg
            viewBox="0 0 24 24"
            width={cursorDrawn}
            height={cursorDrawn}
            style={{
              position: "absolute",
              left: snap(cursorX - cursorDrawn * 0.2),
              top: snap(cursorY - cursorDrawn * 0.1),
            }}
          >
            <path
              d="M5 2.5v17.2l4.6-4.4 2.9 6.6 3-1.3-2.9-6.5h6.3z"
              fill={props.cursorColour ?? "#FA5C16"}
              stroke="#FFFFFF"
              strokeWidth={1.4}
              strokeLinejoin="round"
            />
          </svg>
        ) : null}

        {showAnswer && frame >= t.submit + 12 ? (
          <div
            style={{
              position: "absolute",
              left: (width / u - fullW) / 2 + 12,
              top: topY + barH + (ref ? 36 : 48),
              width: fullW - 24,
              opacity: answerIn,
              transform: `translateY(${(1 - answerIn) * 24}px)`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                fontSize: ref ? 22 : 28,
                color: s.mutedText,
                marginBottom: ref ? 14 : 22,
              }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 12,
                  background: thinking ? accent : s.positive,
                  opacity: thinking ? 0.5 + 0.5 * Math.sin(frame / 3) : 1,
                }}
              />
              {thinking ? "Thinking" : answerLabel}
            </div>
            <div
              style={{
                fontSize: ref ? 30 : 42,
                lineHeight: 1.4,
                color: s.text,
                letterSpacing: "-0.01em",
                textWrap: "pretty",
              }}
            >
              {streamWords(answer, frame, t.answerAt, props.wordsPerFrame).map(({ w, o, key }) => (
                <span key={key} style={{ opacity: o, filter: o < 1 ? `blur(${(1 - o) * 4}px)` : undefined }}>
                  {w}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Floor>
  );
};
