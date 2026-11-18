import React from "react";
import { AbsoluteFill, Sequence, staticFile, useVideoConfig } from "remotion";
import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { TemplateInstanceSchema } from "../types/templates";
import { RegisteredTemplate } from "../templates/registry/RegisteredTemplate";
import { compileTimeline } from "../lib/timeline";
import type { VideoProps, Scene } from "../types/video";
import { TitleScene } from "./TitleScene";
import { FeatureScene } from "./FeatureScene";
import { ProductScene } from "./ProductScene";
import { CTAScene } from "./CTAScene";
import { PhoneShowcaseScene } from "./PhoneShowcaseScene";
import { StockVideoScene } from "./StockVideoScene";
import { StockPhotoScene } from "./StockPhotoScene";
import { Particles } from "../templates/effects/Particles";
import { NoiseGrain } from "../templates/overlays/NoiseGrain";

export const LegacySceneRenderer: React.FC<{
  scene: Scene;
  accentColor: string;
  bgColor: string;
  textColor: string;
  captionReservePx?: number;
}> = ({ scene, accentColor, bgColor, textColor, captionReservePx }) => {
  const props = {
    headline: scene.headline ?? "",
    subtext: scene.subtext,
    accentColor,
    bgColor,
    textColor,
  };

  switch (scene.visualType) {
    case "title":
      return <TitleScene {...props} />;
    case "feature":
    case "testimonial":
      return <FeatureScene {...props} />;
    case "product":
      return <ProductScene {...props} />;
    case "showcase":
      return <PhoneShowcaseScene {...props} imageUrl={scene.imageUrl ?? ""} />;
    case "video":
      return (
        <StockVideoScene
          headline={props.headline}
          subtext={props.subtext}
          accentColor={props.accentColor}
          textColor={props.textColor}
          captionReservePx={captionReservePx}
          videoUrl={scene.imageUrl ?? ""}
        />
      );
    case "photo":
      return (
        <StockPhotoScene
          headline={props.headline}
          subtext={props.subtext}
          accentColor={props.accentColor}
          textColor={props.textColor}
          captionReservePx={captionReservePx}
          imageUrl={scene.imageUrl ?? ""}
        />
      );
    case "cta":
      return <CTAScene {...props} />;
    default:
      return <TitleScene {...props} />;
  }
};

export const SceneRenderer: React.FC<
  React.ComponentProps<typeof LegacySceneRenderer> & {
    captionsEnabled?: boolean;
  }
> = (props) => {
  const original = props.scene.template;
  const instance =
    original && props.scene.imageUrl && "imageUrl" in original.props
      ? TemplateInstanceSchema.parse({
          ...original,
          props: { ...original.props, imageUrl: props.scene.imageUrl },
        })
      : original;
  if (!instance) return <LegacySceneRenderer {...props} />;
  const caption = instance.id.startsWith("caption.");
  if (caption && props.captionsEnabled === false) return <LegacySceneRenderer {...props} />;
  const hasBackdrop =
    !!props.scene.imageUrl &&
    ["photo", "video", "showcase"].includes(props.scene.visualType) &&
    ![
      "scene.image-proof",
      "scene.device-proof",
      "scene.product-walkthrough",
      "scene.worked-example",
      "scene.editorial-evidence",
    ].includes(instance.id);
  const template = (
    <RegisteredTemplate
      instance={instance}
      accentColor={props.accentColor}
      bgColor={props.bgColor}
      textColor={props.textColor}
      durationInFrames={props.scene.durationInFrames ?? 120}
      transparentBackground={hasBackdrop}
    />
  );
  return caption || hasBackdrop ? (
    <>
      <LegacySceneRenderer
        {...props}
        scene={caption ? props.scene : { ...props.scene, headline: "", subtext: undefined }}
      />
      {template}
    </>
  ) : (
    template
  );
};

export const PromoVideo: React.FC<VideoProps & { captionsEnabled?: boolean }> = ({
  scenes,
  accentColor,
  bgColor,
  textColor,
  voiceoverEnabled,
  musicVolume,
  projectId,
  captionsEnabled = true,
}) => {
  const { fps } = useVideoConfig();
  const timeline = compileTimeline(scenes, { fps });

  return (
    <AbsoluteFill style={{ backgroundColor: bgColor }}>
      {/* Scene transitions — fade only (no slides) */}
      <TransitionSeries>
        {timeline.entries.map(({ scene, durationInFrames: sceneDuration }, index) => {
          const transitionFrames = index > 0 ? timeline.entries[index - 1].transitionFrames : 0;
          const elements: React.ReactNode[] = [];

          // Fade transition before each scene (except first)
          if (transitionFrames > 0) {
            elements.push(
              <TransitionSeries.Transition
                key={`transition-${scene.id}`}
                presentation={fade()}
                timing={linearTiming({ durationInFrames: transitionFrames })}
              />,
            );
          }

          elements.push(
            <TransitionSeries.Sequence key={scene.id} durationInFrames={sceneDuration}>
              <SceneRenderer
                scene={scene}
                accentColor={accentColor}
                bgColor={bgColor}
                textColor={textColor}
                captionsEnabled={captionsEnabled}
              />
            </TransitionSeries.Sequence>,
          );

          return elements;
        })}
      </TransitionSeries>

      {/* Subtle overlays — light touch since scenes have bright backgrounds */}
      <Particles count={15} color={accentColor} speed={0.3} maxSize={3} />
      <NoiseGrain opacity={0.02} />

      {/* Voiceover audio layers */}
      {voiceoverEnabled &&
        timeline.entries.map(({ scene, startFrame, durationInFrames, transitionFrames }) => {
          const voiceoverPath = `projects/${projectId}/voiceover/${scene.id}.mp3`;

          return (
            <Sequence
              key={`vo-${scene.id}`}
              from={startFrame}
              layout="none"
              durationInFrames={durationInFrames - transitionFrames}
            >
              <Audio src={staticFile(voiceoverPath)} volume={1} />
            </Sequence>
          );
        })}

      {/* Background music */}
      {musicVolume > 0 && <Audio src={staticFile(`projects/${projectId}/music/bg.mp3`)} volume={musicVolume} loop />}
    </AbsoluteFill>
  );
};
