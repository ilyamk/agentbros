import React, { useState, useEffect } from "react";
import { useCurrentFrame, useVideoConfig, staticFile, AbsoluteFill, delayRender, continueRender } from "remotion";
import { Audio } from "@remotion/media";
import { TalkingHeadLayout } from "../templates/talkinghead/TalkingHeadLayout";
import { TalkingHeadVideo } from "../templates/talkinghead/TalkingHeadVideo";
import { KaraokeCaptions } from "../templates/talkinghead/KaraokeCaptions";
import { LeftPanelRouter } from "../templates/leftpanel/LeftPanelRouter";
import { CanvasMoodContext } from "../templates/leftpanel/_canvas";
import type { WordAlignment } from "../templates/talkinghead/KaraokeCaptions";
import type { TalkingHeadConfig, Scene } from "../types/video";
import { primaryFont } from "../lib/fonts";

export type TalkingHeadSceneProps = {
  scene: Scene;
  talkingHead: TalkingHeadConfig;
  voiceoverEnabled: boolean;
  projectId: string;
  format: "landscape" | "square" | "vertical";
  speechOnly?: boolean;
  captionsEnabled?: boolean;
};

export const TalkingHeadScene: React.FC<TalkingHeadSceneProps> = ({
  scene,
  talkingHead,
  voiceoverEnabled,
  projectId,
  format,
  speechOnly = false,
  captionsEnabled = true,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const [words, setWords] = useState<WordAlignment[]>([]);

  useEffect(() => {
    if (!captionsEnabled) {
      setWords([]);
      return;
    }
    const handle = delayRender(`Loading word timestamps for scene "${scene.id}"`);
    let cancelled = false;
    let released = false;
    const release = () => {
      if (!released) {
        continueRender(handle);
        released = true;
      }
    };
    setWords([]);
    const loadWords = async () => {
      for (const suffix of ["words.edited.json", "words.json"]) {
        try {
          const response = await fetch(staticFile(`projects/${projectId}/voiceover/${scene.id}.${suffix}`));
          if (!response.ok) continue;
          const data = (await response.json()) as { words?: WordAlignment[] };
          if (data.words?.length && !cancelled) {
            setWords(data.words);
            return;
          }
        } catch {
          /* Missing optional captions: try the raw alignment. */
        }
      }
    };
    void loadWords().finally(release);
    return () => {
      cancelled = true;
      release();
    };
  }, [projectId, scene.id, captionsEnabled]);

  // Exit fade — last 9 frames of this scene's composition window
  const exitFadeStart = durationInFrames - 9;
  const sceneOpacity = frame >= exitFadeStart ? Math.max(0, 1 - (frame - exitFadeStart) / 9) : 1;

  // Presenter video
  const hasPresenterVideo = talkingHead.presenterVideo != null && talkingHead.presenterVideo !== "";

  const presenterAudioEmbedded = talkingHead.audioSource === "embedded";

  // Per-format presenter crop override from project config; falls back to
  // the orientation-aware default inside TalkingHeadVideo.
  const presenterCropOverride = talkingHead.presenterCrop?.[format];

  const presenterChildren = hasPresenterVideo ? (
    <TalkingHeadVideo
      src={staticFile(talkingHead.presenterVideo)}
      startSec={scene.presenterStartSec}
      endSec={scene.presenterEndSec}
      muted={!presenterAudioEmbedded}
      objectPosition={presenterCropOverride}
    />
  ) : (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#888",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span
        style={{
          fontFamily: primaryFont,
          fontSize: 28,
          color: "#fff",
          fontWeight: 600,
          textAlign: "center",
          padding: "0 16px",
        }}
      >
        presenter
      </span>
    </div>
  );

  const leftChildren = <TalkingHeadPanel scene={scene} />;

  // Captions
  const captionsChildren =
    captionsEnabled && words.length > 0 ? (
      <KaraokeCaptions words={words} style={talkingHead.captionStyle} />
    ) : undefined;

  if (speechOnly) {
    return (
      <>
        {captionsChildren}
        {voiceoverEnabled && !presenterAudioEmbedded && (
          <Audio src={staticFile(`projects/${projectId}/voiceover/${scene.id}.mp3`)} volume={1} />
        )}
      </>
    );
  }

  return (
    <CanvasMoodContext.Provider value={talkingHead.leftPanelCanvas ?? "light"}>
      <AbsoluteFill style={{ opacity: sceneOpacity }}>
        <TalkingHeadLayout
          config={talkingHead}
          presenterChildren={presenterChildren}
          leftChildren={leftChildren}
          captionsChildren={captionsChildren}
        />

        {voiceoverEnabled && !presenterAudioEmbedded && (
          <Audio src={staticFile(`projects/${projectId}/voiceover/${scene.id}.mp3`)} volume={1} />
        )}
      </AbsoluteFill>
    </CanvasMoodContext.Provider>
  );
};

export const TalkingHeadPanel: React.FC<{ scene: Scene }> = ({ scene }) => {
  return scene.leftPanel != null ? (
    <LeftPanelRouter panel={scene.leftPanel} />
  ) : (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#F8F8F8",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 48,
        boxSizing: "border-box",
      }}
    >
      <p
        style={{
          fontFamily: primaryFont,
          fontSize: 52,
          fontWeight: 800,
          lineHeight: 1.1,
          color: "#111",
          textAlign: "center",
          margin: 0,
        }}
      >
        {scene.headline ?? scene.text}
      </p>
      {scene.subtext && (
        <p
          style={{
            fontFamily: primaryFont,
            fontSize: 26,
            fontWeight: 400,
            color: "#555",
            textAlign: "center",
            marginTop: 24,
            marginBottom: 0,
          }}
        >
          {scene.subtext}
        </p>
      )}
    </div>
  );
};
