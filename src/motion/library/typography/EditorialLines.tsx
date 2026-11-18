import React from "react";
import { Easing, useCurrentFrame } from "remotion";
import { z } from "zod";
import { primaryFont, serifFont } from "../../../lib/fonts";
import { MaskedLine } from "../../text";
import { progress } from "../../timing";

const EXIT = Easing.bezier(0.6, 0, 0.9, 0.35);
import { useSharedFit } from "./fit";
import { Stage, useSafeArea } from "./Stage";

export const editorialLinesSchema = z.object({
  kicker: z.string(),
  /** Hand-set lines; one of them is set in serif italic in the accent colour. */
  lines: z.array(z.string()).min(1),
  accentLine: z.number().int(),
  /** Lines used in a vertical frame instead, where narrow breaks read better. */
  verticalLines: z.array(z.string()),
  verticalAccentLine: z.number().int(),
  color: z.string(),
  accent: z.string(),
  muted: z.string(),
  background: z.string(),
  /** Frame the type starts to arrive. */
  at: z.number(),
  /** Frames between lines. */
  step: z.number(),
  /** Frame the lines sink back behind their masks; -1 keeps them. */
  exitAt: z.number(),
  align: z.enum(["left", "centre"]),
});

export type EditorialLinesProps = z.infer<typeof editorialLinesSchema>;

const LINE_HEIGHT = 0.98;

/**
 * Editorial headline: a kicker, then each line rises from behind its own mask on a tight stagger, one line in serif
 * italic for contrast, a hairline rule drawing underneath. Lines sink back on the exit in the same order.
 */
export const EditorialLines: React.FC<EditorialLinesProps> = ({
  kicker,
  lines,
  accentLine,
  verticalLines,
  verticalAccentLine,
  color,
  accent,
  muted,
  background,
  at,
  step,
  exitAt,
  align,
}) => {
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const set = safe.vertical && verticalLines.length > 0 ? verticalLines : lines;
  const accentIndex = safe.vertical && verticalLines.length > 0 ? verticalAccentLine : accentLine;
  const runFor = (index: number) =>
    index === accentIndex
      ? { fontFamily: serifFont, fontWeight: 400, letterSpacing: "-0.01em" }
      : { fontFamily: primaryFont, fontWeight: 700, letterSpacing: "-0.045em" };
  const maxSize = safe.vertical ? safe.width * 0.2 : safe.height * 0.2;
  const size = useSharedFit(
    set.map((text, index) => ({ text, ...runFor(index) })),
    safe.width * (safe.vertical ? 0.98 : 0.86),
    maxSize,
  );
  if (size === null) return <Stage background={background}>{null}</Stage>;

  const leaving = exitAt >= 0 && frame >= exitAt;
  const revealFor = (order: number, duration: number) => {
    const inT = progress(frame, at + order * step, duration, "expoOut");
    if (!leaving) return inT;
    return inT * (1 - progress(frame, exitAt + order * Math.max(step - 2, 1), 16, EXIT));
  };
  const rule =
    progress(frame, at + 10 + set.length * step, 34, "expoOut") * (leaving ? 1 - progress(frame, exitAt, 14, EXIT) : 1);
  const centred = align === "centre";
  const kickerSize = Math.max(28, size * 0.17);

  return (
    <Stage background={background}>
      <div
        style={{
          position: "absolute",
          left: safe.side,
          right: safe.side,
          top: safe.top,
          bottom: safe.bottom,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: centred ? "center" : "flex-start",
          textAlign: centred ? "center" : "left",
        }}
      >
        {kicker ? (
          <MaskedLine
            reveal={revealFor(0, 22)}
            lineHeight={1.2}
            style={{
              fontFamily: primaryFont,
              fontWeight: 600,
              fontSize: kickerSize,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: muted,
              marginBottom: size * 0.32,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "1.6em",
                height: 2,
                background: accent,
                verticalAlign: "middle",
                marginRight: "0.8em",
                transform: "translateY(-0.3em)",
              }}
            />
            {kicker}
          </MaskedLine>
        ) : null}
        {set.map((line, index) => {
          const run = runFor(index);
          const isAccent = index === accentIndex;
          return (
            <MaskedLine
              key={`${index}-${line}`}
              reveal={revealFor(index + 1, 28)}
              lineHeight={LINE_HEIGHT}
              style={{
                fontSize: size,
                fontFamily: run.fontFamily,
                fontWeight: run.fontWeight,
                letterSpacing: run.letterSpacing,
                color: isAccent ? accent : color,
                fontStyle: isAccent ? "italic" : "normal",
              }}
            >
              {line}
            </MaskedLine>
          );
        })}
        <div
          style={{
            marginTop: size * 0.38,
            height: Math.max(2, size * 0.018),
            width: safe.vertical ? safe.width * 0.5 : safe.width * 0.34,
            background: `linear-gradient(90deg, ${accent}, ${muted})`,
            transform: `scaleX(${rule})`,
            transformOrigin: centred ? "50% 50%" : "0% 50%",
            opacity: 0.9,
          }}
        />
      </div>
    </Stage>
  );
};

export const editorialLinesDefaults: EditorialLinesProps = {
  kicker: "",
  lines: ["Every frame", "deliberate,", "nothing by chance."],
  accentLine: 1,
  verticalLines: ["Every", "frame", "deliberate,", "nothing", "by chance."],
  verticalAccentLine: 2,
  color: "#151412",
  accent: "#D9441C",
  muted: "rgba(21,20,18,0.55)",
  background: "#F2EDE4",
  at: 4,
  step: 5,
  exitAt: 112,
  align: "left",
};
