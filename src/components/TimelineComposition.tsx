import { clipSourceFrame, visualObjectPosition } from "../lib/timeline-ir/reframe";
import { attenuateAudio } from "../lib/audio/clip-gain";
import React from "react";
import { AbsoluteFill, Freeze, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Audio, Video } from "@remotion/media";
import { SceneSchema } from "../types/video";
import type { TimelineIR } from "../types/timeline";
import type { ProjectVideoProps } from "../lib/project-props";
import { compileTimelineIR } from "../lib/timeline-ir/compiler";
import { numeric } from "../lib/timeline-ir/rational";
import { audioClipTiming, mediaTiming, renderBoundary } from "../lib/timeline-ir/render";
import { SceneRenderer } from "./PromoVideo";
import { StockVideoScene } from "./StockVideoScene";
import { TalkingHeadPanel } from "./TalkingHeadScene";
import { TalkingHeadLayout } from "../templates/talkinghead/TalkingHeadLayout";
import { KaraokeCaptions } from "../templates/talkinghead/KaraokeCaptions";
import { TimelineCaptions } from "./TimelineCaptions";
import { TimelineOverlays } from "./TimelineOverlays";
import { resolveCaptionStyle, timelineCaptionWords } from "../lib/captions/profiles";
import { CanvasMoodContext } from "../templates/leftpanel/_canvas";
import { spacing, captionLayout } from "../lib/design-tokens";

type Snapshot = ReturnType<typeof compileTimelineIR>;
type Clip = Snapshot["tracks"][number]["clips"][number];
const url = (source: string) => (/^https?:\/\//.test(source) ? source : staticFile(source));

const ClipVisual: React.FC<{
  clip: Clip;
  props: ProjectVideoProps;
  ownedFrames: number;
  fadeFrames: number;
  incomingFrames: number;
}> = ({ clip, props, ownedFrames, fadeFrames, incomingFrames }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const asset = props.timelineAssets?.[clip.assetId];
  const payload = clip.payload ?? {};
  const sourceFrame = clipSourceFrame(clip.source, clip.rate, frame, fps, ownedFrames);
  const objectPosition = visualObjectPosition(
    payload,
    height > width ? "vertical" : height === width ? "square" : "landscape",
    sourceFrame,
  );
  const timing = mediaTiming(clip.source, clip.rate, fps);
  const captionReservePx = props.timeline?.tracks.some((track) => track.clips.some((row) => row.captions.length > 0))
    ? Math.ceil(
        (props.talkingHead?.captionStyle?.fontSize ?? captionLayout.fontSize) *
          captionLayout.lineHeight *
          captionLayout.reservedRows,
      ) + spacing.headlineGap
    : 0;
  const transform = payload.transform as { scale?: number; x?: number; y?: number; rotation?: number } | undefined;
  const opacity =
    frame >= ownedFrames && fadeFrames > 0
      ? Math.max(0, 1 - (frame - ownedFrames) / fadeFrames)
      : incomingFrames > 0
        ? Math.min(1, frame / incomingFrames)
        : 1;
  let visual: React.ReactNode;
  if (asset?.kind === "image") {
    visual = (
      <Img src={url(asset.source)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition }} />
    );
  } else if (asset?.kind === "video") {
    const authored = SceneSchema.safeParse(payload.scene);
    const video =
      authored.success && authored.data.visualType === "video" && !props.talkingHead?.enabled ? (
        <StockVideoScene
          videoUrl={asset.source}
          videoTiming={timing}
          headline={authored.data.headline ?? ""}
          subtext={authored.data.subtext}
          accentColor={props.accentColor}
          textColor={props.textColor}
          captionReservePx={captionReservePx}
        />
      ) : (
        <Video
          objectFit="cover"
          src={url(asset.source)}
          {...timing}
          muted
          style={{ width: "100%", height: "100%", objectPosition }}
        />
      );
    visual = frame >= ownedFrames ? <Freeze frame={ownedFrames - 1}>{video}</Freeze> : video;
  } else {
    const scene = SceneSchema.parse(payload.scene);
    visual = (
      <Freeze frame={timing.trimBefore + Math.round(Math.min(frame, ownedFrames - 1) * timing.playbackRate)}>
        {props.talkingHead?.enabled ? (
          <TalkingHeadPanel scene={scene} />
        ) : (
          <SceneRenderer
            scene={scene}
            accentColor={props.accentColor}
            bgColor={props.bgColor}
            textColor={props.textColor}
            captionsEnabled={props.captionsEnabled}
            captionReservePx={captionReservePx}
          />
        )}
      </Freeze>
    );
  }
  return (
    <AbsoluteFill
      style={{
        opacity,
        transform: `translate(${transform?.x ?? 0}px, ${transform?.y ?? 0}px) scale(${transform?.scale ?? 1}) rotate(${transform?.rotation ?? 0}deg)`,
      }}
    >
      {visual}
    </AbsoluteFill>
  );
};

export const TimelineComposition: React.FC<ProjectVideoProps & { timeline: TimelineIR }> = (props) => {
  const { fps } = useVideoConfig();
  const snapshot = compileTimelineIR(props.timeline);
  const boundary = (frame: Clip["start"]) => renderBoundary(frame, snapshot.timebase, fps);
  const visual = snapshot.tracks
    .filter((track) => track.kind === "visual")
    .map((track) => (
      <AbsoluteFill key={track.id}>
        {track.clips.map((clip, index) => {
          const start = boundary(clip.start),
            end = boundary(clip.end);
          const fade = clip.transition.kind === "fade" ? boundary(clip.transition.duration) : 0;
          const previous = track.clips[index - 1];
          const incoming = previous?.transition.kind === "fade" ? boundary(previous.transition.duration) : 0;
          return (
            <Sequence key={clip.id} from={start} durationInFrames={end - start + fade}>
              <ClipVisual
                clip={clip}
                props={props}
                ownedFrames={end - start}
                fadeFrames={fade}
                incomingFrames={incoming}
              />
            </Sequence>
          );
        })}
      </AbsoluteFill>
    ));
  const presenter = snapshot.tracks
    .filter((track) => track.kind === "presenter")
    .flatMap((track) =>
      track.clips.map((clip) => {
        const asset = props.timelineAssets![clip.assetId];
        const timing = mediaTiming(clip.source, clip.rate, fps);
        return (
          <Sequence
            key={`${track.id}:${clip.id}`}
            from={boundary(clip.start)}
            durationInFrames={boundary(clip.end) - boundary(clip.start)}
          >
            <Video
              objectFit="cover"
              src={url(asset.source)}
              {...timing}
              muted={
                !!props.audioMaster ||
                props.talkingHead?.audioSource !== "embedded" ||
                clip.payload?.speechMuted === true
              }
              volume={typeof clip.payload?.volume === "number" ? clip.payload.volume : 1}
              style={{
                width: "100%",
                height: "100%",
                objectPosition:
                  props.talkingHead?.presenterCrop?.[props.format] ??
                  (props.format === "landscape" ? "50% 50%" : "50% 30%"),
              }}
            />
          </Sequence>
        );
      }),
    );
  const captionStyle = resolveCaptionStyle(props);
  const captions = snapshot.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => props.captionsEnabled !== false && clip.captions.length)
      .map((clip) => (
        <Sequence
          key={`${track.id}:${clip.id}:captions`}
          layout="none"
          from={boundary(clip.start)}
          durationInFrames={boundary(clip.end) - boundary(clip.start)}
        >
          {captionStyle.profile === "karaoke" ? (
            <KaraokeCaptions
              words={clip.captions.map((word) => ({
                text: word.text,
                start: numeric(word.start) / numeric(snapshot.timebase),
                end: numeric(word.end) / numeric(snapshot.timebase),
                emphasis: word.emphasis,
              }))}
              startOffsetSec={boundary(clip.start) / fps}
              style={props.talkingHead?.captionStyle}
            />
          ) : (
            <TimelineCaptions
              style={captionStyle}
              words={timelineCaptionWords(clip.captions, snapshot.timebase)}
              startOffsetSec={boundary(clip.start) / fps}
              inline={!!props.talkingHead?.enabled}
            />
          )}
        </Sequence>
      )),
  );
  const audio = snapshot.tracks
    .filter((track) => !props.audioMaster && ["voiceover", "music", "sfx"].includes(track.kind))
    .flatMap((track) =>
      track.clips.map((clip) => {
        const asset = props.timelineAssets![clip.assetId];
        return (
          <Sequence
            key={`${track.id}:${clip.id}`}
            from={boundary(clip.start)}
            durationInFrames={boundary(clip.end) - boundary(clip.start)}
            layout="none"
          >
            <Audio
              src={url(asset.source)}
              {...audioClipTiming(clip.source, clip.rate, fps, clip.payload?.loop === true)}
              volume={attenuateAudio(
                clip.payload,
                typeof clip.payload?.volume === "number"
                  ? clip.payload.volume
                  : track.kind === "music"
                    ? props.musicVolume
                    : 1,
              )}
              loop={clip.payload?.loop === true}
            />
          </Sequence>
        );
      }),
    );
  // In the talking-head layout both layers sit above the whole layout, whose captions are inside it.
  const overlayLayer = (layer: "below-captions" | "above-captions") => (
    <TimelineOverlays overlays={snapshot.overlays} layer={layer} timebase={snapshot.timebase} />
  );
  return (
    <CanvasMoodContext.Provider value={props.talkingHead?.leftPanelCanvas ?? "light"}>
      <AbsoluteFill style={{ backgroundColor: props.bgColor }}>
        {props.talkingHead?.enabled ? (
          <>
            <TalkingHeadLayout
              config={props.talkingHead}
              presenterChildren={presenter}
              leftChildren={visual}
              captionsChildren={captions}
            />
            {overlayLayer("below-captions")}
            {overlayLayer("above-captions")}
          </>
        ) : (
          <>
            {visual}
            {overlayLayer("below-captions")}
            <AbsoluteFill
              style={{
                justifyContent: "flex-end",
                paddingBottom: spacing.safeBottom[props.format],
                paddingLeft: spacing.sidePadding[props.format],
                paddingRight: spacing.sidePadding[props.format],
                boxSizing: "border-box",
                pointerEvents: "none",
              }}
            >
              {captions}
            </AbsoluteFill>
            {presenter}
            {overlayLayer("above-captions")}
          </>
        )}
        {audio}
      </AbsoluteFill>
    </CanvasMoodContext.Provider>
  );
};
