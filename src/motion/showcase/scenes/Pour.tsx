import { Video } from "@remotion/media";
import React from "react";
import { AbsoluteFill, staticFile, useCurrentFrame } from "remotion";
import { cyrillicCondensedFont } from "../../../lib/fonts-cyrillic";
import { FittedLine, MaskedLine } from "../../text";
import { progress } from "../../timing";
import { label } from "../palette";

const COLUMN = 500;
const LINES = ["12 КГ.", "ВСЕ", "УЖЕ", "ЧЬИ-ТО."];
const STARTS = [10, 46, 50, 54];

/** The Blender pour, slowed to 0.7. The rate stays above 0.5 so doubled frames do not show. */
export const Pour: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Video
        src={staticFile("motion-lab/showcase/coffee-pour.mp4")}
        muted
        playbackRate={0.7}
        style={{ width: "100%", height: "100%" }}
      />
      <AbsoluteFill
        style={{ background: "linear-gradient(90deg, rgba(10,6,3,0.72) 0%, rgba(10,6,3,0.5) 22%, rgba(10,6,3,0) 36%)" }}
      />
      <div style={{ position: "absolute", left: 64, top: 60, display: "flex", flexDirection: "column", gap: 14 }}>
        {LINES.map((line, i) =>
          frame < STARTS[i]! ? null : (
            <FittedLine
              key={line}
              text={line}
              withinWidth={COLUMN}
              fontFamily={cyrillicCondensedFont}
              fontWeight={800}
              maxFontSize={i === 0 ? 300 : 250}
            >
              {(fontSize) => (
                <MaskedLine
                  reveal={progress(frame, STARTS[i]!, 16)}
                  lineHeight={0.84}
                  style={{ fontFamily: cyrillicCondensedFont, fontWeight: 800, fontSize, color: label }}
                >
                  {line}
                </MaskedLine>
              )}
            </FittedLine>
          ),
        )}
      </div>
    </AbsoluteFill>
  );
};
