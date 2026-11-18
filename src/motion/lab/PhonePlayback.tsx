import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { MaskedLines } from "../text";
import { progress } from "../timing";
import { DeviceFrame, ScreenPlayback } from "../ui";
import { ink, paper } from "./palette";

const PHONE_WIDTH = 760;

/** The vertical render of this very lab, playing on a phone that runs off the bottom of the frame. */
export const PhonePlayback: React.FC = () => {
  const frame = useCurrentFrame();
  const rise = 1 - progress(frame, 0, 26);
  const float = Math.sin(frame / 22) * 7;
  return (
    <AbsoluteFill style={{ backgroundColor: paper, color: ink }}>
      <MaskedLines
        lines={["Тот же код.", "Другой экран."]}
        from={2}
        duration={22}
        step={5}
        lineHeight={1.02}
        style={{
          position: "absolute",
          left: 60,
          top: 200,
          fontFamily: cyrillicGroteskFont,
          fontWeight: 600,
          fontSize: 124,
          letterSpacing: "-0.035em",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: (1080 - PHONE_WIDTH) / 2,
          top: 560,
          transform: `translateY(${rise * 900 + float}px)`,
        }}
      >
        <DeviceFrame width={PHONE_WIDTH}>
          <ScreenPlayback kind="video" src="motion-lab/poster-vertical.mp4" />
        </DeviceFrame>
      </div>
    </AbsoluteFill>
  );
};
