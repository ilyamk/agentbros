import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { GroundSwap, HeroWord } from "../transitions/GroundSwap";
import type { Cue } from "../types";
import { BuildLine, exitProgress, groundRole, heroShare, MaybeFinish, sceneBaseSchema, useLook } from "./shared";

export const sceneHookTitleSchema = sceneBaseSchema.extend({
  /** A small sentence that builds first, on the first ground; `[brackets]` mark accent words. Empty skips it. */
  lead: z.string(),
  /** Hero words or short phrases, one per hard cut, each set to the hero share of the frame width. */
  words: z.array(z.string()).min(1),
  /** Frame of each hero word's cut, one per word, ascending. Put them on downbeats. */
  cuts: z.array(z.number().int().min(0)).min(1),
  /** Frame the last word shrinks away out of a blur, causing the next cut; -1 holds it. */
  exitAt: z.number(),
});

export type SceneHookTitleProps = z.infer<typeof sceneHookTitleSchema>;

const shotCuts = ({ lead, cuts }: Pick<SceneHookTitleProps, "lead" | "cuts">): number[] => (lead ? [0, ...cuts] : cuts);

export const sceneHookTitleCues = (props: Pick<SceneHookTitleProps, "lead" | "cuts" | "exitAt">): Cue[] => [
  ...props.cuts.map((frame, i): Cue => ({
    frame,
    kind: "cut",
    sfx: i === 0 ? "impact" : "tick",
    weight: i === 0 ? "hero" : "support",
    label: `hero word ${i + 1}`,
  })),
  ...(props.exitAt >= 0 ? [{ frame: props.exitAt, kind: "exit", sfx: "whoosh", weight: "support" } as Cue] : []),
];

/**
 * The opening: a small lead sentence builds on the light ground, then hero words hit one per cut, each on a swapped
 * ground (accent, ink, light), with no flash, glow or spring. The last word can shrink out of a blur to cause the next cut.
 */
export const SceneHookTitle: React.FC<SceneHookTitleProps> = ({ styleId, finish, lead, words, cuts, exitAt }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const vertical = height > width;
  const u = Math.min(width, height) / 1080;
  // Light for the lead, then accent and ink alternate on the hero cuts.
  const grounds = [groundRole(styleId, "light"), groundRole(styleId, "accent"), groundRole(styleId, "ink")];
  const { displayFamily, displayAxes, bodyFamily } = useLook(styleId);
  const out = exitProgress(frame, exitAt);
  const shots = shotCuts({ lead, cuts });
  // The lead takes the first ground; hero words start on the accent so the first cut is a swap.
  const order = lead ? grounds : [...grounds.slice(1), grounds[0]!];
  return (
    <MaybeFinish on={finish} styleId={styleId} seed="scene-hook">
      <GroundSwap cuts={shots} grounds={order}>
        {(shot) => {
          const wordIndex = lead ? shot.index - 1 : shot.index;
          if (wordIndex < 0)
            return (
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
            );
          const last = wordIndex === words.length - 1;
          const gone = last ? out : 0;
          return (
            <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
              <div
                style={{
                  transform: `scale(${1 - 0.45 * gone})`,
                  filter: gone > 0.01 ? `blur(${gone * 10}px)` : undefined,
                  opacity: 1 - gone * gone,
                }}
              >
                <HeroWord
                  text={words[wordIndex]!}
                  ink={shot.ink}
                  widthShare={heroShare(styleId, vertical)}
                  fontFamily={displayFamily}
                  style={{ fontVariationSettings: displayAxes }}
                />
              </div>
            </AbsoluteFill>
          );
        }}
      </GroundSwap>
    </MaybeFinish>
  );
};

export const sceneHookTitleDefaults: SceneHookTitleProps = {
  styleId: "paper-signal",
  finish: true,
  lead: "Most launch films look [exactly] the same.",
  words: ["Yours", "won’t."],
  cuts: [34, 50],
  exitAt: 80,
};
