import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";
import React from "react";
import { z } from "zod";
import { primaryFont } from "../../../lib/fonts";
import { toFrame, useFontsReady, useGsapTimeline } from "../../gsap";
import type { Cue } from "../types";
import { useSharedFit } from "../typography/fit";
import { Stage, useSafeArea } from "../typography/Stage";

const { fontFamily: monoFont } = loadGeistMono("normal", { weights: ["500"], subsets: ["latin"] });

export const decodeSchema = z.object({
  /** Small mono line that decodes first; empty for none. */
  kicker: z.string(),
  /** Headline lines that decode glyph by glyph, left to right. */
  lines: z.array(z.string()).min(1),
  verticalLines: z.array(z.string()),
  color: z.string(),
  /** Colour of a glyph while it is still scrambling. */
  accent: z.string(),
  muted: z.string(),
  background: z.string(),
  /** Glyphs the scramble draws from. */
  glyphs: z.string().min(2),
  /** Fixed-width slots for glyph pools whose characters should stay evenly spaced. */
  monospace: z.boolean().optional(),
  /** Seed of the scramble; change it for a different but equally repeatable pattern. */
  seed: z.string(),
  at: z.number().nonnegative(),
  /** Seconds between neighbouring glyphs locking. */
  stagger: z.number().nonnegative(),
  /** Seconds one glyph scrambles before it locks. */
  scramble: z.number().positive(),
  /** Frame the text scrambles away again; -1 keeps it. */
  exitAt: z.number(),
});

export type DecodeProps = z.infer<typeof decodeSchema>;

const glyphCount = (lines: string[]) => lines.reduce((sum, line) => sum + [...line.replace(/\s+/g, "")].length, 0);

export const decodePlan = (props: DecodeProps, vertical = false) => {
  const set = vertical && props.verticalLines.length > 0 ? props.verticalLines : props.lines;
  const kickerIn = props.at / 30;
  const kickerLen = [...props.kicker].length;
  const headline = props.kicker ? kickerIn + Math.min(0.5, kickerLen * 0.012 + 0.25) : kickerIn;
  const locked = headline + Math.max(0, glyphCount(set) - 1) * props.stagger + props.scramble;
  return { kickerIn, headline, locked, exit: props.exitAt >= 0 ? props.exitAt / 30 : -1 };
};

export const decodeCues = (props: DecodeProps): Cue[] => {
  const plan = decodePlan(props);
  const cues: Cue[] = [];
  if (props.kicker)
    cues.push({ frame: toFrame(plan.kickerIn), kind: "type", sfx: "tick", weight: "support", label: "kicker" });
  cues.push({ frame: toFrame(plan.headline), kind: "type", sfx: "tick", weight: "support", label: "headline" });
  cues.push({ frame: toFrame(plan.locked), kind: "land", sfx: "click", weight: "hero", label: "locked" });
  if (plan.exit >= 0)
    cues.push({ frame: toFrame(plan.exit), kind: "exit", sfx: "tick", weight: "support", label: "out" });
  return cues;
};

/** One glyph slot: the final glyph holds the width invisibly, the scramble sits on top of it. */
const Slot: React.FC<{ char: string }> = ({ char }) =>
  char.trim() === "" ? (
    <span>{char}</span>
  ) : (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span style={{ visibility: "hidden" }}>{char}</span>
      <span
        data-glyph={char}
        style={{ position: "absolute", left: "50%", top: 0, transform: "translateX(-50%)", whiteSpace: "pre" }}
      />
    </span>
  );

/**
 * Seeded scramble decode: a mono kicker types itself in, then each headline glyph cycles through random characters in
 * the accent colour and locks into the ink left to right. Repeatable frame for frame: the glyphs come from `random(seed)`.
 */
export const Decode: React.FC<DecodeProps> = (props) => {
  const { kicker, lines, verticalLines, color, accent, muted, background, glyphs, seed } = props;
  const safe = useSafeArea();
  const set = safe.vertical && verticalLines.length > 0 ? verticalLines : lines;
  const fontFamily = props.monospace ? monoFont : primaryFont;
  const fontWeight = props.monospace ? 500 : 700;
  const letterSpacing = props.monospace ? "0" : "-0.035em";
  const size = useSharedFit(
    set.map((text) => ({ text, fontFamily, fontWeight, letterSpacing })),
    safe.width * (safe.vertical ? 0.94 : 0.8),
    safe.vertical ? safe.width * 0.2 : safe.height * 0.24,
  );
  const monoReady = useFontsReady([`500 40px ${monoFont}`]);
  const plan = decodePlan(props, safe.vertical);
  const scope = useGsapTimeline<HTMLDivElement>(
    ({ timeline, selector }) => {
      const kickerEl = selector("[data-kicker]");
      const heads = selector("[data-head] [data-glyph]") as HTMLElement[];
      timeline.addLabel("kicker", plan.kickerIn).addLabel("headline", plan.headline).addLabel("locked", plan.locked);
      if (kicker)
        timeline.to(
          kickerEl,
          {
            decodeText: { text: kicker, seed: `${seed}-k`, chars: glyphs, flips: 10 },
            duration: plan.headline - plan.kickerIn + 0.2,
            ease: "none",
          },
          "kicker",
        );
      heads.forEach((glyph, index) => {
        const at = plan.headline + index * props.stagger;
        timeline.to(
          glyph,
          {
            decodeText: {
              text: glyph.dataset.glyph ?? "",
              seed: `${seed}-${index}`,
              chars: glyphs,
              flips: Math.max(3, Math.round(props.scramble * 18)),
            },
            duration: props.scramble,
            ease: "none",
          },
          at,
        );
        timeline.fromTo(glyph, { color: accent }, { color, duration: 0.14, ease: "power2.out" }, at + props.scramble);
      });
      if (plan.exit >= 0) {
        timeline.addLabel("out", plan.exit);
        heads.forEach((glyph, index) => {
          timeline.to(
            glyph,
            {
              decodeText: {
                text: glyph.dataset.glyph ?? "",
                seed: `${seed}-x${index}`,
                chars: glyphs,
                flips: 5,
                out: true,
              },
              duration: 0.3,
              ease: "none",
            },
            plan.exit + index * props.stagger * 0.5,
          );
        });
        if (kicker) timeline.to(kickerEl, { opacity: 0, duration: 0.25, ease: "kinetic.in" }, "out");
      }
    },
    { dependencies: [size, monoReady, JSON.stringify(props), safe.vertical] },
  );
  if (size === null || !monoReady) return <Stage background={background}>{null}</Stage>;
  return (
    <Stage background={background}>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div
          ref={scope}
          style={{ display: "flex", flexDirection: "column", alignItems: safe.vertical ? "center" : "flex-start" }}
        >
          {kicker ? (
            <div
              data-kicker
              style={{
                fontFamily: monoFont,
                fontWeight: 500,
                fontSize: Math.max(24, size * 0.2),
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: muted,
                marginBottom: size * 0.28,
                whiteSpace: "pre",
                minHeight: "1.2em",
              }}
            />
          ) : null}
          <div
            data-head
            style={{
              fontFamily,
              fontWeight,
              fontSize: size,
              lineHeight: 1.02,
              letterSpacing,
              color,
              textAlign: safe.vertical ? "center" : "left",
            }}
          >
            {set.map((line, index) => (
              <div key={index} style={{ whiteSpace: "pre" }}>
                {[...line].map((char, at) => (
                  <Slot key={at} char={char} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Stage>
  );
};

export const decodeDefaults: DecodeProps = {
  kicker: "// release 4.0 — now shipping",
  lines: ["Signal,", "not noise."],
  verticalLines: ["Signal,", "not", "noise."],
  color: "#f4f4f0",
  accent: "#7cff6b",
  muted: "#8a8f98",
  background: "#0b0c0e",
  glyphs: "ABCDEFGHJKLMNPRSTUVXYZ0123456789#$%&*+<>/",
  seed: "decode",
  at: 6,
  stagger: 0.045,
  scramble: 0.42,
  exitAt: 112,
};

export const binaryTextPreset = {
  ...decodeDefaults,
  kicker: "",
  lines: ["SIGNAL"],
  verticalLines: ["SIGNAL"],
  glyphs: "01",
  monospace: true,
  seed: "binary-signal",
  color: "#F2F4DE",
  accent: "#789760",
  background: "#18261F",
  at: 5,
  stagger: 1 / 30,
  scramble: 8 / 30,
  exitAt: -1,
} satisfies DecodeProps;
