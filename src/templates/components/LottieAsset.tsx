import React, { useEffect, useState } from "react";
import { Lottie, LottieAnimationData } from "@remotion/lottie";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";

type LottieAssetProps = {
  /** Path relative to public/ (e.g. "lottie/confetti.json") or a remote URL */
  src: string;
  /** Whether src is a local staticFile path */
  local?: boolean;
  style?: React.CSSProperties;
  playbackRate?: number;
  loop?: boolean;
};

/** Wrapper for loading and displaying Lottie animations in Remotion */
export const LottieAsset: React.FC<LottieAssetProps> = ({ src, local = true, style, playbackRate, loop }) => {
  const [handle] = useState(() => delayRender("Loading Lottie animation"));
  const [animationData, setAnimationData] = useState<LottieAnimationData | null>(null);

  useEffect(() => {
    const url = local ? staticFile(src) : src;
    fetch(url)
      .then((res) => res.json())
      .then((json) => {
        setAnimationData(json);
        continueRender(handle);
      })
      .catch((err) => {
        cancelRender(err);
      });
  }, [handle, src, local]);

  if (!animationData) {
    return null;
  }

  return <Lottie animationData={animationData} style={style} playbackRate={playbackRate} loop={loop} />;
};
