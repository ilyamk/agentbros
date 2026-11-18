import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { progress } from "../../timing";
import type { Cue } from "../types";
import { FACE_NAMES, faceRun, faceStyle } from "./faces";
import { useTextWidths } from "./fit";
import { ARRIVE, Stage, inkOn, pulseFrames, useSafeArea } from "./Stage";

export const wordPulseSchema = z.object({
  /** One word per step. Mark the awaited word with *stars*: it takes the accent ink. Repeat a word to accelerate on it. */
  words: z.array(z.string()).min(1),
  face: z.enum(FACE_NAMES),
  /** Grounds cycled one per step: the swap is the cut. */
  grounds: z.array(z.string()).min(1),
  /** Accent ink for *starred* words; on a ground of the same colour the word takes the ground's ink instead. */
  accent: z.string(),
  /** Widths cycled one per step, as shares of the safe width: alternating big and small reads as rhythm. */
  widths: z.array(z.number().min(0.1).max(1.2)).min(1),
  at: z.number().int().nonnegative(),
  /** Beat frames from `audio:map`; when given, they win over `bpm`. */
  beatFrames: z.array(z.number().int().nonnegative()),
  bpm: z.number().positive(),
  beatsPerStep: z.number().positive(),
  /** Step from which intervals shrink geometrically (ref-service-explainer 24.5 s); -1 keeps an even pulse. */
  accelerateFrom: z.number().int(),
  accelerateRatio: z.number().min(0.3).max(1),
  /** Scale each word lands from and settles out of in 4 frames; 1 for a dead-still cut. */
  punch: z.number().min(1).max(1.3),
  grain: z.number().min(0).max(0.2),
});

export type WordPulseProps = z.infer<typeof wordPulseSchema>;

const strip = (word: string) => word.replace(/\*/g, "");
const starred = (word: string) => /^\*.*\*$/.test(word.trim());

/**
 * A word per beat, each on a hard cut and its own ground, at alternating sizes, the awaited word landing last in the
 * accent. Optionally the intervals shrink so the last repeats rush. The ground swap carries the cut; nothing moves.
 */
export const WordPulse: React.FC<WordPulseProps> = ({
  words,
  face,
  grounds,
  accent,
  widths,
  at,
  beatFrames,
  bpm,
  beatsPerStep,
  accelerateFrom,
  accelerateRatio,
  punch,
  grain,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const safe = useSafeArea();
  const set = faceStyle(face);
  const measured = useTextWidths(
    words.map((word) => faceRun(face, strip(word))),
    100,
  );
  const frames = pulseFrames(words.length, { at, beatFrames, bpm, beatsPerStep, accelerateFrom, accelerateRatio }, fps);
  let index = -1;
  for (let step = 0; step < frames.length; step++) if (frame >= frames[step]!) index = step;
  const ground = grounds[Math.max(index, 0) % grounds.length]!;
  if (measured === null || index < 0)
    return (
      <Stage background={grounds[0]!} grain={grain}>
        {null}
      </Stage>
    );

  const word = words[index]!;
  const target = safe.width * widths[index % widths.length]!;
  const size = Math.min(
    safe.vertical ? safe.height * 0.3 : safe.height * 0.82,
    (target * 100) / Math.max(measured[index]!, 1),
  );
  const plain = inkOn(ground);
  const ink = starred(word) && accent.toLowerCase() !== ground.toLowerCase() ? accent : plain;
  const settle = punch > 1 ? 1 + (punch - 1) * (1 - progress(frame, frames[index]!, 4, ARRIVE)) : 1;
  const text = set.textTransform === "uppercase" ? strip(word).toUpperCase() : strip(word);

  return (
    <Stage background={ground} grain={grain}>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            ...set,
            textTransform: undefined,
            fontSize: size,
            lineHeight: 0.9,
            color: ink,
            whiteSpace: "pre",
            transform: `scale(${settle})`,
          }}
        >
          {text}
        </div>
      </AbsoluteFill>
    </Stage>
  );
};

export const wordPulseDefaults: WordPulseProps = {
  words: ["Every", "frame", "is", "*code.*", "code.", "code.", "code.", "*code.*"],
  face: "wide",
  grounds: ["#0C0C0C", "#F4F2EE", "#EF4A2D"],
  accent: "#EF4A2D",
  widths: [0.86, 0.6, 0.3, 0.92],
  at: 2,
  beatFrames: [],
  bpm: 174,
  beatsPerStep: 1,
  accelerateFrom: 4,
  accelerateRatio: 0.62,
  punch: 1.04,
  grain: 0.04,
};

export const wordPulseCues = (props: WordPulseProps): Cue[] =>
  pulseFrames(props.words.length, props, 30).map((frame, index) => ({
    frame,
    kind: "cut" as const,
    sfx: index === props.words.length - 1 ? ("impact" as const) : ("tick" as const),
    weight: index === props.words.length - 1 ? ("hero" as const) : ("support" as const),
    label: strip(props.words[index]!),
  }));
