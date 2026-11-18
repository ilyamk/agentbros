import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { formatSchema, formatValue } from "../data/kit";
import { GroundSwap, HeroWord } from "../transitions/GroundSwap";
import type { Cue } from "../types";
import { BuildLine, exitProgress, groundRole, heroShare, MaybeFinish, sceneBaseSchema, useLook } from "./shared";

export const sceneStatMomentSchema = sceneBaseSchema.extend({
  /** The sentence that sets the number up, on the light ground; `[brackets]` mark accent numbers. Empty skips it. */
  lead: z.string(),
  value: z.number().min(0),
  format: formatSchema,
  /** Small caption under the hero number. */
  label: z.string(),
  /** Frame of the hard cut to the number on the accent ground: put it on a downbeat or surge. */
  beat: z.number().int().min(0),
  /** Frames of a front-loaded race to the value after the cut (most of it in the first third); 0 lands it whole. */
  race: z.number().int().min(0).max(30),
  /** Frame the number shrinks away out of a blur; -1 holds it. */
  exitAt: z.number(),
});

export type SceneStatMomentProps = z.infer<typeof sceneStatMomentSchema>;

export const sceneStatMomentCues = ({
  beat,
  race,
  exitAt,
}: Pick<SceneStatMomentProps, "beat" | "race" | "exitAt">): Cue[] => [
  { frame: beat, kind: "cut", sfx: "impact", weight: "hero", label: "number on the accent ground" },
  ...(race > 0 ? [{ frame: beat + race, kind: "land", sfx: "tick", weight: "support" } as Cue] : []),
  ...(exitAt >= 0 ? [{ frame: exitAt, kind: "exit", sfx: "whoosh", weight: "support" } as Cue] : []),
];

/**
 * The payoff number: a lead sentence with accent numbers builds on the light ground, then a hard cut on `beat` swaps
 * to the accent ground with the number at hero scale (front-loaded race, then rest) and a small caption.
 */
export const SceneStatMoment: React.FC<SceneStatMomentProps> = ({
  styleId,
  finish,
  lead,
  value,
  format,
  label,
  beat,
  race,
  exitAt,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const u = Math.min(width, height) / 1080;
  const { displayFamily, displayAxes, bodyFamily } = useLook(styleId);
  const light = groundRole(styleId, "light");
  const accent = groundRole(styleId, "accent");
  const out = exitProgress(frame, exitAt);
  const finalText = formatValue(value, format);
  const progress =
    race > 0
      ? interpolate(frame - beat, [0, race], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: (t) => 1 - (1 - t) ** 4,
        })
      : 1;
  const shown = formatValue(value * progress, format);
  return (
    <MaybeFinish on={finish} styleId={styleId} seed="scene-stat">
      <GroundSwap cuts={lead ? [0, beat] : [0]} grounds={lead ? [light, accent] : [accent]}>
        {(shot) =>
          lead && shot.index === 0 ? (
            <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
              <BuildLine
                text={lead}
                at={2}
                ink={shot.ink}
                accent={shot.accent ?? shot.ink}
                style={{
                  fontFamily: bodyFamily,
                  fontWeight: 500,
                  fontSize: 72 * u,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.15,
                  textAlign: "center",
                  maxWidth: width * (vertical ? 0.8 : 0.56),
                }}
              />
            </AbsoluteFill>
          ) : (
            <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  transform: `scale(${1 - 0.45 * out})`,
                  filter: out > 0.01 ? `blur(${out * 10}px)` : undefined,
                  opacity: 1 - out * out,
                }}
              >
                {/* Fitted on the final value so the size never changes while the digits race. */}
                <HeroWord
                  text={shown}
                  fitTo={finalText}
                  ink={shot.ink}
                  widthShare={heroShare(styleId, vertical)}
                  fontFamily={displayFamily}
                  style={{ fontVariantNumeric: "tabular-nums", fontVariationSettings: displayAxes }}
                />
                {label ? (
                  <div
                    style={{
                      fontFamily: bodyFamily,
                      fontWeight: 500,
                      fontSize: 46 * u,
                      letterSpacing: "-0.01em",
                      color: shot.ink,
                      marginTop: 28 * u,
                      textAlign: "center",
                    }}
                  >
                    {label}
                  </div>
                ) : null}
              </div>
            </AbsoluteFill>
          )
        }
      </GroundSwap>
    </MaybeFinish>
  );
};

export const sceneStatMomentDefaults: SceneStatMomentProps = {
  styleId: "paper-signal",
  finish: true,
  lead: "Teams cut review rounds from [5] to [1].",
  value: 80,
  format: { locale: "en-GB", decimals: 0, prefix: "", suffix: "%" },
  label: "less time to first cut",
  beat: 36,
  race: 12,
  exitAt: -1,
};
