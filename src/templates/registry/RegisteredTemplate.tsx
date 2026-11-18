import { VizScene } from "../../motion/viz/VizScene";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { TemplateInstanceSchema, type TemplateInstance } from "../../types/templates";
import { typography, spacing, animation } from "../../lib/design-tokens";
import { captionState } from "../../lib/templates/caption-state";
import { primaryFont } from "../../lib/fonts";
import { WordByWord } from "../text/WordByWord";
import { LineByLine } from "../text/LineByLine";
import { ScaleWord } from "../text/ScaleWord";
import { ClipReveal } from "../text/ClipReveal";
import { CountUp } from "../text/CountUp";
import { KaraokeCaptions } from "../talkinghead/KaraokeCaptions";
import { PhraseCaption } from "./PhraseCaption";
import { TitleScene } from "../../components/TitleScene";
import { StockPhotoScene } from "../../components/StockPhotoScene";
import { PhoneShowcaseScene } from "../../components/PhoneShowcaseScene";
import { AnimatedLineChart } from "../leftpanel/AnimatedLineChart";
import { CanvasMoodContext } from "../leftpanel/_canvas";
import { StylePackScene } from "./StylePackScene";
import { BilingualCaption } from "./BilingualCaption";
export type RegisteredTemplateProps = {
  instance: TemplateInstance;
  accentColor: string;
  bgColor: string;
  textColor: string;
  durationInFrames: number;
  transparentBackground?: boolean;
};
export const RegisteredTemplate: React.FC<RegisteredTemplateProps> = ({
  instance: input,
  accentColor,
  bgColor,
  textColor,
  durationInFrames,
  transparentBackground = false,
}) => {
  const instance = TemplateInstanceSchema.parse(input),
    frame = useCurrentFrame(),
    { width, height, fps } = useVideoConfig();
  const fmt = height > width ? "vertical" : height < width ? "landscape" : "square";
  const caption = instance.id.startsWith("caption.");
  const exit = interpolate(frame, [Math.max(0, durationInFrames - 9), durationInFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const style = {
    ...typography.bigTitle[fmt],
    fontFamily: primaryFont,
    color: textColor,
  };
  let content: React.ReactNode;
  switch (instance.id) {
    case "scene.visualisation":
      return <VizScene {...instance.props} />;
    case "scene.worked-example":
    case "scene.product-walkthrough":
    case "scene.editorial-evidence":
      content = <StylePackScene instance={instance} accentColor={accentColor} />;
      break;
    case "caption.bilingual":
      content = <BilingualCaption props={instance.props} backgroundColor={bgColor} textColor={textColor} />;
      break;
    case "scene.hook":
      content = <TitleScene {...instance.props} accentColor={accentColor} bgColor={bgColor} textColor={textColor} />;
      break;
    case "scene.image-proof":
      content = <StockPhotoScene {...instance.props} accentColor={accentColor} textColor={textColor} />;
      break;
    case "scene.device-proof":
      content = (
        <PhoneShowcaseScene {...instance.props} accentColor={accentColor} bgColor={bgColor} textColor={textColor} />
      );
      break;
    case "scene.chart-proof":
      content = (
        <CanvasMoodContext.Provider value={bgColor === "#0A0A0F" ? "dark" : "light"}>
          <AnimatedLineChart {...instance.props} kind="chart" entrance="fade" chartType="line" color={accentColor} />
        </CanvasMoodContext.Provider>
      );
      break;
    case "scene.metric":
      content = (
        <div>
          <div style={style}>{instance.props.headline}</div>
          <CountUp
            to={instance.props.to}
            suffix={instance.props.suffix}
            style={{ ...typography.hero[fmt], color: accentColor }}
          />
        </div>
      );
      break;
    case "scene.definition":
      content = (
        <LineByLine
          {...instance.props}
          entrance="fade"
          springConfig={animation.smooth}
          accentColor={accentColor}
          style={style}
          fadeDurationFrames={12}
        />
      );
      break;
    case "text.word-reveal":
      content = (
        <WordByWord
          {...instance.props}
          entrance="fade"
          springConfig={animation.smooth}
          accentColor={accentColor}
          style={style}
          fadeDurationFrames={12}
        />
      );
      break;
    case "text.line-reveal":
      content = (
        <LineByLine
          {...instance.props}
          entrance="fade"
          springConfig={animation.smooth}
          accentColor={accentColor}
          style={style}
          fadeDurationFrames={12}
        />
      );
      break;
    case "text.scale-emphasis":
      content = <ScaleWord {...instance.props} scaleFrom={0.85} style={style} />;
      break;
    case "text.clip-reveal":
      content = <ClipReveal {...instance.props} springConfig={animation.smooth} style={style} />;
      break;
    case "text.count-up":
      content = (
        <CountUp
          {...instance.props}
          style={{
            ...typography.hero[fmt],
            fontFamily: primaryFont,
            color: accentColor,
          }}
        />
      );
      break;
    case "caption.karaoke": {
      const state = captionState(instance.props.words, frame, fps, instance.props.maxWords);
      content = state.visible ? (
        <KaraokeCaptions
          words={instance.props.words}
          fontFamily={primaryFont}
          style={{
            fontSize: typography.feature[fmt].fontSize,
            wordsInView: instance.props.maxWords,
            activeColor: state.activeIndex < 0 ? "#FFFFFF" : instance.props.activeColor,
          }}
        />
      ) : null;
      break;
    }
    case "caption.phrase":
      content = <PhraseCaption props={instance.props} />;
      break;
    case "caption.keyword":
      content = <PhraseCaption props={instance.props} keyword />;
      break;
  }
  const fullScene = ["scene.hook", "scene.image-proof", "scene.device-proof", "scene.chart-proof"].includes(
    instance.id,
  );
  return (
    <AbsoluteFill
      style={{
        opacity: exit,
        backgroundColor: caption || transparentBackground ? undefined : bgColor,
        paddingTop: caption || fullScene ? 0 : spacing.safeTop[fmt],
        paddingBottom: caption || fullScene ? 0 : spacing.safeBottom[fmt],
        paddingLeft: fullScene ? 0 : spacing.sidePadding[fmt],
        paddingRight: fullScene ? 0 : spacing.sidePadding[fmt],
        justifyContent: caption ? "flex-end" : "center",
        alignItems: "center",
        color: textColor,
        ...(caption ? { paddingBottom: spacing.safeBottom[fmt] } : {}),
      }}
    >
      {content}
    </AbsoluteFill>
  );
};
