import React from "react";
import { AbsoluteFill, Sequence, random, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import {
  DOUBLING_DEFAULT_HOLDS,
  cadenceStarts,
  doublingLands,
  doublingReels,
  maxChangesPerWindow,
  montageHolds,
  plateAt,
} from "../effects/flash-plan";
import { PlateSource } from "../effects/plates";
import type { Cue } from "../types";
import { MaybeFinish, sceneBaseSchema, useLook } from "./shared";

const subjectSchema = z.object({
  /** Image or clip inside public/ (a person or item, framed the same way each time); empty draws a seated figure. */
  src: z.string(),
  name: z.string(),
  detail: z.string(),
});

export const doublingCounterMontageSchema = sceneBaseSchema.extend({
  /** One subject per cut; when there are fewer subjects than holds, procedural figures fill in with `names`. */
  subjects: z.array(subjectSchema),
  /** Names for procedural subjects, in order. */
  names: z.array(z.string()).min(1),
  /** Frames each subject holds, shrinking (an accelerando); the last is the landing. */
  holds: z.array(z.number().int().min(1)).min(2).max(40),
  /** The counter's first value; it doubles on every cut. */
  start: z.number().int().min(1),
  /** Frames the subject leads the counter roll (1–3 in the reference), and the roll's length (4–5). */
  lead: z.number().int().min(0).max(6),
  roll: z.number().int().min(1).max(10),
  /** Plural label beside the counter, and the query line fixed at the top. */
  label: z.string(),
  query: z.string(),
  /**
   * Keep within six cuts in any second (WCAG 2.3.1 three flashes) by lengthening the shortest holds. Off plays the
   * holds exactly (down to 1 frame); then subjects must share ground and tone, and the render needs motion:check.
   */
  flashSafe: z.boolean(),
});

export type DoublingCounterMontageProps = z.infer<typeof doublingCounterMontageSchema>;

export const doublingHolds = (
  { holds, flashSafe }: Pick<DoublingCounterMontageProps, "holds" | "flashSafe">,
  fps = 30,
): number[] => montageHolds(holds, { flashSafe, fps });

export const doublingFrames = (props: Pick<DoublingCounterMontageProps, "holds" | "flashSafe">, fps = 30): number =>
  doublingHolds(props, fps).reduce((a, b) => a + b, 0);

export const doublingMaxCutsPerSecond = (
  props: Pick<DoublingCounterMontageProps, "holds" | "flashSafe">,
  fps = 30,
): number => maxChangesPerWindow(cadenceStarts(doublingHolds(props, fps)), fps);

/** A tick on every cut, the counter landing on the last cut as the hero. */
export const doublingCounterMontageCues = (
  props: Pick<DoublingCounterMontageProps, "holds" | "flashSafe" | "lead" | "roll">,
): Cue[] => {
  const starts = cadenceStarts(doublingHolds(props));
  const lands = doublingLands(starts, props);
  const cues: Cue[] = starts.slice(1).map((frame, i) => ({ frame, kind: "cut", sfx: "tick", weight: "support" }));
  cues.push({ frame: lands[lands.length - 1]!, kind: "land", sfx: "impact", weight: "hero", label: "counter lands" });
  return cues.sort((a, b) => a.frame - b.frame);
};

const groupDigits = (columns: number, column: number): boolean => {
  const fromRight = columns - 1 - column;
  return fromRight > 0 && fromRight % 3 === 0;
};

/** Reels for a value: each column shows its digit and the next, offset by the reel's fraction, clipped. */
const Reels: React.FC<{
  reels: number[];
  visible: number;
  value: number;
  size: number;
  colour: string;
  family: string;
}> = ({ reels, visible, value, size, colour, family }) => {
  const columns = reels.length;
  const height = size * 1.1;
  return (
    <div
      style={{
        display: "inline-flex",
        fontFamily: family,
        fontWeight: 700,
        fontSize: size,
        lineHeight: `${height}px`,
        color: colour,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "-0.03em",
      }}
      aria-label={String(Math.round(value))}
    >
      {reels.map((reel, column) => {
        const fromRight = columns - 1 - column;
        if (fromRight >= visible) return null;
        const digit = Math.floor(reel) % 10;
        const offset = reel - Math.floor(reel);
        return (
          <React.Fragment key={column}>
            <div style={{ position: "relative", width: "0.62em", height, overflow: "hidden", textAlign: "center" }}>
              <div style={{ transform: `translateY(${-offset * height}px)` }}>
                <div>{digit}</div>
                {offset > 0.001 ? <div>{(digit + 1) % 10}</div> : null}
              </div>
            </div>
            {groupDigits(columns, column) ? <span style={{ width: "0.22em" }} aria-hidden /> : null}
          </React.Fragment>
        );
      })}
    </div>
  );
};

/**
 * A fixed layout (query line on top, a counter left of the subject at eye height, a plural label right of it, the
 * subject's name below) while subjects cut in with holds that shrink from about a second and a half to a few frames;
 * every cut doubles the counter, the subject arriving 1–3 frames before the 4-frame roll.
 */
export const DoublingCounterMontage: React.FC<DoublingCounterMontageProps> = (props) => {
  const { subjects, names, start, lead, roll, label, query, styleId, finish } = props;
  const frame = useCurrentFrame();
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const look = useLook(styleId);
  const holds = doublingHolds(props, fps);
  const starts = cadenceStarts(holds);
  const index = Math.max(0, plateAt(starts, frame));
  const vertical = height > width;
  const short = Math.min(width, height);
  const columns = String(Math.floor(start * 2 ** (holds.length - 1))).length;
  const counter = doublingReels(frame, starts, columns, { start, lead, roll });
  const ink = look.palette.text;
  const eye = vertical ? 0.34 : 0.42;
  const counterSize = short * (vertical ? 0.09 : 0.085);
  const subject = (i: number) => subjects[i] ?? { src: "", name: names[i % names.length]!, detail: "" };
  // Seated figures share one ground and one tone family, so a cut changes the subject, not the frame's light.
  const tone = (i: number): [string, string, string] => {
    const hue = Math.round(random(`dc-hue-${i}`) * 360);
    return [look.palette.background, `hsl(${hue} 20% 46%)`, `hsl(${hue} 16% 30%)`];
  };
  return (
    <MaybeFinish on={finish} styleId={styleId} seed="doubling-counter">
      <AbsoluteFill style={{ backgroundColor: look.palette.background }}>
        {holds.map((hold, i) => (
          <Sequence
            key={i}
            from={starts[i]!}
            durationInFrames={i === holds.length - 1 ? Math.max(1, durationInFrames - starts[i]!) : hold}
            layout="none"
          >
            <AbsoluteFill>
              <PlateSource src={subject(i).src} kind="figure" seed={`dc-${i}`} palette={tone(i)} />
            </AbsoluteFill>
          </Sequence>
        ))}
        <div
          style={{
            position: "absolute",
            top: height * 0.08,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontFamily: look.bodyFamily,
              fontWeight: 500,
              fontSize: short * 0.03,
              color: ink,
              padding: `${short * 0.012}px ${short * 0.024}px`,
              borderRadius: short * 0.04,
              border: `${Math.max(1, short * 0.002)}px solid ${ink}`,
              opacity: 0.85,
            }}
          >
            {query}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            right: width * (vertical ? 0.52 : 0.62),
            top: height * eye,
            transform: "translateY(-50%)",
          }}
        >
          <Reels
            reels={counter.reels}
            visible={counter.visible}
            value={counter.shown}
            size={counterSize}
            colour={ink}
            family={look.displayFamily}
          />
        </div>
        <div
          style={{
            position: "absolute",
            left: width * (vertical ? 0.54 : 0.61),
            top: height * eye,
            transform: "translateY(-50%)",
            fontFamily: look.displayFamily,
            fontWeight: 600,
            fontSize: counterSize * 0.55,
            color: ink,
            letterSpacing: "-0.02em",
          }}
        >
          {label}
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: height * (vertical ? 0.86 : 0.84),
            display: "flex",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontFamily: look.bodyFamily,
              fontWeight: 600,
              fontSize: short * 0.032,
              color: look.palette.background,
              backgroundColor: ink,
              padding: `${short * 0.008}px ${short * 0.02}px`,
              borderRadius: short * 0.008,
            }}
          >
            {subject(index).name}
            {subject(index).detail ? (
              <span style={{ fontWeight: 400, opacity: 0.7 }}> · {subject(index).detail}</span>
            ) : null}
          </div>
        </div>
      </AbsoluteFill>
    </MaybeFinish>
  );
};

export { DOUBLING_DEFAULT_HOLDS };

export const doublingCounterMontageDefaults: DoublingCounterMontageProps = {
  styleId: "paper-signal",
  finish: false,
  subjects: [],
  names: [
    "Ada",
    "Bruno",
    "Chiara",
    "Dev",
    "Elif",
    "Femi",
    "Grace",
    "Hugo",
    "Ines",
    "Jun",
    "Kofi",
    "Lena",
    "Mateo",
    "Noor",
    "Oskar",
    "Priya",
    "Quinn",
    "Rosa",
    "Sami",
    "Tove",
  ],
  holds: DOUBLING_DEFAULT_HOLDS,
  start: 1,
  lead: 2,
  roll: 4,
  label: "people",
  query: "who has shipped a film this week",
  flashSafe: true,
};
