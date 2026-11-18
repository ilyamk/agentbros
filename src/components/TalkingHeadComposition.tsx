import React from "react";
import { AbsoluteFill, Sequence, staticFile, useVideoConfig } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { TalkingHeadScene, TalkingHeadPanel } from "./TalkingHeadScene";
import { TalkingHeadLayout } from "../templates/talkinghead/TalkingHeadLayout";
import { TalkingHeadVideo } from "../templates/talkinghead/TalkingHeadVideo";
import { CanvasMoodContext } from "../templates/leftpanel/_canvas";
import { compileTimeline } from "../lib/timeline";
import { Audio } from "@remotion/media";
import type { TalkingHeadConfig, VideoProps } from "../types/video";

export type TalkingHeadCompositionProps = VideoProps & {
  talkingHead: TalkingHeadConfig;
  muteAllAudio?: boolean;
  captionsEnabled?: boolean;
};

export const TalkingHeadComposition: React.FC<TalkingHeadCompositionProps> = ({
  scenes,
  talkingHead,
  voiceoverEnabled,
  projectId,
  format,
  musicVolume,
  muteAllAudio = false,
  captionsEnabled = true,
}) => {
  const { fps } = useVideoConfig();
  const timeline = compileTimeline(scenes, { fps, talkingHead: true });
  const { entries } = timeline;
  const videoProps = {
    src: talkingHead.presenterVideo.startsWith("http")
      ? talkingHead.presenterVideo
      : staticFile(talkingHead.presenterVideo),
    muted: muteAllAudio || talkingHead.audioSource !== "embedded",
    objectPosition: talkingHead.presenterCrop?.[format],
  };

  // Keep one decoder and one embedded audio track mounted across visual fades.
  // Explicit source gaps represent edits and use serial (never overlapping) slices.
  const presenter = timeline.contiguousPresenter ? (
    <TalkingHeadVideo
      {...videoProps}
      startSec={entries[0].sourceStartFrame / fps}
      endSec={entries.at(-1)!.sourceEndFrame / fps}
    />
  ) : (
    entries.map((entry) => (
      <Sequence key={entry.scene.id} from={entry.startFrame} durationInFrames={entry.durationInFrames}>
        <TalkingHeadVideo {...videoProps} startSec={entry.sourceStartFrame / fps} endSec={entry.sourceEndFrame / fps} />
      </Sequence>
    ))
  );

  // Padding belongs only to the visual track. TransitionSeries removes exactly
  // that padding again; narration and captions retain the source wall clock.
  const panels = (
    <TransitionSeries>
      {entries.flatMap((entry) => [
        <TransitionSeries.Sequence
          key={entry.scene.id}
          durationInFrames={entry.durationInFrames + entry.transitionFrames}
        >
          <TalkingHeadPanel scene={entry.scene} />
        </TransitionSeries.Sequence>,
        ...(entry.transitionFrames
          ? [
              <TransitionSeries.Transition
                key={`${entry.scene.id}-fade`}
                presentation={fade()}
                timing={linearTiming({
                  durationInFrames: entry.transitionFrames,
                })}
              />,
            ]
          : []),
      ])}
    </TransitionSeries>
  );

  const captions = entries.map((entry) => (
    <Sequence layout="none" key={entry.scene.id} from={entry.startFrame} durationInFrames={entry.durationInFrames}>
      <TalkingHeadScene
        captionsEnabled={captionsEnabled}
        speechOnly
        scene={entry.scene}
        talkingHead={talkingHead}
        voiceoverEnabled={voiceoverEnabled}
        projectId={projectId}
        format={format}
      />
    </Sequence>
  ));

  return (
    <CanvasMoodContext.Provider value={talkingHead.leftPanelCanvas ?? "light"}>
      <AbsoluteFill>
        <TalkingHeadLayout
          config={talkingHead}
          presenterChildren={presenter}
          leftChildren={panels}
          captionsChildren={captions}
          leftBackground={talkingHead.leftPanelCanvas === "dark" ? "#0E1116" : "#F8F8F4"}
        />
        {musicVolume > 0 && <Audio src={staticFile(`projects/${projectId}/music/bg.mp3`)} volume={musicVolume} loop />}
      </AbsoluteFill>
    </CanvasMoodContext.Provider>
  );
};
