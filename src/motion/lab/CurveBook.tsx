import { evolvePath } from "@remotion/paths";
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { cyrillicGroteskFont } from "../../lib/fonts-cyrillic";
import { curves, progress, type CurveName } from "../timing";
import { ink, paper, signal } from "./palette";

const PLATES: { curve: CurveName; ru: string; note: string }[] = [
  { curve: "expoOut", ru: "Быстро приходит, долго оседает", note: "заголовки, уверенный вход" },
  { curve: "inOut", ru: "Разгон и резкое торможение", note: "хлыст, короткое движение камеры" },
  { curve: "overshoot", ru: "Проскакивает цель и возвращается", note: "предмет с весом" },
  { curve: "anticipation", ru: "Замах назад перед рывком", note: "уход со сцены" },
];

const WIDTH = 396;
const HEIGHT = 350;
const BLOCK = 84;
const MOVE = 40;
const START = 16;

const curvePath = (name: CurveName) =>
  Array.from(
    { length: 61 },
    (_, i) => `${i === 0 ? "M" : "L"} ${(i / 60) * WIDTH} ${HEIGHT - curves[name](i / 60) * HEIGHT}`,
  ).join(" ");

/** Four curves as a printed specimen: each graph draws while its block moves on exactly that curve. */
export const CurveBook: React.FC = () => {
  const frame = useCurrentFrame();
  const t = Math.min(Math.max((frame - START) / MOVE, 0), 1);
  return (
    <AbsoluteFill style={{ backgroundColor: paper, color: ink, fontFamily: cyrillicGroteskFont, padding: "76px 72px" }}>
      <div style={{ fontWeight: 600, fontSize: 112, letterSpacing: "-0.035em", lineHeight: 1 }}>
        Кривая — это характер.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", columnGap: 64, marginTop: 76 }}>
        {PLATES.map(({ curve, ru, note }) => {
          const line = evolvePath(t, curvePath(curve));
          return (
            <div key={curve}>
              <svg
                width={WIDTH}
                height={HEIGHT}
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                style={{ overflow: "visible", display: "block" }}
              >
                <line
                  x1={0}
                  y1={0}
                  x2={WIDTH}
                  y2={0}
                  stroke={ink}
                  strokeOpacity={0.28}
                  strokeWidth={2}
                  strokeDasharray="4 8"
                />
                <path
                  d={curvePath(curve)}
                  fill="none"
                  stroke={ink}
                  strokeWidth={6}
                  strokeLinecap="round"
                  strokeDasharray={line.strokeDasharray}
                  strokeDashoffset={line.strokeDashoffset}
                />
              </svg>
              <div style={{ position: "relative", height: BLOCK, marginTop: 56, borderBottom: `3px solid ${ink}` }}>
                <div
                  style={{
                    position: "absolute",
                    left: progress(frame, START, MOVE, curve) * (WIDTH - BLOCK),
                    bottom: 0,
                    width: BLOCK,
                    height: BLOCK,
                    backgroundColor: signal,
                  }}
                />
              </div>
              <div style={{ fontWeight: 600, fontSize: 36, lineHeight: 1.14, marginTop: 30 }}>{ru}</div>
              <div style={{ fontWeight: 400, fontSize: 26, lineHeight: 1.25, marginTop: 12 }}>{note}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
