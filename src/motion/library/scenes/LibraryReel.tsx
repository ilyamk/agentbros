import { TransitionSeries } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill } from "remotion";
import { z } from "zod";
import { FilmFinish } from "../finish/FilmFinish";
import { lightBurn } from "../transitions/LightBurn";
import { slicePanels } from "../transitions/SlicePanels";
import { cutTiming, whipPan } from "../transitions/WhipPan";
import { zoomThrough } from "../transitions/ZoomThrough";
import { SceneEndCard, sceneEndCardDefaults } from "./SceneEndCard";
import { SceneFeatureDemo, featureDemoFrames, sceneFeatureDemoDefaults } from "./SceneFeatureDemo";
import { SceneHookTitle, sceneHookTitleDefaults } from "./SceneHookTitle";
import { SceneProductReveal, sceneProductRevealDefaults } from "./SceneProductReveal";
import { SceneStatMoment, sceneStatMomentDefaults } from "./SceneStatMoment";
import { getStyle } from "../styles";
import { styleIds } from "./shared";

const FPS = 30;

const DEMO = { ...sceneFeatureDemoDefaults, finish: false, dashboardFrames: 120, actionFrames: 130, clickAt: 62 };

/** Shot lengths vary by more than four times: a fast hook, a long demo. */
export const REEL_SHOTS = { hook: 60, product: 150, demo: featureDemoFrames(DEMO), stat: 105, end: 135 } as const;
/** Seams, in order: hook→product, product→demo, demo→stat, stat→end. */
export const REEL_SEAMS = { zoom: 16, whip: 9, burn: 14, slice: 20 } as const;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

export const REEL_FRAMES = sum(Object.values(REEL_SHOTS)) - sum(Object.values(REEL_SEAMS));

/** Start frame of every shot in the reel. */
export const reelStarts = (): number[] => {
  const shots = Object.values(REEL_SHOTS);
  const seams = Object.values(REEL_SEAMS);
  return shots.map((_, index) => sum(shots.slice(0, index)) - sum(seams.slice(0, index)));
};

/** Beat frames from a tempo: round(i × fps × 60 / BPM), never accumulated. */
export const beatFrames = (bpm: number, total = REEL_FRAMES): number[] => {
  const beats: number[] = [];
  for (let i = 0; Math.round((i * FPS * 60) / bpm) < total; i++) beats.push(Math.round((i * FPS * 60) / bpm));
  return beats;
};

export const libraryReelSchema = z.object({
  styleId: z.enum(styleIds),
  /** Beat frames of the music this reel will be cut to; the stat lands on the first beat after its count can finish. */
  beats: z.array(z.number().int().nonnegative()),
  brand: z.string(),
  hookLines: z.array(z.string()).min(1),
  hookVerticalLines: z.array(z.string()),
  cta: z.string(),
  action: z.string(),
});

export type LibraryReelProps = z.infer<typeof libraryReelSchema>;

/**
 * Hook, product reveal, feature demo, stat and end card, made only from library blocks and joined by caused
 * transitions: the title flies through the lens, the turntable whips to the screen, the click burns to the result,
 * and the result slices away to the mark. One FilmFinish over the whole film.
 */
export const LibraryReel: React.FC<LibraryReelProps> = ({
  styleId,
  beats,
  brand,
  hookLines,
  hookVerticalLines,
  cta,
  action,
}) => {
  const style = getStyle(styleId);
  const starts = reelStarts();
  const statStart = starts[3] ?? 0;
  const statLand = (beats.find((beat) => beat >= statStart + 46) ?? statStart + 54) - statStart;
  const base = { styleId, finish: false };
  return (
    <AbsoluteFill style={{ backgroundColor: style.palette.background }}>
      <FilmFinish grain={0.07} vignette={0.5} aberration={0} seed="library-reel">
        <TransitionSeries>
          <TransitionSeries.Sequence durationInFrames={REEL_SHOTS.hook}>
            <SceneHookTitle
              {...sceneHookTitleDefaults}
              {...base}
              lead=""
              words={hookLines}
              cuts={[0]}
              exitAt={REEL_SHOTS.hook - 12}
            />
          </TransitionSeries.Sequence>
          <TransitionSeries.Transition
            presentation={zoomThrough({ originX: 0.5, originY: 0.48, maxBlur: 22 })}
            timing={cutTiming(REEL_SEAMS.zoom)}
          />
          <TransitionSeries.Sequence durationInFrames={REEL_SHOTS.product}>
            <SceneProductReveal
              {...sceneProductRevealDefaults}
              {...base}
              kicker={`Introducing ${brand}`}
              textAt={20}
              durationInFrames={REEL_SHOTS.product}
            />
          </TransitionSeries.Sequence>
          <TransitionSeries.Transition
            presentation={whipPan({ direction: "left", maxBlur: 20 })}
            timing={cutTiming(REEL_SEAMS.whip)}
          />
          <TransitionSeries.Sequence durationInFrames={REEL_SHOTS.demo}>
            <SceneFeatureDemo {...DEMO} {...base} product={brand} />
          </TransitionSeries.Sequence>
          <TransitionSeries.Transition
            presentation={lightBurn({ core: "#FFF6EA", halo: style.palette.accent, fromX: 0.62 })}
            timing={cutTiming(REEL_SEAMS.burn)}
          />
          <TransitionSeries.Sequence durationInFrames={REEL_SHOTS.stat}>
            <SceneStatMoment {...sceneStatMomentDefaults} {...base} beat={statLand} />
          </TransitionSeries.Sequence>
          <TransitionSeries.Transition
            presentation={slicePanels({ count: 5, direction: "up" })}
            timing={cutTiming(REEL_SEAMS.slice)}
          />
          <TransitionSeries.Sequence durationInFrames={REEL_SHOTS.end}>
            <SceneEndCard
              {...sceneEndCardDefaults}
              {...base}
              wordmark={brand}
              cta={action || cta}
              ctaAt={30}
              durationInFrames={REEL_SHOTS.end}
            />
          </TransitionSeries.Sequence>
        </TransitionSeries>
      </FilmFinish>
    </AbsoluteFill>
  );
};

export const libraryReelDefaults: LibraryReelProps = {
  styleId: "keynote-dark",
  beats: beatFrames(120),
  brand: "Apex",
  hookLines: ["Every frame, on purpose."],
  hookVerticalLines: ["Every frame,", "on purpose."],
  cta: "Direct your next film in minutes.",
  action: "apex.studio",
};
