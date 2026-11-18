import { evolvePath } from "@remotion/paths";
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { MaskedLines } from "../text";
import { formatOf, linesFor, type LineSet } from "../text-split";
import { progress } from "../timing";
import { graphite, ink, paper, signal } from "./palette";

const LINES: LineSet = {
  vertical: ["Ещё одна", "заставка", "с градиентом", "— и зритель", "уходит."],
  landscape: ["Ещё одна заставка", "с градиентом —", "и зритель уходит."],
  fallback: ["Ещё одна заставка", "с градиентом —", "и зритель уходит."],
};

const UNDERLINE = "M4 16 C 120 4, 260 22, 420 11 S 640 6, 716 14";

/** Lowercase with descenders at a tight line-height: the hard test for a mask. Lines land first, the emphasis draws after. */
export const EditorialMask: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const format = formatOf(width, height);
  const vertical = format === "vertical";
  const fontSize = vertical ? 148 : 192;
  const lines = linesFor(LINES, format);
  const lineHeight = 0.98;
  const stroke = evolvePath(progress(frame, 34, 20, "inOut"), UNDERLINE);
  const translation = progress(frame, 40, 16);
  return (
    <AbsoluteFill style={{ backgroundColor: paper, color: ink, padding: vertical ? "200px 60px 300px" : "96px 104px" }}>
      <MaskedLines
        lines={lines}
        lineHeight={lineHeight}
        from={2}
        duration={24}
        step={6}
        style={{ fontFamily: cyrillicGroteskFont, fontWeight: 600, fontSize, letterSpacing: "-0.035em" }}
      />
      <svg
        width={fontSize * 4.2}
        height={fontSize * 0.2}
        viewBox="0 0 720 28"
        style={{ position: "relative", marginTop: fontSize * -0.04, marginLeft: vertical ? 0 : fontSize * 3.75 }}
      >
        <path
          d={UNDERLINE}
          fill="none"
          stroke={signal}
          strokeWidth={7}
          strokeLinecap="round"
          strokeDasharray={stroke.strokeDasharray}
          strokeDashoffset={stroke.strokeDashoffset}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          left: vertical ? 60 : 104,
          bottom: vertical ? 300 : 80,
          fontFamily: cyrillicGroteskFont,
          fontSize: 34,
          lineHeight: 1.3,
          color: graphite,
          opacity: translation,
        }}
      >
        One more gradient title, and the viewer is gone.
      </div>
    </AbsoluteFill>
  );
};
