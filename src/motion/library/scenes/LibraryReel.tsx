import { TransitionSeries } from "@remotion/transitions";
import React from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { z } from "zod";
import { FilmFinish } from "../finish/FilmFinish";
import { lightBurn } from "../transitions/LightBurn";
import { slicePanels } from "../transitions/SlicePanels";
import { cutTiming, whipPan } from "../transitions/WhipPan";
import { groundSwap } from "../transitions/GroundSwap";
import { inkOn } from "../typography/Stage";
import { SentenceBuild, sentenceBuildFixedPreset } from "../typography/SentenceBuild";
import { zoomThrough } from "../transitions/ZoomThrough";
import { SceneEndCard, sceneEndCardDefaults } from "./SceneEndCard";
import { SceneFeatureDemo, featureDemoFrames, sceneFeatureDemoDefaults } from "./SceneFeatureDemo";
import { SceneHookTitle, sceneHookTitleDefaults } from "./SceneHookTitle";
import { SceneProductReveal, sceneProductRevealDefaults } from "./SceneProductReveal";
import { SceneStatMoment, sceneStatMomentDefaults } from "./SceneStatMoment";
import { getStyle } from "../styles";
import { CUT } from "./transition-cut-plan";
import { TransitionCut } from "./TransitionCut";
import { captureProofSchema, type CaptureProofProps } from "./CaptureProof";
import { styleIds } from "./shared";

const FPS = 30;

const DEMO = { ...sceneFeatureDemoDefaults, finish: false, dashboardFrames: 120, actionFrames: 130, clickAt: 62 };

/** Shot lengths vary by more than four times: a fast hook, a long demo. */
export const REEL_SHOTS = { hook: 60, product: 150, demo: featureDemoFrames(DEMO), stat: 105, end: 135 } as const;
const captureShots = { ...REEL_SHOTS, hook: 46, product: 68, stat: 84, end: 83 };
/** Seams, in order: hook→product, product→demo, demo→stat, stat→end. */
export const REEL_SEAMS = { zoom: 16, whip: 9, burn: 14, slice: 20 } as const;

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

type ReelCapture = boolean | CaptureProofProps;
export const reelFrames = (captured: ReelCapture = false) =>
  typeof captured === "object" && captured.performance
    ? CUT.end
    : sum(Object.values(captured ? captureShots : REEL_SHOTS)) - sum(Object.values(REEL_SEAMS));
export const REEL_FRAMES = reelFrames();

/** Start frame of every shot in the reel. */
export const reelStarts = (captured: ReelCapture = false): number[] => {
  if (typeof captured === "object" && captured.performance) return [0, CUT.proof, CUT.first, CUT.second, CUT.lock];
  const shots = Object.values(captured ? captureShots : REEL_SHOTS);
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
  capture: captureProofSchema.optional(),
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
  capture,
  beats,
  brand,
  hookLines,
  hookVerticalLines,
  cta,
  action,
}) => {
  const style = getStyle(styleId);
  const shots = capture ? captureShots : REEL_SHOTS;
  const starts = reelStarts(capture);
  const { width, height } = useVideoConfig();
  const plate = capture && (height > width ? (capture.portrait ?? capture.landscape) : capture.landscape);
  const statStart = starts[3] ?? 0;
  const statLand = (beats.find((beat) => beat >= statStart + 46) ?? statStart + 54) - statStart;
  const hookWords = height > width && hookVerticalLines.length ? hookVerticalLines : hookLines;
  const base = { styleId, finish: false };
  if (capture?.performance)
    return (
      <TransitionCut
        proof={capture}
        brand={brand}
        action={action || cta}
        styleId={styleId}
        audio={capture.performance.score}
      />
    );
  return (
    <AbsoluteFill style={{ backgroundColor: style.palette.background }}>
      <FilmFinish grain={capture ? 0.022 : 0.07} vignette={capture ? 0.04 : 0.5} aberration={0} seed="library-reel">
        <TransitionSeries>
          <TransitionSeries.Sequence durationInFrames={shots.hook}>
            <SceneHookTitle
              {...sceneHookTitleDefaults}
              {...base}
              lead=""
              accentGround={capture?.accent}
              words={capture ? hookWords : hookLines}
              cuts={
                capture ? hookWords.map((_, index) => Math.floor((index * (shots.hook - 12)) / hookWords.length)) : [0]
              }
              exitAt={shots.hook - 12}
            />
          </TransitionSeries.Sequence>
          <TransitionSeries.Transition
            presentation={zoomThrough({ originX: 0.5, originY: 0.48, maxBlur: 22 })}
            timing={cutTiming(REEL_SEAMS.zoom)}
          />
          <TransitionSeries.Sequence durationInFrames={shots.product}>
            <SceneProductReveal
              {...sceneProductRevealDefaults}
              {...base}
              kicker={`Introducing ${brand}`}
              {...(capture && plate
                ? {
                    presentation: "screen" as const,
                    screenImage: plate.before,
                    headline: capture.title,
                    subline: "",
                    orbitDegrees: 10,
                  }
                : {})}
              textAt={20}
              durationInFrames={shots.product}
            />
          </TransitionSeries.Sequence>
          <TransitionSeries.Transition
            presentation={whipPan({ direction: "left", maxBlur: 20 })}
            timing={cutTiming(REEL_SEAMS.whip)}
          />
          <TransitionSeries.Sequence durationInFrames={shots.demo}>
            <SceneFeatureDemo {...DEMO} {...base} product={brand} capture={capture} />
          </TransitionSeries.Sequence>
          {capture ? (
            <TransitionSeries.Transition presentation={groundSwap({ kick: 0 })} timing={cutTiming(REEL_SEAMS.burn)} />
          ) : (
            <TransitionSeries.Transition
              presentation={lightBurn({ core: "#FFF6EA", halo: style.palette.accent, fromX: 0.62 })}
              timing={cutTiming(REEL_SEAMS.burn)}
            />
          )}
          <TransitionSeries.Sequence durationInFrames={shots.stat}>
            {capture?.resultNames ? (
              <SentenceBuild
                {...sentenceBuildFixedPreset}
                text={capture.resultNames.join(" / ")}
                ground={capture.accent}
                ink={inkOn(capture.accent)}
                width={0.83}
                align="left"
                step={5}
                exitAt={-1}
                creep={0}
              />
            ) : (
              <SceneStatMoment
                {...sceneStatMomentDefaults}
                {...base}
                beat={statLand}
                {...(capture
                  ? {
                      lead: `From [${capture.beforeValue}] ${capture.beforeLabel} to`,
                      value: Number(capture.afterValue),
                      label: capture.afterLabel,
                      format: { locale: "en-GB", decimals: 0, prefix: "", suffix: "" },
                      race: 0,
                    }
                  : {})}
              />
            )}
          </TransitionSeries.Sequence>
          {capture ? (
            <TransitionSeries.Transition presentation={groundSwap({ kick: 0 })} timing={cutTiming(REEL_SEAMS.slice)} />
          ) : (
            <TransitionSeries.Transition
              presentation={slicePanels({ count: 5, direction: "up" })}
              timing={cutTiming(REEL_SEAMS.slice)}
            />
          )}
          <TransitionSeries.Sequence durationInFrames={shots.end}>
            <SceneEndCard
              {...sceneEndCardDefaults}
              {...base}
              {...(capture
                ? { paths: ["M4 23H41L49 31H96V82H4Z"], ticks: false, markInk: capture.accent, actionSize: 48 }
                : {})}
              wordmark={brand}
              cta={action || cta}
              ctaAt={30}
              durationInFrames={shots.end}
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
