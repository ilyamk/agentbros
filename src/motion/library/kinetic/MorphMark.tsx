import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { primaryFont } from "../../../lib/fonts";
import { toFrame, useFontsReady, useGsapTimeline } from "../../gsap";
import type { Cue } from "../types";
import { useTextWidths } from "../typography/fit";
import { Stage, useSafeArea } from "../typography/Stage";
import {
  TRAVEL_DISC_SHARE,
  TRAVEL_GLITCH_FOREN,
  TRAVEL_SLICES,
  morphMarkPlan,
  travelGlitchState,
  travelLayout,
  travelPlan,
  travelState,
  type MorphMarkProps,
} from "./morph-mark-math";

export {
  MORPH_MARK_WORDMARK_REVEALS,
  TRAVEL_DISC_SHARE,
  TRAVEL_FRAMES,
  TRAVEL_GLITCH_FOREN,
  morphMarkPlan,
  morphMarkSchema,
  travelGlitchState,
  travelLayout,
  travelPlan,
  travelState,
} from "./morph-mark-math";
export type { MorphMarkProps } from "./morph-mark-math";

export const morphMarkCues = (props: MorphMarkProps): Cue[] => {
  if (props.wordmarkReveal === "travel") {
    const beats = travelPlan(props.at);
    return [
      { frame: beats.grow, kind: "reveal", sfx: "pop", weight: "support", label: "disc" },
      { frame: beats.slices, kind: "hit", sfx: "click", weight: "support", label: "mark" },
      { frame: beats.travel, kind: "reveal", sfx: "whoosh", weight: "support", label: "travel" },
      { frame: beats.done, kind: "land", sfx: "impact", weight: "hero", label: "full-stop" },
    ];
  }
  const plan = morphMarkPlan(props);
  return [
    { frame: toFrame(plan.start), kind: "reveal", sfx: "pop", weight: "support", label: "pop" },
    ...plan.morphs.slice(0, -1).map((time, index): Cue => ({
      frame: toFrame(time),
      kind: "hit",
      sfx: "whoosh",
      weight: "support",
      label: `morph-${index + 1}`,
    })),
    { frame: toFrame(plan.locked), kind: "land", sfx: "impact", weight: "hero", label: "locked" },
    ...(props.wordmark
      ? [
          {
            frame: toFrame(plan.wordmark),
            kind: "reveal",
            sfx: "whoosh",
            weight: "support",
            label: "wordmark",
          } satisfies Cue,
        ]
      : []),
  ];
};

/**
 * MorphSVG mark build: a dot pops in, then morphs shape to shape (squircle, spark, any path) with a quarter-turn on
 * each change and locks into the final mark in the accent colour, and the wordmark slides out from behind it.
 * For logo stings, product icons and "idea becomes product" beats.
 */
export const MorphMark: React.FC<MorphMarkProps> = (props) =>
  props.wordmarkReveal === "travel" ? <TravelMark {...props} /> : <MorphChain {...props} />;

/**
 * foren's dot-to-wordmark, from the pure `travelState` (no timeline): a disc grows, the last shape slices in inside it,
 * the disc travels right with the word wiping in behind it and shrinks into the word's full stop.
 */
const TravelMark: React.FC<MorphMarkProps> = ({
  shapes,
  wordmark,
  color,
  accent,
  background,
  at,
  travelGlitch,
  discShare = TRAVEL_DISC_SHARE,
}) => {
  const frame = useCurrentFrame();
  const safe = useSafeArea();
  const video = useVideoConfig();
  const word = wordmark || " ";
  const widths = useTextWidths(
    [{ text: word, fontFamily: primaryFont, fontWeight: 700, letterSpacing: "-0.045em" }],
    100,
  );
  if (!widths) return <Stage background={background}>{null}</Stage>;
  // foren: the disc's diameter is 0.266 of the frame width once grown (measured F151); vertical keeps it inside the safe width.
  const discR = (safe.vertical ? safe.width * Math.min(0.4, discShare * 1.6) : video.width * discShare) / 2;
  const fontSize = Math.min(discR * 1.5, (safe.width * 0.7 * 100) / Math.max(widths[0]!, 1));
  const layout = travelLayout(video.width / 2, video.height / 2, (widths[0]! * fontSize) / 100, fontSize, discR);
  const state = travelState(frame, at, layout);
  const glitch = travelGlitch ? travelGlitchState(frame, at, travelGlitch) : { copies: [], clean: true };
  const mark = shapes.at(-1)!;
  const markSize = discR * 1.25;
  const hidden = Math.max(0, layout.textLeft + layout.textWidth - state.clipRight);
  return (
    <Stage background={background}>
      <div
        style={{
          position: "absolute",
          left: layout.textLeft,
          top: layout.cy - fontSize / 2,
          fontFamily: primaryFont,
          fontWeight: 700,
          fontSize,
          letterSpacing: "-0.045em",
          lineHeight: 1,
          color,
          whiteSpace: "pre",
          clipPath: `inset(-20% ${hidden > 0 ? hidden : -fontSize * 0.2}px -20% ${-fontSize * 0.2}px)`,
        }}
      >
        {word}
      </div>
      {state.r > 0.2 ? (
        <div
          style={{
            position: "absolute",
            left: state.x - state.r,
            top: state.y - state.r,
            width: state.r * 2,
            height: state.r * 2,
            borderRadius: "50%",
            background: accent,
          }}
        />
      ) : null}
      {state.markOn && !travelGlitch ? (
        <svg
          viewBox="0 0 200 200"
          width={markSize}
          height={markSize}
          style={{
            position: "absolute",
            left: layout.cx - markSize / 2,
            top: layout.cy - markSize / 2,
            clipPath: `inset(0 0 ${(1 - state.slices / TRAVEL_SLICES) * 100}% 0)`,
          }}
        >
          <path d={mark} fill={background} />
        </svg>
      ) : null}
      {state.markOn && travelGlitch ? (
        // foren: the slices reveal left to right, colour copies offset to the right close in, the clean mark lands last.
        <svg
          viewBox="0 0 200 200"
          width={markSize}
          height={markSize}
          style={{
            position: "absolute",
            left: layout.cx - markSize / 2,
            top: layout.cy - markSize / 2,
            overflow: "visible",
            clipPath: `inset(0 ${(1 - state.slices / TRAVEL_SLICES) * 100}% 0 -60%)`,
          }}
        >
          {glitch.copies.map((copy, i) => (
            <path key={i} d={mark} fill={copy.ink} transform={`translate(${copy.dx * 200} 0)`} />
          ))}
          {glitch.clean ? <path d={mark} fill={background} /> : null}
        </svg>
      ) : null}
    </Stage>
  );
};

const MorphChain: React.FC<MorphMarkProps> = (props) => {
  const { shapes, wordmark, color, accent, background, turns } = props;
  const safe = useSafeArea();
  const ready = useFontsReady([`700 100px ${primaryFont}`]);
  const plan = morphMarkPlan(props);
  const markSize = safe.vertical ? safe.width * 0.42 : safe.height * 0.36;
  const scope = useGsapTimeline<HTMLDivElement>(
    ({ timeline, selector }) => {
      const [mark] = selector("[data-mark]");
      const paths = selector("[data-shape]") as unknown as SVGPathElement[];
      // One path per morph, each with a single tween: chained morphSVG tweens on one path read their start shape at
      // first render, which a fresh seek past several of them gets wrong. Every tween states both ends.
      timeline.addLabel("pop", plan.start).addLabel("locked", plan.locked);
      timeline.fromTo(
        mark,
        { scale: 0, transformOrigin: "50% 50%" },
        { scale: 1, duration: 0.55, ease: "back.out(2.2)" },
        "pop",
      );
      shapes.slice(1).forEach((shape, index) => {
        const at = plan.morphs[index];
        if (index > 0) {
          timeline.set(paths[index - 1], { opacity: 0 }, at);
          timeline.set(paths[index], { opacity: 1 }, at);
        }
        timeline.fromTo(
          paths[index],
          { morphSVG: shapes[index] },
          { morphSVG: shape, duration: props.morph, ease: "kinetic.inOut", immediateRender: false },
          at,
        );
        timeline.fromTo(
          mark,
          { rotate: (index * turns * 360) / (shapes.length - 1), scale: index === 0 ? 1 : 0.86 },
          {
            rotate: ((index + 1) * turns * 360) / (shapes.length - 1),
            scale: index === shapes.length - 2 ? 1 : 0.86,
            duration: props.morph,
            ease: "kinetic.inOut",
            immediateRender: false,
          },
          at,
        );
      });
      const last = paths.at(-1);
      if (last)
        timeline.fromTo(
          last,
          { fill: color },
          { fill: accent, duration: props.morph * 0.6, ease: "power2.out", immediateRender: false },
          plan.locked - props.morph * 0.6,
        );
      timeline.fromTo(
        mark,
        { scale: 0.9 },
        { scale: 1, duration: 0.5, ease: "kinetic.snap", immediateRender: false },
        "locked",
      );
      if (wordmark) {
        timeline.addLabel("wordmark", plan.wordmark);
        timeline.from(
          selector("[data-word]"),
          safe.vertical
            ? { yPercent: -110, duration: 0.7, ease: "kinetic.out" }
            : { xPercent: -105, duration: 0.7, ease: "kinetic.out" },
          "wordmark",
        );
      }
    },
    { dependencies: [ready, JSON.stringify(props), safe.vertical] },
  );
  if (!ready) return <Stage background={background}>{null}</Stage>;
  const wordSize = Math.min(
    markSize * 0.62,
    ((safe.vertical ? safe.width : safe.width - markSize) * 0.9) / Math.max(1, wordmark.length * 0.58),
  );
  return (
    <Stage background={background}>
      <div
        ref={scope}
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: safe.vertical ? "column" : "row",
          alignItems: "center",
          justifyContent: "center",
          gap: markSize * 0.18,
        }}
      >
        <svg
          data-mark
          viewBox="0 0 200 200"
          width={markSize}
          height={markSize}
          style={{ overflow: "visible", position: "relative", zIndex: 1 }}
        >
          {shapes.slice(0, -1).map((shape, index) => (
            <path key={index} data-shape d={shape} fill={color} opacity={index === 0 ? 1 : 0} />
          ))}
        </svg>
        {wordmark ? (
          <div style={{ overflow: "hidden", paddingBottom: wordSize * 0.08 }}>
            <div
              data-word
              style={{
                fontFamily: primaryFont,
                fontWeight: 700,
                fontSize: wordSize,
                letterSpacing: "-0.045em",
                lineHeight: 1,
                color,
                whiteSpace: "pre",
              }}
            >
              {wordmark}
            </div>
          </div>
        ) : null}
      </div>
    </Stage>
  );
};

/** foren's close: a pale disc on a dark ground, a block letter slicing in, then the word with the disc as its full stop. */
export const travelWordmarkPreset: MorphMarkProps = {
  shapes: [
    "M100,70 C116.6,70 130,83.4 130,100 C130,116.6 116.6,130 100,130 C83.4,130 70,116.6 70,100 C70,83.4 83.4,70 100,70 Z",
    "M52,40 H156 V82 H96 V100 H136 V136 H96 V164 H52 Z",
  ],
  wordmark: "Voltline",
  color: "#F2F0EA",
  accent: "#DDEBFF",
  background: "#1E1A17",
  at: 6,
  morph: 0.55,
  hold: 0.18,
  turns: 0,
  wordmarkReveal: "travel",
  travelGlitch: TRAVEL_GLITCH_FOREN,
};

export const morphMarkDefaults: MorphMarkProps = {
  shapes: [
    "M100,70 C116.6,70 130,83.4 130,100 C130,116.6 116.6,130 100,130 C83.4,130 70,116.6 70,100 C70,83.4 83.4,70 100,70 Z",
    "M100,24 C168,24 176,32 176,100 C176,168 168,176 100,176 C32,176 24,168 24,100 C24,32 32,24 100,24 Z",
    "M100,8 C108,72 128,92 192,100 C128,108 108,128 100,192 C92,128 72,108 8,100 C72,92 92,72 100,8 Z",
    "M118,10 L40,114 L94,114 L80,190 L162,82 L106,82 Z",
  ],
  wordmark: "Voltline",
  color: "#111111",
  accent: "#ff5a1f",
  background: "#f3f1ec",
  at: 6,
  morph: 0.55,
  hold: 0.18,
  turns: 1,
};
