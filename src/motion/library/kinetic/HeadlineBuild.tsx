import React from "react";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { toFrame, useGsapTimeline } from "../../gsap";
import { audioReactSchema, useAudioReact } from "../../sync/curves";
import type { Cue } from "../types";
import { useSharedFit } from "../typography/fit";
import { Stage, useSafeArea } from "../typography/Stage";

export const headlineBuildSchema = z.object({
  /** Small pill above the headline; empty for none. */
  chip: z.string(),
  /** Headline lines. `*word*` gets a highlight swiped in behind it, `_word_` a hand-drawn underline. */
  lines: z.array(z.string()).min(1),
  verticalLines: z.array(z.string()),
  /** Line under the headline; empty for none. */
  subline: z.string(),
  /** Call-to-action pill; empty for none. */
  cta: z.string(),
  color: z.string(),
  muted: z.string(),
  accent: z.string(),
  /** Ink on the highlight and the CTA. */
  onAccent: z.string(),
  background: z.string(),
  at: z.number().nonnegative(),
  /** Seconds between headline words. */
  stagger: z.number().nonnegative(),
  /** Off unless set: the type's brightness follows the music, read from an AudioCurvesProvider above. `curve` defaults to "energy" (smoothed over 4 frames), `amount` to 0.04, at most 0.06: brightness swings ±amount around 1, so it shows on the highlight and on light ink, hardly on near-black. */
  react: audioReactSchema(0.06).optional(),
});

export type HeadlineBuildProps = z.infer<typeof headlineBuildSchema>;

type Word = { text: string; mark: "highlight" | "underline" | null };
const words = (line: string): Word[] =>
  line
    .split(/\s+/)
    .filter(Boolean)
    .map((token) =>
      /^\*.+\*[.,!?]?$/.test(token)
        ? { text: token.replaceAll("*", ""), mark: "highlight" }
        : /^_.+_[.,!?]?$/.test(token)
          ? { text: token.replaceAll("_", ""), mark: "underline" }
          : { text: token, mark: null },
    );

/** Label times in seconds: one timeline places every element, and the cues read the same numbers. */
export const headlineBuildPlan = (props: HeadlineBuildProps, vertical = false) => {
  const set = vertical && props.verticalLines.length > 0 ? props.verticalLines : props.lines;
  const all = set.flatMap(words);
  const chip = props.at / 30;
  const headline = props.chip ? chip + 0.3 : chip;
  const settled = headline + Math.max(0, all.length - 1) * props.stagger + 0.6;
  const highlight = all.some((word) => word.mark === "highlight") ? settled - 0.1 : -1;
  const underline = all.some((word) => word.mark === "underline") ? settled + (highlight >= 0 ? 0.35 : -0.1) : -1;
  const sub = props.subline ? Math.max(settled, highlight, underline) + 0.25 : -1;
  const cta = props.cta ? Math.max(settled, highlight, underline, sub) + 0.45 : -1;
  return { chip, headline, settled, highlight, underline, sub, cta };
};

export const headlineBuildCues = (props: HeadlineBuildProps): Cue[] => {
  const plan = headlineBuildPlan(props);
  const cues: Cue[] = [];
  if (props.chip)
    cues.push({ frame: toFrame(plan.chip), kind: "reveal", sfx: "pop", weight: "support", label: "chip" });
  cues.push({ frame: toFrame(plan.headline), kind: "reveal", sfx: "whoosh", weight: "support", label: "headline" });
  if (plan.highlight >= 0)
    cues.push({ frame: toFrame(plan.highlight), kind: "hit", sfx: "whoosh", weight: "hero", label: "highlight" });
  if (plan.underline >= 0)
    cues.push({
      frame: toFrame(plan.underline),
      kind: "hit",
      sfx: "tick",
      weight: plan.highlight >= 0 ? "support" : "hero",
      label: "underline",
    });
  if (plan.sub >= 0)
    cues.push({ frame: toFrame(plan.sub), kind: "reveal", sfx: "none", weight: "support", label: "sub" });
  if (plan.cta >= 0)
    cues.push({ frame: toFrame(plan.cta), kind: "land", sfx: "click", weight: "support", label: "cta" });
  return cues;
};

/**
 * A launch headline built on one GSAP timeline: a chip pops, the words rise out of their masks, a highlight swipes in
 * behind one word, a hand-drawn underline draws under another, then the subline and a CTA pill land. For a hero
 * statement where every element needs its own beat.
 */
export const HeadlineBuild: React.FC<HeadlineBuildProps> = (props) => {
  const { chip, lines, verticalLines, subline, cta, color, muted, accent, onAccent, background } = props;
  const safe = useSafeArea();
  const set = safe.vertical && verticalLines.length > 0 ? verticalLines : lines;
  const size = useSharedFit(
    set.map((line) => ({
      text: line.replace(/[*_]/g, ""),
      fontFamily: primaryFont,
      fontWeight: 700,
      letterSpacing: "-0.04em",
    })),
    safe.width * (safe.vertical ? 0.92 : 0.8),
    safe.vertical ? safe.width * 0.2 : safe.height * 0.19,
  );
  const plan = headlineBuildPlan(props, safe.vertical);
  const audio = useAudioReact(props.react, ["energy", "level"], 4);
  const scope = useGsapTimeline<HTMLDivElement>(
    ({ timeline, selector }) => {
      timeline.addLabel("headline", plan.headline).addLabel("settled", plan.settled);
      if (chip) {
        timeline.addLabel("chip", plan.chip);
        timeline.fromTo(
          selector("[data-chip]"),
          { scale: 0.6, opacity: 0 },
          { scale: 1, opacity: 1, duration: 0.5, ease: "back.out(2)" },
          "chip",
        );
      }
      timeline.fromTo(
        selector("[data-word]"),
        { yPercent: 115 },
        { yPercent: 0, duration: 0.8, ease: "kinetic.out", stagger: props.stagger },
        "headline",
      );
      if (plan.highlight >= 0) {
        timeline.addLabel("highlight", plan.highlight);
        timeline.fromTo(
          selector("[data-highlight]"),
          { scaleX: 0, transformOrigin: "0% 50%" },
          { scaleX: 1, duration: 0.5, ease: "kinetic.inOut" },
          "highlight",
        );
        timeline.fromTo(
          selector("[data-highlight-word]"),
          { color },
          { color: onAccent, duration: 0.2, ease: "none" },
          plan.highlight + 0.22,
        );
      }
      if (plan.underline >= 0) {
        timeline.addLabel("underline", plan.underline);
        timeline.fromTo(
          selector("[data-underline]"),
          { drawSVG: "0% 0%" },
          { drawSVG: "0% 100%", duration: 0.55, ease: "kinetic.inOut" },
          "underline",
        );
      }
      if (plan.sub >= 0) {
        timeline.addLabel("sub", plan.sub);
        timeline.fromTo(
          selector("[data-sub]"),
          { yPercent: 110 },
          { yPercent: 0, duration: 0.7, ease: "kinetic.out" },
          "sub",
        );
      }
      if (plan.cta >= 0) {
        timeline.addLabel("cta", plan.cta);
        timeline.fromTo(
          selector("[data-cta]"),
          { y: 40, opacity: 0, scale: 0.9 },
          { y: 0, opacity: 1, scale: 1, duration: 0.6, ease: "kinetic.snap" },
          "cta",
        );
      }
    },
    { dependencies: [size, JSON.stringify(props), safe.vertical] },
  );
  if (size === null) return <Stage background={background}>{null}</Stage>;
  const small = Math.max(26, size * 0.24);
  const body = (
    <div
      ref={scope}
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: primaryFont,
        textAlign: "center",
      }}
    >
      {chip ? (
        <div
          data-chip
          style={{
            display: "flex",
            alignItems: "center",
            gap: small * 0.45,
            padding: `${small * 0.32}px ${small * 0.7}px`,
            borderRadius: 999,
            border: `1.5px solid ${muted}55`,
            color,
            fontSize: small * 0.95,
            fontWeight: 500,
            marginBottom: size * 0.35,
            opacity: 0,
          }}
        >
          <span style={{ width: small * 0.36, height: small * 0.36, borderRadius: 99, background: accent }} />
          {chip}
        </div>
      ) : null}
      <div style={{ fontSize: size, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.08, color }}>
        {set.map((line, row) => (
          <div key={row} style={{ whiteSpace: "nowrap" }}>
            {words(line).map((word, index) => (
              <React.Fragment key={index}>
                {index > 0 ? " " : null}
                <span style={{ position: "relative", display: "inline-block" }}>
                  {word.mark === "highlight" ? (
                    <span
                      data-highlight
                      style={{
                        position: "absolute",
                        left: "-0.08em",
                        right: "-0.08em",
                        top: "0.1em",
                        bottom: "0.02em",
                        background: accent,
                        borderRadius: "0.08em",
                      }}
                    />
                  ) : null}
                  <span
                    style={{
                      position: "relative",
                      display: "inline-block",
                      overflow: "hidden",
                      verticalAlign: "top",
                      padding: "0 0.02em 0.08em",
                      margin: "0 -0.02em -0.08em",
                    }}
                  >
                    <span
                      data-word
                      {...(word.mark === "highlight" ? { "data-highlight-word": true } : {})}
                      style={{ display: "inline-block" }}
                    >
                      {word.text}
                    </span>
                  </span>
                  {word.mark === "underline" ? (
                    <svg
                      viewBox="0 0 200 20"
                      preserveAspectRatio="none"
                      style={{
                        position: "absolute",
                        left: "-2%",
                        width: "104%",
                        bottom: "-0.12em",
                        height: "0.22em",
                        overflow: "visible",
                      }}
                    >
                      <path
                        data-underline
                        d="M3,12 C40,5 90,4 130,8 C160,11 182,9 197,6"
                        fill="none"
                        stroke={accent}
                        strokeWidth={5}
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                        style={{ strokeWidth: Math.max(4, size * 0.05) }}
                      />
                    </svg>
                  ) : null}
                </span>
              </React.Fragment>
            ))}
          </div>
        ))}
      </div>
      {subline ? (
        <div style={{ overflow: "hidden", marginTop: size * 0.4, paddingBottom: small * 0.1 }}>
          <div data-sub style={{ fontSize: small, fontWeight: 500, color: muted, letterSpacing: "-0.01em" }}>
            {subline}
          </div>
        </div>
      ) : null}
      {cta ? (
        <div
          data-cta
          style={{
            marginTop: size * 0.4,
            padding: `${small * 0.5}px ${small * 1.1}px`,
            borderRadius: 999,
            background: color,
            color: background,
            fontSize: small * 0.85,
            fontWeight: 600,
            opacity: 0,
          }}
        >
          {cta}
        </div>
      ) : null}
    </div>
  );
  // The filter sits outside the GSAP scope: the timeline never sees the per-frame value.
  return (
    <Stage background={background}>
      {audio ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            filter: `brightness(${1 + 2 * (audio.amount ?? 0.04) * (audio.value - 0.5)})`,
          }}
        >
          {body}
        </div>
      ) : (
        body
      )}
    </Stage>
  );
};

export const headlineBuildDefaults: HeadlineBuildProps = {
  chip: "New in 4.0",
  lines: ["Ship the *whole* film", "before _lunch._"],
  verticalLines: ["Ship the", "*whole* film", "before _lunch._"],
  subline: "Scripts, cuts and sound on one timeline.",
  cta: "Start building",
  color: "#111111",
  muted: "#6b6f76",
  accent: "#c6f432",
  onAccent: "#111111",
  background: "#f3f1ec",
  at: 6,
  stagger: 0.07,
};
