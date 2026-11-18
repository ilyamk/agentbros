import React from "react";
import { useVideoConfig } from "remotion";
import { Video } from "@remotion/media";

export type TalkingHeadVideoProps = {
  /** staticFile() path of the presenter video */
  src: string;
  /** Start offset within the source video (seconds, default 0) */
  startSec?: number;
  /** End offset within the source video (seconds). Omit to play to end of composition. */
  endSec?: number;
  /** Corner radius (px, default 0 — parent panel already clips) */
  borderRadius?: number;
  /** Mute the video track (default true — audio from separate Audio component) */
  muted?: boolean;
  /**
   * objectPosition CSS value for the cover crop.
   *
   * Defaults to a face-aware bias when the parent canvas is vertical /
   * square (`"50% 30%"` — pushes the crop window upward so the head and
   * hairline survive when 9:16 source is squeezed into a 1:1 frame).
   * Landscape compositions pass the source through with full aspect, so
   * the default there is centred.
   *
   * Override with a string like `"center 40%"` or `"50% 25%"` if your
   * presenter video frames the face differently.
   */
  objectPosition?: string;
};

export const TalkingHeadVideo: React.FC<TalkingHeadVideoProps> = ({
  src,
  startSec = 0,
  endSec,
  borderRadius = 0,
  muted = true,
  objectPosition,
}) => {
  const { fps, width, height } = useVideoConfig();

  const trimBefore = Math.round(startSec * fps);
  const trimAfter = endSec !== undefined ? Math.round(endSec * fps) : undefined;

  // Vertical / square compositions crop a 9:16 source into a 1:1 (or near-1:1)
  // panel. Default `center center` cover-crop trims the upper hairline because
  // Seedance / recorded presenter video typically frames the face in the
  // upper-third of the source. Bias upward so the head survives.
  const isCropContext = height >= width;
  const resolvedObjectPosition = objectPosition ?? (isCropContext ? "50% 30%" : "50% 50%");

  return (
    <Video
      objectFit="cover"
      src={src}
      trimBefore={trimBefore}
      {...(trimAfter !== undefined ? { trimAfter } : {})}
      muted={muted}
      style={{
        width: "100%",
        height: "100%",
        objectPosition: resolvedObjectPosition,
        borderRadius,
      }}
    />
  );
};
