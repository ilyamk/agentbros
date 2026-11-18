import React from "react";
import { z } from "zod";
import { primaryFont, serifFont } from "../../../lib/fonts";
import { SplitText, toFrame, useFontsReady, useGsapTimeline } from "../../gsap";
import type { Cue } from "../types";
import { useSharedFit } from "../typography/fit";
import { Stage, useSafeArea } from "../typography/Stage";

export const splitRevealSchema = z.object({
  /** Hand-set lines. Wrap one word in *asterisks* to set it in serif italic accent. */
  lines: z.array(z.string()).min(1),
  /** Lines for a vertical frame; empty to reuse `lines`. */
  verticalLines: z.array(z.string()),
  /** What staggers: every glyph, every word or every line. */
  unit: z.enum(["chars", "words", "lines"]),
  ease: z.enum(["kinetic.out", "kinetic.snap", "expo.out", "back.out(1.6)"]),
  color: z.string(),
  accent: z.string(),
  background: z.string(),
  fontWeight: z.number().int().min(300).max(900),
  /** Frame the first unit starts to rise. */
  at: z.number().nonnegative(),
  /** Seconds between neighbouring units. */
  stagger: z.number().nonnegative(),
  /** Seconds one unit takes to settle. */
  duration: z.number().positive(),
  /** Frame the lines drop out through their masks; -1 keeps them. */
  exitAt: z.number(),
});

export type SplitRevealProps = z.infer<typeof splitRevealSchema>;

const parse = (line: string) =>
  line
    .split(/(\*[^*]+\*)/)
    .filter(Boolean)
    .map((part) => (part.startsWith("*") ? { text: part.slice(1, -1), accent: true } : { text: part, accent: false }));

const unitCount = (lines: string[], unit: SplitRevealProps["unit"]): number => {
  const plain = lines.map((line) => line.replaceAll("*", ""));
  if (unit === "lines") return plain.length;
  if (unit === "words") return plain.reduce((sum, line) => sum + line.split(/\s+/).filter(Boolean).length, 0);
  return plain.reduce((sum, line) => sum + [...line.replace(/\s+/g, "")].length, 0);
};

/** Label times in seconds, shared by the timeline and the cues. Vertical uses `verticalLines` when it has any. */
export const splitRevealPlan = (props: SplitRevealProps, vertical = false) => {
  const set = vertical && props.verticalLines.length > 0 ? props.verticalLines : props.lines;
  const units = unitCount(set, props.unit);
  const start = props.at / 30;
  return {
    start,
    settled: start + Math.max(0, units - 1) * props.stagger + props.duration * 0.6,
    exit: props.exitAt >= 0 ? props.exitAt / 30 : -1,
  };
};

export const splitRevealCues = (props: SplitRevealProps): Cue[] => {
  const plan = splitRevealPlan(props);
  const cues: Cue[] = [
    { frame: toFrame(plan.start), kind: "reveal", sfx: "whoosh", weight: "support", label: "in" },
    { frame: toFrame(plan.settled), kind: "land", sfx: "click", weight: "hero", label: "settled" },
  ];
  if (plan.exit >= 0)
    cues.push({ frame: toFrame(plan.exit), kind: "exit", sfx: "whoosh", weight: "support", label: "out" });
  return cues;
};

/**
 * GSAP SplitText headline: glyphs, words or lines rise out of per-line masks on a custom-eased stagger, with a small
 * tilt that straightens as they land, and drop back through the masks on exit.
 */
export const SplitReveal: React.FC<SplitRevealProps> = (props) => {
  const { lines, verticalLines, unit, ease, color, accent, background, fontWeight } = props;
  const safe = useSafeArea();
  const set = safe.vertical && verticalLines.length > 0 ? verticalLines : lines;
  const size = useSharedFit(
    set.map((line) => ({
      text: line.replaceAll("*", ""),
      fontFamily: primaryFont,
      fontWeight,
      letterSpacing: "-0.04em",
    })),
    safe.width * (safe.vertical ? 0.96 : 0.84),
    safe.vertical ? safe.width * 0.24 : safe.height * 0.3,
  );
  const serifReady = useFontsReady([`italic 400 100px ${serifFont}`]);
  const plan = splitRevealPlan(props, safe.vertical);
  const scope = useGsapTimeline<HTMLDivElement>(
    ({ timeline, scope: root }) => {
      const split = SplitText.create(root.querySelectorAll("[data-line]"), {
        type: "lines,words,chars",
        mask: "lines",
        linesClass: "kl",
      });
      const targets = unit === "chars" ? split.chars : unit === "words" ? split.words : split.lines;
      timeline.addLabel("in", plan.start).addLabel("settled", plan.settled);
      timeline.from(
        targets,
        {
          yPercent: 118,
          rotate: unit === "lines" ? 0 : 7,
          transformOrigin: "0% 100%",
          duration: props.duration,
          ease,
          stagger: props.stagger,
        },
        "in",
      );
      if (plan.exit >= 0) {
        timeline.addLabel("out", plan.exit);
        timeline.to(split.lines, { yPercent: -112, duration: 0.5, ease: "kinetic.in", stagger: 0.06 }, "out");
      }
    },
    { dependencies: [size, serifReady, JSON.stringify(props), safe.vertical] },
  );
  if (size === null || !serifReady) return <Stage background={background}>{null}</Stage>;
  return (
    <Stage background={background}>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div
          ref={scope}
          style={{
            fontFamily: primaryFont,
            fontWeight,
            fontSize: size,
            lineHeight: 1.02,
            letterSpacing: "-0.04em",
            color,
            textAlign: "center",
          }}
        >
          {set.map((line, index) => (
            <div key={index} data-line>
              {parse(line).map((part, at) =>
                part.accent ? (
                  <span
                    key={at}
                    style={{
                      fontFamily: serifFont,
                      fontStyle: "italic",
                      fontWeight: 400,
                      letterSpacing: "-0.02em",
                      color: accent,
                    }}
                  >
                    {part.text}
                  </span>
                ) : (
                  <React.Fragment key={at}>{part.text}</React.Fragment>
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </Stage>
  );
};

export const splitRevealDefaults: SplitRevealProps = {
  lines: ["Every frame,", "*on purpose.*"],
  verticalLines: ["Every", "frame,", "*on purpose.*"],
  unit: "chars",
  ease: "kinetic.out",
  color: "#111111",
  accent: "#3d5afe",
  background: "#f3f1ec",
  fontWeight: 700,
  at: 8,
  stagger: 0.028,
  duration: 0.95,
  exitAt: 108,
};
