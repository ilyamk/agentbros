import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { cyrillicCondensedFont, cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { FittedLine, MaskedLine } from "../text";
import { formatOf, linesFor, type LineSet } from "../text-split";
import { progress, track } from "../timing";
import { ink, paper, signal } from "./palette";

const LINES: LineSet = {
  vertical: ["КАЖДЫЙ КАДР —", "ФУНКЦИЯ", "СВОЕГО", "НОМЕРА"],
  landscape: ["КАЖДЫЙ КАДР — ФУНКЦИЯ", "СВОЕГО НОМЕРА"],
  fallback: ["КАЖДЫЙ КАДР —", "ФУНКЦИЯ", "СВОЕГО НОМЕРА"],
};

const LINE_HEIGHT = 0.84;
const WEIGHT = 800;
const TRACKING = "-0.005em";

/** Masked reveal plus fit-to-width: every line is justified to the column by size alone, with breaks set per format. */
export const PosterStack: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const format = formatOf(width, height);
  const vertical = format === "vertical";
  const side = vertical ? 60 : 72;
  const column = width - side * 2;
  const rule = track(frame, [
    { at: 18, value: 0 },
    { at: 48, value: 1, curve: "expoOut" },
  ]);
  const counterIn = progress(frame, 22, 18);
  return (
    <AbsoluteFill style={{ backgroundColor: ink, color: paper }}>
      <div
        style={{
          position: "absolute",
          left: side,
          top: vertical ? 200 : 70,
          display: "flex",
          flexDirection: "column",
          gap: vertical ? 22 : 14,
        }}
      >
        {linesFor(LINES, format).map((line, i) => (
          <FittedLine
            key={line}
            text={line}
            withinWidth={column}
            fontFamily={cyrillicCondensedFont}
            fontWeight={WEIGHT}
            letterSpacing={TRACKING}
          >
            {(fontSize) => (
              <MaskedLine
                reveal={progress(frame, 2 + i * 5, 22)}
                lineHeight={LINE_HEIGHT}
                style={{ fontFamily: cyrillicCondensedFont, fontWeight: WEIGHT, letterSpacing: TRACKING, fontSize }}
              >
                {line}
              </MaskedLine>
            )}
          </FittedLine>
        ))}
      </div>
      <div style={{ position: "absolute", left: side, right: side, bottom: vertical ? 300 : 60 }}>
        <div
          style={{
            height: 3,
            backgroundColor: signal,
            transform: `scaleX(${rule})`,
            transformOrigin: "left",
            marginBottom: vertical ? 14 : 8,
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", opacity: counterIn }}>
          <div
            style={{
              fontFamily: cyrillicCondensedFont,
              fontWeight: 300,
              fontSize: vertical ? 280 : 400,
              lineHeight: 0.8,
              color: signal,
              fontVariantNumeric: "tabular-nums",
              letterSpacing: "-0.07em",
              marginLeft: "-0.03em",
            }}
          >
            {String(Math.floor(frame)).padStart(3, "0")}
          </div>
          <div
            style={{
              fontFamily: cyrillicGroteskFont,
              fontSize: vertical ? 34 : 34,
              lineHeight: 1.25,
              fontWeight: 500,
              textAlign: "right",
              paddingBottom: 10,
            }}
          >
            Один и тот же
            <br />
            при любом рендере
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
