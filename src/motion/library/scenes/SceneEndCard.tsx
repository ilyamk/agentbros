import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { arrivalTint } from "../../text-modes";
import { useTextWidths } from "../typography/fit";
import type { Cue } from "../types";
import { END_CARD_TINT, END_CARD_TINT_FRAMES, END_CARD_TYPE_EVERY, endCardLetterAt, endCardTyped } from "./scene-plan";
import { ARRIVE, groundsFor, MaybeFinish, sceneBaseSchema, useLook } from "./shared";

export const sceneEndCardSchema = sceneBaseSchema.extend({
  /** SVG path `d` strings of the mark, in a square viewBox, drawn flat in one colour. */
  paths: z.array(z.string()).min(1),
  viewBox: z.number().positive(),
  wordmark: z.string(),
  /** One small line under the lockup (a URL or a short promise); empty for none. */
  cta: z.string(),
  /** Frame the wordmark slides out from behind the mark. */
  revealAt: z.number().int().min(0),
  /** Frame the CTA line appears; it holds to the final frame. */
  ctaAt: z.number().int().min(0),
  /** Which of the style's grounds: 0 is the light ground, 1 the accent, 2 the ink. */
  ground: z.number().int().min(0).max(3),
  /** Four small registration ticks around the lockup. */
  ticks: z.boolean(),
  /** Length of this shot when it sits inside a longer film; defaults to the composition length. */
  durationInFrames: z.number().int().positive().optional(),
  /**
   * How the wordmark arrives from `revealAt`. `slide` (default): it slides out from behind the mark. `type` (motionfly
   * t17): one letter every `typeEvery` frames, the lockup recentring as it grows, each letter in its `tint` run settling
   * to ink (`arrivalTint`); `sceneEndCardTypedPreset`.
   */
  wordmarkEntry: z.enum(["slide", "type"]).optional(),
  /** `type`: frames between letters (motionfly 3). */
  typeEvery: z.number().int().min(1).max(12).optional(),
  /** `type`: colours each letter shows one a frame as it appears, before settling to ink; empty or absent for none. */
  tint: z.array(z.string()).optional(),
  /** `type`: frames from a letter's arrival until it is ink (motionfly 5). */
  tintFrames: z.number().int().min(1).max(30).optional(),
});

export type SceneEndCardProps = z.infer<typeof sceneEndCardSchema>;

export const sceneEndCardCues = (
  {
    revealAt,
    ctaAt,
    cta,
    durationInFrames,
    wordmarkEntry,
  }: Pick<SceneEndCardProps, "revealAt" | "ctaAt" | "cta" | "durationInFrames" | "wordmarkEntry">,
  length = 90,
): Cue[] => [
  { frame: 0, kind: "cut", sfx: "impact", weight: "hero", label: "mark on the ground" },
  {
    frame: revealAt,
    kind: "reveal",
    sfx: wordmarkEntry === "type" ? "tick" : "whoosh",
    weight: "support",
    label: "wordmark",
  },
  ...(cta ? [{ frame: ctaAt, kind: "reveal", sfx: "click", weight: "support", label: "cta" } as Cue] : []),
  {
    frame: (durationInFrames ?? length) - 1,
    kind: "stop",
    sfx: "none",
    weight: "hero",
    label: "music stops dead on the last frame",
  },
];

/**
 * A restrained close: the flat mark cuts in on the film's ground, the wordmark slides out from behind it, one small
 * line appears, and the last frame holds with no fade so the sound can stop dead on it.
 */
export const SceneEndCard: React.FC<SceneEndCardProps> = ({
  styleId,
  finish,
  paths,
  viewBox,
  wordmark,
  cta,
  revealAt,
  ctaAt,
  ground,
  ticks,
  wordmarkEntry,
  typeEvery = END_CARD_TYPE_EVERY,
  tint,
  tintFrames = END_CARD_TINT_FRAMES,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  const { displayFamily, displayAxes, bodyFamily, palette } = useLook(styleId);
  const grounds = groundsFor(styleId);
  const shot = grounds[Math.min(ground, grounds.length - 1)]!;
  const markColour = ground === 0 ? palette.accent : shot.ink;
  const mark = 104 * u;
  const type = 84 * u;
  const typed = wordmarkEntry === "type";
  const letters = Array.from(wordmark);
  // `type` measures every prefix too, so the clip grows to exactly the letters on screen.
  const runs = [wordmark, ...(typed ? letters.map((_, i) => letters.slice(0, i + 1).join("")) : [])].map((text) => ({
    text,
    fontFamily: displayFamily,
    fontWeight: 700,
    letterSpacing: "-0.04em",
  }));
  const measured = useTextWidths(runs, type);
  const gap = 26 * u;
  const wordW = (measured?.[0] ?? wordmark.length * type * 0.55) + gap;
  // slide: the wordmark slides out from behind the mark, its clip widening while the lockup re-centres around it.
  // type: the clip is the typed prefix, so the lockup re-centres a letter at a time.
  const shown = typed ? endCardTyped(frame, revealAt, typeEvery, letters.length) : 0;
  const prefixW = (n: number) => measured?.[n] ?? ((wordW - gap) * n) / Math.max(1, letters.length);
  const reveal = typed
    ? shown === 0
      ? 0
      : Math.min(1, (prefixW(shown) + gap) / wordW)
    : interpolate(frame, [revealAt, revealAt + 12], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: ARRIVE,
      });
  const ctaOn = frame >= ctaAt;
  const tick = (x: number, y: number) => (
    <div
      key={`${x}-${y}`}
      style={{ position: "absolute", left: x - 7 * u, top: y - 7 * u, width: 14 * u, height: 14 * u }}
    >
      <div
        style={{
          position: "absolute",
          left: 6 * u,
          top: 0,
          width: 2 * u,
          height: 14 * u,
          backgroundColor: markColour,
          opacity: 0.6,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 6 * u,
          left: 0,
          height: 2 * u,
          width: 14 * u,
          backgroundColor: markColour,
          opacity: 0.6,
        }}
      />
    </div>
  );
  const boxW = Math.min(width * 0.5, 820 * u);
  const boxH = 300 * u;
  return (
    <MaybeFinish on={finish} styleId={styleId} seed="scene-end">
      <AbsoluteFill style={{ backgroundColor: shot.ground, justifyContent: "center", alignItems: "center" }}>
        {ticks
          ? [
              tick(width / 2 - boxW / 2, height / 2 - boxH / 2),
              tick(width / 2 + boxW / 2, height / 2 - boxH / 2),
              tick(width / 2 - boxW / 2, height / 2 + boxH / 2),
              tick(width / 2 + boxW / 2, height / 2 + boxH / 2),
            ]
          : null}
        <div style={{ display: "flex", alignItems: "center" }}>
          <svg width={mark} height={mark} viewBox={`0 0 ${viewBox} ${viewBox}`} style={{ flex: "none" }}>
            {paths.map((d) => (
              <path key={d} d={d} fill={markColour} />
            ))}
          </svg>
          <div style={{ width: wordW * reveal, overflow: "hidden", flex: "none" }}>
            <div
              style={{
                width: wordW,
                paddingLeft: gap,
                boxSizing: "border-box",
                fontFamily: displayFamily,
                fontVariationSettings: displayAxes,
                fontWeight: 700,
                fontSize: type,
                letterSpacing: "-0.04em",
                lineHeight: 1,
                color: shot.ink,
                whiteSpace: "pre",
                transform: typed ? undefined : `translateX(${(reveal - 1) * 40 * u}px)`,
              }}
            >
              {typed
                ? letters.map((letter, i) => (
                    <span
                      key={i}
                      style={{
                        color: tint?.length
                          ? arrivalTint(frame, endCardLetterAt(i, revealAt, typeEvery), tint, shot.ink, tintFrames)
                          : shot.ink,
                        opacity: i < shown ? 1 : 0,
                      }}
                    >
                      {letter}
                    </span>
                  ))
                : wordmark}
            </div>
          </div>
        </div>
        {cta ? (
          <div
            style={{
              position: "absolute",
              top: height / 2 + mark / 2 + 46 * u,
              left: 0,
              right: 0,
              textAlign: "center",
              fontFamily: bodyFamily,
              fontWeight: 500,
              fontSize: 32 * u,
              color: shot.ink,
              opacity: ctaOn ? 0.62 : 0,
            }}
          >
            {cta}
          </div>
        ) : null}
      </AbsoluteFill>
    </MaybeFinish>
  );
};

export const sceneEndCardDefaults: SceneEndCardProps = {
  styleId: "paper-signal",
  finish: true,
  paths: ["M50 6 L94 84 L72 84 L50 44 L28 84 L6 84 Z", "M50 58 L59 72 L50 86 L41 72 Z"],
  viewBox: 100,
  wordmark: "Apex",
  cta: "apex.studio",
  revealAt: 8,
  ctaAt: 30,
  ground: 0,
  ticks: true,
};

/** motionfly t17's close: the wordmark types beside the mark a letter every 3 frames, each lilac, raspberry, teal, then ink in 5. */
export const sceneEndCardTypedPreset: SceneEndCardProps = {
  ...sceneEndCardDefaults,
  wordmark: "Apexline",
  ctaAt: 40,
  wordmarkEntry: "type",
  typeEvery: END_CARD_TYPE_EVERY,
  tint: [...END_CARD_TINT],
  tintFrames: END_CARD_TINT_FRAMES,
};
